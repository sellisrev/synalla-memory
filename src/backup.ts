// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// Encrypted, incremental backups of the memory store to a place the owner picks (pilot plan W1, W2).
//
// A snapshot is the store file itself, which is already encrypted page by page with the store key (SQLCipher), cut
// into 1 MiB pieces named by their SHA-256. Pages that did not change keep their bytes, so a daily snapshot uploads
// only the pieces that changed. Each snapshot has a manifest (sequence number, date, piece list, sizes, and the store
// key) sealed with AES-256-GCM under a key derived from the backup key B. So:
//   - B alone restores everything (guardians' shares or the recovery code rebuild B; the store key comes back from the
//     manifest);
//   - the provider sees only random-looking pieces and sealed manifests, and cannot swap or drop a piece unnoticed:
//     every piece is checked against the manifest's hash on restore;
//   - changing B re-seals the manifests only; nothing is uploaded again.
// Kept: the newest snapshot of each of the last 7 days that have one, and of each of the 4 ISO weeks before those.

import { createHash, createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { closeSync, openSync, readSync, rmSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PIECE = 1024 * 1024;
const MAGIC = Buffer.from('SMB1');
const AAD = Buffer.from('synalla-memory manifest v1');
const PREFIX = 'synalla-memory/';

/** Where backups go. Names use '/' and never start with it. */
export interface Target {
  list(prefix: string): Promise<string[]>;
  get(name: string): Promise<Uint8Array | null>;
  put(name: string, data: Uint8Array): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface Manifest {
  v: 1; seq: number; createdAt: string; size: number; pieces: string[]; storeKey: string; dim: number;
}

function manifestKey(b: Uint8Array): Buffer {
  if (!(b instanceof Uint8Array) || b.length !== 32) throw new TypeError('backup key must be 32 bytes');
  return Buffer.from(hkdfSync('sha256', b, Buffer.alloc(0), 'synalla-memory backup manifest v1', 32));
}

export function sealManifest(m: Manifest, b: Uint8Array): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', manifestKey(b), nonce);
  c.setAAD(AAD);
  const body = Buffer.concat([c.update(JSON.stringify(m), 'utf8'), c.final()]);
  return Buffer.concat([MAGIC, nonce, body, c.getAuthTag()]);
}

export function openManifest(data: Uint8Array, b: Uint8Array): Manifest {
  const buf = Buffer.from(data);
  if (buf.length < 4 + 12 + 16 || !buf.subarray(0, 4).equals(MAGIC)) throw new Error('not a Synalla memory manifest');
  const d = createDecipheriv('aes-256-gcm', manifestKey(b), buf.subarray(4, 16));
  d.setAAD(AAD);
  d.setAuthTag(buf.subarray(buf.length - 16));
  let text: string;
  try { text = Buffer.concat([d.update(buf.subarray(16, buf.length - 16)), d.final()]).toString('utf8'); } catch {
    throw new Error('manifest does not open with this backup key (wrong key, or changed by someone)');
  }
  const m = JSON.parse(text) as Manifest;
  if (m.v !== 1 || !Number.isSafeInteger(m.seq) || !Array.isArray(m.pieces)) throw new Error('unknown manifest format');
  return m;
}

const sha = (d: Uint8Array) => createHash('sha256').update(d).digest('hex');
const manifestName = (m: Pick<Manifest, 'seq' | 'createdAt'>) => `${PREFIX}snapshots/${String(m.seq).padStart(10, '0')}-${m.createdAt.replace(/[:.]/g, '')}.manifest`;

async function manifests(target: Target, b: Uint8Array): Promise<{ name: string; m: Manifest | null; error?: string }[]> {
  const names = (await target.list(`${PREFIX}snapshots/`)).filter(n => n.endsWith('.manifest')).sort();
  const out: { name: string; m: Manifest | null; error?: string }[] = [];
  for (const name of names) {
    const data = await target.get(name);
    if (!data) { out.push({ name, m: null, error: 'missing' }); continue; }
    try { out.push({ name, m: openManifest(data, b) }); } catch (e) { out.push({ name, m: null, error: (e as Error).message }); }
  }
  return out;
}

export interface SnapshotResult { name: string; seq: number; pieces: number; uploaded: number; bytesUploaded: number; pruned: string[] }

/**
 * Take a snapshot of `store` and write it to `target`. `storeKey` is the key the store was opened with (it is sealed
 * into the manifest), `b` the backup key.
 */
export async function backup(
  store: { snapshotTo(dest: string): void; dim: number },
  storeKey: Uint8Array, b: Uint8Array, target: Target, now: Date = new Date(),
): Promise<SnapshotResult> {
  if (!(storeKey instanceof Uint8Array) || storeKey.length !== 32) throw new TypeError('store key must be 32 bytes');
  manifestKey(b);
  const existing = await manifests(target, b);
  const seq = Math.max(0, ...existing.map(e => e.m?.seq ?? 0)) + 1;
  const have = new Set(await target.list(`${PREFIX}pieces/`));
  const dir = mkdtempSync(join(tmpdir(), 'synalla-snap-'));
  const file = join(dir, 'store.db');
  try {
    store.snapshotTo(file);
    const size = statSync(file).size;
    const pieces: string[] = [];
    let uploaded = 0, bytesUploaded = 0;
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(PIECE);
      for (let off = 0; off < size; off += PIECE) {
        const n = readSync(fd, buf, 0, PIECE, off);
        const piece = buf.subarray(0, n);
        const h = sha(piece);
        pieces.push(h);
        const name = `${PREFIX}pieces/${h}`;
        if (!have.has(name)) { await target.put(name, Buffer.from(piece)); have.add(name); uploaded++; bytesUploaded += n; }
      }
    } finally { closeSync(fd); }
    const m: Manifest = { v: 1, seq, createdAt: now.toISOString(), size, pieces, storeKey: Buffer.from(storeKey).toString('hex'), dim: store.dim };
    const name = manifestName(m);
    await target.put(name, sealManifest(m, b));
    const pruned = await prune(target, b, now);
    return { name, seq, pieces: pieces.length, uploaded, bytesUploaded, pruned };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}

/** Which manifests the retention rule keeps: newest per day for the last 7 days with snapshots, then newest per week for 4 weeks. */
export function retained(ms: readonly Pick<Manifest, 'seq' | 'createdAt'>[]): Set<number> {
  const sorted = [...ms].sort((a, b) => b.seq - a.seq);
  const keep = new Set<number>();
  const days = new Set<string>(), weeks = new Set<string>();
  for (const m of sorted) {
    const day = m.createdAt.slice(0, 10);
    if (days.size < 7 && !days.has(day)) { days.add(day); keep.add(m.seq); continue; }
    if (days.has(day)) continue;
    const wk = isoWeek(new Date(m.createdAt));
    if (weeks.size < 4 && !weeks.has(wk) && ![...days].some(d => isoWeek(new Date(d)) === wk)) { weeks.add(wk); keep.add(m.seq); }
  }
  if (sorted[0]) keep.add(sorted[0].seq);
  return keep;
}

/**
 * Apply the retention rule, then delete pieces no kept manifest uses. If any manifest cannot be opened with `b`,
 * nothing is deleted (it may belong to a key not yet rotated, or show tampering) and the caller is told.
 */
export async function prune(target: Target, b: Uint8Array, _now: Date = new Date()): Promise<string[]> {
  const all = await manifests(target, b);
  const bad = all.filter(e => !e.m);
  if (bad.length > 0) throw new Error(`backup not pruned: ${bad.length} manifest(s) do not open (${bad.map(e => e.error).join('; ')})`);
  const keep = retained(all.map(e => e.m as Manifest));
  const deleted: string[] = [];
  for (const e of all) if (!keep.has((e.m as Manifest).seq)) { await target.delete(e.name); deleted.push(e.name); }
  const used = new Set(all.filter(e => keep.has((e.m as Manifest).seq)).flatMap(e => (e.m as Manifest).pieces.map(p => `${PREFIX}pieces/${p}`)));
  for (const p of await target.list(`${PREFIX}pieces/`)) if (!used.has(p)) { await target.delete(p); deleted.push(p); }
  return deleted;
}

export interface SnapshotInfo { name: string; seq: number; createdAt: string; size: number }

/** Snapshots that open with `b`, newest first. */
export async function listSnapshots(target: Target, b: Uint8Array): Promise<SnapshotInfo[]> {
  return (await manifests(target, b)).filter(e => e.m).map(e => {
    const m = e.m as Manifest;
    return { name: e.name, seq: m.seq, createdAt: m.createdAt, size: m.size };
  }).sort((a, b2) => b2.seq - a.seq);
}

/**
 * Restore the newest snapshot (or the newest created before `before`, for a restore after a thief may have written
 * newer ones) into the file `dest`. Every piece is checked against the manifest. Returns the store key and size, for
 * MemoryStore.open(dest, { key, dim }).
 */
export async function restore(target: Target, b: Uint8Array, dest: string, opts: { before?: Date } = {}):
  Promise<{ key: Uint8Array; dim: number; seq: number; createdAt: string }> {
  const ok = (await manifests(target, b)).filter(e => e.m).map(e => e.m as Manifest)
    .filter(m => !opts.before || new Date(m.createdAt) < opts.before).sort((a, c) => c.seq - a.seq);
  const m = ok[0];
  if (!m) throw new Error('no snapshot opens with this backup key');
  const parts: Buffer[] = [];
  for (const h of m.pieces) {
    const d = await target.get(`${PREFIX}pieces/${h}`);
    if (!d) throw new Error(`snapshot ${m.seq} is missing a piece; try an older one with "before"`);
    if (sha(d) !== h) throw new Error(`snapshot ${m.seq} has a piece that was changed; try an older one with "before"`);
    parts.push(Buffer.from(d));
  }
  const data = Buffer.concat(parts);
  if (data.length !== m.size) throw new Error(`snapshot ${m.seq} has the wrong size`);
  writeFileSync(dest, data, { flag: 'wx' });
  return { key: new Uint8Array(Buffer.from(m.storeKey, 'hex')), dim: m.dim, seq: m.seq, createdAt: m.createdAt };
}

/** Re-seal every manifest under a new backup key (after a guardian change or a recovery). Pieces are untouched. */
export async function rotateBackupKey(target: Target, oldB: Uint8Array, newB: Uint8Array): Promise<number> {
  manifestKey(newB);
  const all = await manifests(target, oldB);
  const bad = all.filter(e => !e.m);
  if (bad.length > 0) throw new Error(`not rotated: ${bad.length} manifest(s) do not open with the old key`);
  for (const e of all) await target.put(e.name, sealManifest(e.m as Manifest, newB));
  return all.length;
}

/**
 * A folder target: a sync folder (iCloud Drive, Google Drive, OneDrive, Dropbox, ...) whose own app uploads what is
 * written there, or any local or mounted directory. Writes go to a temporary name first, then are renamed.
 */
export function folderTarget(root: string): Target {
  const fsp = import('node:fs/promises');
  const path = (name: string) => {
    if (name.startsWith('/') || name.split('/').some(p => p === '..' || p === '')) throw new TypeError(`bad name ${name}`);
    return join(root, ...name.split('/'));
  };
  return {
    async list(prefix) {
      const { readdir } = await fsp;
      const dir = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
      const p = path(dir);
      try { return (await readdir(p)).filter(f => !f.endsWith('.tmp')).map(f => `${dir}/${f}`); } catch { return []; }
    },
    async get(name) {
      const { readFile } = await fsp;
      const p = path(name);
      try { return new Uint8Array(await readFile(p)); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },
    async put(name, data) {
      const { mkdir, writeFile, rename } = await fsp;
      const p = path(name);
      await mkdir(join(p, '..'), { recursive: true });
      const tmp = `${p}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, p);
    },
    async delete(name) {
      const { rm } = await fsp;
      await rm(path(name), { force: true });
    },
  };
}
