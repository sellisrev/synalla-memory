// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { MemoryStore } from '../src/store.ts';
import { backup, restore, rotateBackupKey, listSnapshots, retained, prune, folderTarget, sealManifest, PIECE } from '../src/backup.ts';

const DIM = 64;
const k32 = () => new Uint8Array(randomBytes(32));
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'synalla-bk-'));
  const storeKey = k32(), b = k32();
  const store = MemoryStore.open(join(dir, 'memory.db'), { key: storeKey, dim: DIM });
  const target = folderTarget(join(dir, 'cloud'));
  return { dir, storeKey, b, store, target, done: () => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}
function fill(store, n, tag = 'x') {
  for (let i = 0; i < n; i++) {
    const [cid] = store.addItem({ id: `${tag}${i}`, date: '2026-11-01', source: 'notes', chunks: [`note ${tag} ${i} ` + 'lorem ipsum '.repeat(60)] });
    store.setVectors([{ cid, vec: Float32Array.from({ length: DIM }, (_, j) => Math.sin(i + j)) }]);
  }
}
function filesUnder(d) { return readdirSync(d, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => join(e.parentPath, e.name)); }

test('backup then restore with only the backup key gives back the same memory', async () => {
  const t = setup();
  try {
    fill(t.store, 50);
    t.store.addItem({ id: 'secret-note', date: '2026-11-02', source: 'notes', chunks: ['The landlord is Frau Kerschbaumer'] });
    const r = await backup(t.store, t.storeKey, t.b, t.target, new Date('2026-11-24T10:00:00Z'));
    assert.equal(r.seq, 1); assert.equal(r.uploaded, r.pieces);
    const dest = join(t.dir, 'restored.db');
    const got = await restore(t.target, t.b, dest);
    assert.deepEqual(got.key, t.storeKey); assert.equal(got.dim, DIM); assert.equal(got.seq, 1);
    const back = MemoryStore.open(dest, { key: got.key, dim: got.dim });
    assert.equal(back.chunks(back.keywordSearch('landlord'))[0].text, 'The landlord is Frau Kerschbaumer');
    assert.equal(back.stats().vectors, 50);
    back.close();
    await assert.rejects(restore(t.target, t.b, dest), /EEXIST/, 'never overwrites an existing file');
  } finally { t.done(); }
});

test('the provider sees neither the text nor the store key', async () => {
  const t = setup();
  try {
    t.store.addItem({ id: 'a', date: '', source: 'notes', chunks: ['PLAINTEXT_MARKER in the memory'] });
    await backup(t.store, t.storeKey, t.b, t.target);
    for (const f of filesUnder(join(t.dir, 'cloud'))) {
      const bytes = readFileSync(f);
      assert.equal(bytes.includes(Buffer.from('PLAINTEXT_MARKER')), false, f);
      assert.equal(bytes.includes(Buffer.from(Buffer.from(t.storeKey).toString('hex'))), false, f);
      assert.equal(bytes.includes(Buffer.from(t.storeKey)), false, f);
    }
  } finally { t.done(); }
});

test('the next snapshot uploads only what changed', async () => {
  const t = setup();
  try {
    fill(t.store, 4000);
    const first = await backup(t.store, t.storeKey, t.b, t.target, new Date('2026-11-23T10:00:00Z'));
    assert.ok(first.pieces >= 6, `store should span several pieces, got ${first.pieces}`);
    t.store.addItem({ id: 'new', date: '', source: 'notes', chunks: ['one more note'] });
    const second = await backup(t.store, t.storeKey, t.b, t.target, new Date('2026-11-24T10:00:00Z'));
    assert.equal(second.seq, 2);
    assert.ok(second.uploaded < second.pieces, `uploaded ${second.uploaded} of ${second.pieces}`);
    assert.ok(second.bytesUploaded <= 3 * PIECE);
  } finally { t.done(); }
});

