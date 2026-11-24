// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// `synalla-memory`: one command for the memory package (pilot plan W1).
//   init                     create the store, its key and the backup key (shown once as a recovery code)
//   import                   import Claude Code sessions (and embed them if an embedding endpoint is set)
//   embed                    embed chunks that have no vector yet
//   recall <question>        search from the terminal
//   serve                    run the MCP server on stdio (configure your agent to start this)
//   backup-to folder <path> | webdav <url> <user>   choose where backups go (WebDAV app password read from stdin)
//   backup                   take a snapshot now
//   restore <dir> --code <recovery code> --from folder <path> | webdav <url> <user> [--before <date>]
//   export --plain <dir>     write the readable copy to a folder
//   koofr-login-done         record that you logged in to Koofr (its inactivity rule)
//   status                   counts, last backup, reminders
// Settings live in <home>/config.json; keys live in the OS keychain.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from './store.ts';
import { systemKeychain, type Keychain } from './keychain.ts';
import { toRecoveryCode, fromRecoveryCode } from './recovery_code.ts';
import { importClaudeCode } from './import_claude_code.ts';
import { httpEmbedder, type Embedder } from './embed.ts';
import { McpServer, serveStdio } from './mcp.ts';
import { backup, restore, folderTarget, webdavTarget, listSnapshots, type Target } from './backup.ts';
import { exportPlain } from './export.ts';

export interface Config {
  /** Names this memory's keys in the keychain, so two memories on one machine never share keys. */
  id: string;
  dim: number;
  embedUrl?: string;
  backup?: { type: 'folder'; path: string } | { type: 'webdav'; url: string; user: string };
  lastBackup?: string;
  koofrLoginAt?: string;
  claudeCodeSeen?: Record<string, number>;
}

export interface Env {
  home: string;
  keychain: Keychain;
  out: (s: string) => void;
  err: (s: string) => void;
  readStdin: () => Promise<string>;
  now: () => Date;
  claudeProjects?: string;
}

const YEAR_MS = 365 * 86400000;

function load(env: Env): Config {
  const p = join(env.home, 'config.json');
  if (!existsSync(p)) throw new Error('no memory here yet: run `synalla-memory init` first');
  return JSON.parse(readFileSync(p, 'utf8')) as Config;
}
function save(env: Env, c: Config): void { writeFileSync(join(env.home, 'config.json'), JSON.stringify(c, null, 2)); }
const kname = (c: Pick<Config, 'id'>, name: string) => `${name}-${c.id}`;
function need(env: Env, c: Config, name: string): Uint8Array {
  const k = env.keychain.get(kname(c, name));
  if (!k) throw new Error(`the ${name} key is missing from the ${env.keychain.kind}`);
  return k;
}
function openStore(env: Env, c: Config): MemoryStore {
  return MemoryStore.open(join(env.home, 'memory.db'), { key: need(env, c, 'store'), dim: c.dim });
}
function embedder(c: Config): Embedder | undefined {
  return c.embedUrl ? httpEmbedder({ url: c.embedUrl, dim: c.dim }) : undefined;
}
async function embedMissing(store: MemoryStore, e: Embedder): Promise<number> {
  let n = 0;
  for (;;) {
    const m = store.missingVectors(128);
    if (m.length === 0) return n;
    const v = await e.embed(m.map(x => x.text), 'passage');
    store.setVectors(m.map((x, i) => ({ cid: x.cid, vec: v[i] as Float32Array })));
    n += m.length;
  }
}
async function target(env: Env, c: Pick<Config, 'id'>, spec: string[]): Promise<Target> {
  if (spec[0] === 'folder' && spec[1]) return folderTarget(spec[1]);
  if (spec[0] === 'webdav' && spec[1] && spec[2]) {
    const pw = env.keychain.get(kname(c, 'webdav'));
    if (!pw) throw new Error('no WebDAV app password stored; run `synalla-memory backup-to webdav ...` first');
    return webdavTarget({ url: spec[1], user: spec[2], password: Buffer.from(pw).toString('utf8') });
  }
  throw new Error('target must be `folder <path>` or `webdav <url> <user>`');
}
const isKoofr = (c: Config) => c.backup?.type === 'webdav' && /(^|\.)koofr\.(net|eu)$/.test(new URL(c.backup.url).hostname);