test('a changed or missing piece is caught; "before" restores an older snapshot', async () => {
  const t = setup();
  try {
    fill(t.store, 20, 'a');
    await backup(t.store, t.storeKey, t.b, t.target, new Date('2026-11-20T10:00:00Z'));
    fill(t.store, 20, 'b');
    await backup(t.store, t.storeKey, t.b, t.target, new Date('2026-11-22T10:00:00Z'));
    const pieceDir = join(t.dir, 'cloud', 'synalla-memory', 'pieces');
    const newest = (await listSnapshots(t.target, t.b))[0];
    assert.equal(newest.seq, 2);
    // Corrupt every piece only the newest snapshot uses: the newest restore fails, an older one still works.
    const pieces = readdirSync(pieceDir).map(f => ({ f, m: statSync(join(pieceDir, f)).mtimeMs })).sort((x, y) => y.m - x.m);
    const victim = join(pieceDir, pieces[0].f);
    const bytes = readFileSync(victim); bytes[100] ^= 1; writeFileSync(victim, bytes);
    await assert.rejects(restore(t.target, t.b, join(t.dir, 'r1.db')), /changed/);
    const old = await restore(t.target, t.b, join(t.dir, 'r2.db'), { before: new Date('2026-11-21T00:00:00Z') });
    assert.equal(old.seq, 1);
    rmSync(victim);
    await assert.rejects(restore(t.target, t.b, join(t.dir, 'r3.db')), /missing a piece/);
  } finally { t.done(); }
});

test('a wrong backup key opens nothing; rotating the key re-seals without re-uploading', async () => {
  const t = setup();
  try {
    fill(t.store, 10);
    await backup(t.store, t.storeKey, t.b, t.target);
    await assert.rejects(restore(t.target, k32(), join(t.dir, 'x.db')), /no snapshot opens/);
    const piecesBefore = filesUnder(join(t.dir, 'cloud', 'synalla-memory', 'pieces')).length;
    const nb = k32();
    assert.equal(await rotateBackupKey(t.target, t.b, nb), 1);
    await assert.rejects(restore(t.target, t.b, join(t.dir, 'old.db')), /no snapshot opens/);
    assert.equal((await restore(t.target, nb, join(t.dir, 'new.db'))).seq, 1);
    assert.equal(filesUnder(join(t.dir, 'cloud', 'synalla-memory', 'pieces')).length, piecesBefore);
  } finally { t.done(); }
});

test('pruning refuses to delete anything while a manifest does not open', async () => {
  const t = setup();
  try {
    fill(t.store, 5);
    await backup(t.store, t.storeKey, t.b, t.target);
    await t.target.put('synalla-memory/snapshots/9999999999-x.manifest', sealManifest({ v: 1, seq: 9, createdAt: '2026-01-01T00:00:00Z', size: 0, pieces: [], storeKey: '', dim: DIM }, k32()));
    await assert.rejects(prune(t.target, t.b), /not pruned: 1 manifest/);
    await assert.rejects(backup(t.store, t.storeKey, t.b, t.target), /not pruned/);
  } finally { t.done(); }
});

test('retention keeps the newest per day for 7 days, then the newest per week for 4 weeks', () => {
  const ms = [];
  let seq = 0;
  for (let d = 0; d < 60; d++) for (const h of [8, 20]) {
    ms.push({ seq: ++seq, createdAt: new Date(Date.UTC(2026, 8, 1 + d, h)).toISOString() });
  }
  const keep = [...retained(ms)].sort((a, b) => b - a).map(s => ms[s - 1].createdAt.slice(0, 13));
  assert.deepEqual(keep.slice(0, 7), ['2026-10-30T20', '2026-10-29T20', '2026-10-28T20', '2026-10-27T20', '2026-10-26T20', '2026-10-25T20', '2026-10-24T20']);
  assert.equal(keep.length, 11);
  assert.deepEqual([...retained([])], []);
});

test('an in-memory store cannot be snapshotted; keys must be 32 bytes', async () => {
  const s = MemoryStore.open(':memory:', { key: k32(), dim: 4 });
  assert.throws(() => s.snapshotTo('x'), /in-memory/);
  const t = setup();
  try {
    await assert.rejects(backup(t.store, new Uint8Array(3), t.b, t.target), TypeError);
    await assert.rejects(backup(t.store, t.storeKey, new Uint8Array(3), t.target), TypeError);
    await assert.rejects(folderTarget(t.dir).get('../x'), TypeError);
  } finally { t.done(); s.close(); }
});