/** Reminders shown by `status` (and by recall results in the MCP server later). */
export function reminders(c: Config, now: Date): string[] {
  const out: string[] = [];
  if (!c.backup) out.push('No backup place chosen: run `synalla-memory backup-to folder <your cloud folder>`.');
  else if (!c.lastBackup || now.getTime() - Date.parse(c.lastBackup) > 3 * 86400000) out.push('No backup in the last 3 days: run `synalla-memory backup`.');
  if (isKoofr(c)) {
    const last = c.koofrLoginAt ? Date.parse(c.koofrLoginAt) : NaN;
    // Koofr deletes accounts after 2 years without a login; we assume backups do not count (Serge, 24 Nov).
    if (Number.isNaN(last) || now.getTime() - last > YEAR_MS) {
      out.push('Log in to Koofr once (https://app.koofr.net) to keep your backup account active, then run `synalla-memory koofr-login-done`.');
    }
  }
  return out;
}

export async function main(argv: string[], env: Env): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'init': {
        mkdirSync(env.home, { recursive: true });
        if (existsSync(join(env.home, 'config.json'))) throw new Error(`a memory already exists in ${env.home}`);
        const dimArg = rest.indexOf('--dim');
        const dim = dimArg >= 0 ? Number(rest[dimArg + 1]) : 1024;
        const urlArg = rest.indexOf('--embed-url');
        const storeKey = new Uint8Array(randomBytes(32)), b = new Uint8Array(randomBytes(32));
        const id = randomBytes(4).toString('hex');
        env.keychain.set(`store-${id}`, storeKey);
        env.keychain.set(`backup-${id}`, b);
        const c: Config = { id, dim, ...(urlArg >= 0 && rest[urlArg + 1] ? { embedUrl: rest[urlArg + 1] as string } : {}) };
        MemoryStore.open(join(env.home, 'memory.db'), { key: storeKey, dim }).close();
        save(env, c);
        env.out(`Memory created in ${env.home}. Its keys are in the ${env.keychain.kind}.\n\n`
          + 'Your RECOVERY CODE (shown once; keep it in your password manager or on paper):\n\n'
          + `    ${toRecoveryCode(b)}\n\n`
          + 'With it and access to your backup place, your memory comes back on a new machine. Without it, it does not.\n');
        return 0;
      }
      case 'import': {
        const c = load(env), store = openStore(env, c);
        try {
          const seen = new Map(Object.entries(c.claudeCodeSeen ?? {}));
          const r = await importClaudeCode(store, seen, env.claudeProjects);
          c.claudeCodeSeen = Object.fromEntries(seen);
          save(env, c);
          env.out(`Claude Code: ${r.imported.length} session(s) imported, ${r.skipped} unchanged, ${r.failed.length} failed.\n`);
          for (const f of r.failed) env.err(`  ${f.file}: ${f.error}\n`);
          const e = embedder(c);
          if (e) env.out(`Embedded ${await embedMissing(store, e)} new chunk(s).\n`);
          return r.failed.length > 0 ? 1 : 0;
        } finally { store.close(); }
      }
      case 'embed': {
        const c = load(env), e = embedder(c);
        if (!e) throw new Error('no embedding endpoint set (init --embed-url http://127.0.0.1:5941)');
        const store = openStore(env, c);
        try { env.out(`Embedded ${await embedMissing(store, e)} chunk(s).\n`); return 0; } finally { store.close(); }
      }
      case 'recall': {
        const q = rest.join(' ').trim();
        if (!q) throw new Error('usage: synalla-memory recall <question>');
        const c = load(env), store = openStore(env, c);
        try {
          const s = new McpServer(store, embedder(c) ? { embedder: embedder(c) as Embedder } : {});
          const r = await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'recall', arguments: { question: q, limit: 5 } } }) as
            { result: { structuredContent: { passages: { text: string }[] } } };
          for (const p of r.result.structuredContent.passages) env.out(`---\n${p.text}\n`);
          return 0;
        } finally { store.close(); }
      }
      case 'serve': {
        const c = load(env), store = openStore(env, c);
        try { await serveStdio(new McpServer(store, embedder(c) ? { embedder: embedder(c) as Embedder } : {})); return 0; } finally { store.close(); }
      }
      case 'backup-to': {
        const c = load(env);
        if (rest[0] === 'folder' && rest[1]) c.backup = { type: 'folder', path: rest[1] };
        else if (rest[0] === 'webdav' && rest[1] && rest[2]) {
          const pw = (await env.readStdin()).trim();
          if (!pw) throw new Error('give the WebDAV app password on stdin (never your account password)');
          env.keychain.set(kname(c, 'webdav'), new Uint8Array(Buffer.from(pw, 'utf8')));
          c.backup = { type: 'webdav', url: rest[1], user: rest[2] };
        } else throw new Error('usage: backup-to folder <path> | backup-to webdav <url> <user>');
        save(env, c);
        env.out(`Backups will go to ${c.backup.type === 'folder' ? c.backup.path : c.backup.url}.\n`);
        return 0;
      }
      case 'backup': {
        const c = load(env);
        if (!c.backup) throw new Error('choose a place first: synalla-memory backup-to folder <path>');
        const t = await target(env, c, c.backup.type === 'folder' ? ['folder', c.backup.path] : ['webdav', c.backup.url, c.backup.user]);
        const store = openStore(env, c);
        try {
          const r = await backup(store, need(env, c, 'store'), need(env, c, 'backup'), t, env.now());
          c.lastBackup = env.now().toISOString();
          save(env, c);
          env.out(`Snapshot ${r.seq}: ${r.pieces} piece(s), ${r.uploaded} uploaded (${(r.bytesUploaded / 1048576).toFixed(1)} MB), ${r.pruned.length} old file(s) removed.\n`);
          return 0;
        } finally { store.close(); }
      }
      case 'restore': {
        const dir = rest[0];
        const ci = rest.indexOf('--code'), fi = rest.indexOf('--from'), bi = rest.indexOf('--before');
        if (!dir || ci < 0 || fi < 0) throw new Error('usage: restore <dir> --code <recovery code> --from folder <path> | webdav <url> <user> [--before <date>]');
        const b = fromRecoveryCode(rest[ci + 1] ?? '');
        const id = randomBytes(4).toString('hex');
        const t = await target(env, { id }, rest.slice(fi + 1, fi + 4).filter(x => !x.startsWith('--')));
        const before = bi >= 0 ? new Date(rest[bi + 1] ?? '') : undefined;
        if (before && Number.isNaN(before.getTime())) throw new Error('--before needs a date such as 2026-11-20');
        mkdirSync(dir, { recursive: true });
        if (existsSync(join(dir, 'config.json'))) throw new Error(`${dir} already holds a memory`);
        const got = await restore(t, b, join(dir, 'memory.db'), before ? { before } : {});
        env.keychain.set(`store-${id}`, got.key);
        env.keychain.set(`backup-${id}`, b);
        writeFileSync(join(dir, 'config.json'), JSON.stringify({ id, dim: got.dim }, null, 2));
        env.out(`Restored snapshot ${got.seq} of ${got.createdAt} into ${dir}. Keys are in the ${env.keychain.kind}.\n`);
        return 0;
      }
      case 'export': {
        if (rest[0] !== '--plain' || !rest[1]) throw new Error('usage: synalla-memory export --plain <dir>');
        const c = load(env), store = openStore(env, c);
        try {
          const files = await exportPlain(store, folderTarget(rest[1]));
          env.out(`Wrote ${files.length} readable file(s) under ${join(rest[1], 'synalla-memory', 'readable')}. They are NOT encrypted.\n`);
          return 0;
        } finally { store.close(); }
      }
      case 'koofr-login-done': {
        const c = load(env);
        c.koofrLoginAt = env.now().toISOString();
        save(env, c);
        env.out('Noted. Next reminder in a year.\n');
        return 0;
      }
      case 'status': {
        const c = load(env), store = openStore(env, c);
        try {
          const s = store.stats();
          env.out(`${s.items} item(s), ${s.chunks} chunk(s), ${s.vectors} with vectors. Keys: ${env.keychain.kind}.\n`);
          env.out(`Backups: ${c.backup ? (c.backup.type === 'folder' ? c.backup.path : c.backup.url) : 'none chosen'}; last ${c.lastBackup ?? 'never'}.\n`);
          if (c.backup && c.lastBackup) {
            const t = await target(env, c, c.backup.type === 'folder' ? ['folder', c.backup.path] : ['webdav', c.backup.url, c.backup.user]);
            const snaps = await listSnapshots(t, need(env, c, 'backup'));
            if (snaps.length === 0) env.out('WARNING: no snapshot found at the backup place, although one was taken. Check it.\n');
            else env.out(`${snaps.length} snapshot(s) there, newest ${snaps[0]?.createdAt}.\n`);
          }
          for (const r of reminders(c, env.now())) env.out(`Reminder: ${r}\n`);
          return 0;
        } finally { store.close(); }
      }
      default:
        env.out('usage: synalla-memory init | import | embed | recall <q> | serve | backup-to ... | backup | restore ... | export --plain <dir> | koofr-login-done | status\n');
        return cmd ? 2 : 0;
    }
  } catch (e) {
    env.err(`synalla-memory: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

export function defaultEnv(): Env {
  return {
    home: process.env['SYNALLA_MEMORY_HOME'] ?? join(homedir(), '.synalla', 'memory'),
    keychain: systemKeychain(),
    out: s => process.stdout.write(s),
    err: s => process.stderr.write(s),
    readStdin: async () => { let s = ''; for await (const d of process.stdin) s += d; return s; },
    now: () => new Date(),
  };
}
