// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// `synalla-memory`: one command for the memory package (pilot plan W1).
//   init [--gpu vulkan] [--no-embed] [--embed-url <url>]   create the store, its key and the backup key (shown once
//                            as a recovery code); --gpu vulkan runs the built-in embedder on the GPU
//   import                   import Claude Code sessions (and embed them if an embedding endpoint is set)
//   embed                    embed chunks and facts that have no vector yet
//   extract-with <url> <model> --owner <name> [--cloud-ok]   choose the chat model that extracts facts (API key, if
//                            any, read from stdin; a non-local endpoint needs --cloud-ok: records are sent to it)
//   extract [--limit N] [--agent-sessions]   extract facts from items not yet read (then embeds them); agent
//                            sessions are read only with --agent-sessions (the measured setting left their facts out)
//   recall <question>        search from the terminal
//   serve                    run the MCP server on stdio (configure your agent to start this)
//   backup-to folder <path> | webdav <url> <user> | s3 <endpoint> <bucket> <region> <access key id>
//                            choose where backups go (WebDAV app password or S3 secret key read from stdin)
//   backup                   take a snapshot now
//   restore <dir> --code <recovery code> --from <place> [--before <date>]   (a place's secret is read from stdin)
//   export --plain <dir>     write the readable copy to a folder
//   koofr-login-done         record that you logged in to Koofr (its inactivity rule)
//   status                   counts, last backup, reminders
// Settings live in <home>/config.json; keys live in the OS keychain.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from './store.ts';
import { systemKeychain, type Keychain } from './keychain.ts';
import { toRecoveryCode, fromRecoveryCode } from './recovery_code.ts';
import { importClaudeCode } from './import_claude_code.ts';
import { readHermes, hermesDbPath } from './import_hermes.ts';
import { readOpenClaw, openclawStateDir } from './import_openclaw.ts';
import { readMbox, readNotes, type MailStats } from './import_mail.ts';
import { httpEmbedder, type Embedder } from './embed.ts';
import { ensureModels, startEmbedServer, EMBED_MODEL } from './models.ts';
import { McpServer, serveStdio } from './mcp.ts';
import { backup, restore, folderTarget, webdavTarget, s3Target, listSnapshots, type Target } from './backup.ts';
import { exportPlain } from './export.ts';
import { httpChatModel, extractPending } from './facts.ts';

export interface Config {
  /** Names this memory's keys in the keychain, so two memories on one machine never share keys. */
  id: string;
  dim: number;
  /** An OpenAI-compatible embedding endpoint you run yourself; otherwise the built-in llama.cpp sidecar. */
  embedUrl?: string;
  /** 'none': keyword search only, no model download. */
  embed?: 'builtin' | 'none';
  /** Run the built-in embedder on the GPU (Vulkan build of llama.cpp); default CPU. */
  embedGpu?: 'vulkan';
  backup?: { type: 'folder'; path: string } | { type: 'webdav'; url: string; user: string }
    | { type: 's3'; endpoint: string; bucket: string; region: string; accessKeyId: string };
  lastBackup?: string;
  koofrLoginAt?: string;
  claudeCodeSeen?: Record<string, number>;
  hermesSeen?: Record<string, string>;
  openclawSeen?: Record<string, string>;
  extract?: { url: string; model: string; owner: string; cloudAgreedAt?: string };
}

export interface Env {
  home: string;
  keychain: Keychain;
  out: (s: string) => void;
  err: (s: string) => void;
  readStdin: () => Promise<string>;
  now: () => Date;
  claudeProjects?: string;
  hermesDb?: string;
  /** OpenClaw's state directory (default OPENCLAW_STATE_DIR or ~/.openclaw). */
  openclawDir?: string;
  /** Starts the built-in embedding server (tests inject a fake; the default downloads pinned files on first use). */
  startBuiltin?: (home: string, dim: number, gpu?: 'vulkan') => Promise<{ url: string; stop(): void }>;
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
/** The embedder for this memory and a function that releases it (stops the sidecar). */
async function embedder(env: Env, c: Config): Promise<{ e?: Embedder; stop(): void }> {
  if (c.embedUrl) return { e: httpEmbedder({ url: c.embedUrl, dim: c.dim }), stop: () => {} };
  if (c.embed === 'none') return { stop: () => {} };
  const s = await (env.startBuiltin ?? builtin(env))(env.home, c.dim, c.embedGpu);
  return { e: httpEmbedder({ url: s.url, dim: c.dim }), stop: s.stop };
}
function builtin(env: Env) {
  return async (home: string, dim: number, gpu?: 'vulkan') => {
    if (dim !== EMBED_MODEL.dim) throw new Error(`the built-in model makes ${EMBED_MODEL.dim}-number vectors, this memory uses ${dim}; set embedUrl`);
    let last = '';
    const { server, model } = await ensureModels(join(home, 'models'), {
      gpu: gpu ?? 'cpu',
      progress: (what, d, t) => {
        const line = `Downloading ${what} (first use only): ${Math.floor((100 * d) / t)}%`;
        if (line !== last) { env.err(`\r${line}`); last = line; if (d === t) env.err('\n'); }
      },
    });
    return startEmbedServer(server, model, { gpuLayers: gpu ? 99 : 0 });
  };
}
async function embedMissing(store: MemoryStore, e: Embedder): Promise<number> {
  let n = 0;
  for (;;) {
    const m = store.missingVectors(128);
    if (m.length === 0) break;
    const v = await e.embed(m.map(x => x.text), 'passage');
    store.setVectors(m.map((x, i) => ({ cid: x.cid, vec: v[i] as Float32Array })));
    n += m.length;
  }
  for (;;) {
    const m = store.missingFactVectors(128);
    if (m.length === 0) return n;
    const v = await e.embed(m.map(x => x.text), 'passage');
    store.setFactVectors(m.map((x, i) => ({ fid: x.fid, vec: v[i] as Float32Array })));
    n += m.length;
  }
}
const isLocal = (url: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
type BackupPlace = NonNullable<Config['backup']>;
/** Parse `folder <path>` | `webdav <url> <user>` | `s3 <endpoint> <bucket> <region> <access key id>`. */
function parsePlace(spec: string[]): BackupPlace {
  const [kind, a, b, cc, d] = spec;
  if (kind === 'folder' && a) return { type: 'folder', path: a };
  if (kind === 'webdav' && a && b) return { type: 'webdav', url: a, user: b };
  if (kind === 's3' && a && b && cc && d) return { type: 's3', endpoint: a, bucket: b, region: cc, accessKeyId: d };
  throw new Error('place must be `folder <path>`, `webdav <url> <user>` or `s3 <endpoint> <bucket> <region> <access key id>`');
}
const describePlace = (p: BackupPlace) => (p.type === 'folder' ? p.path : p.type === 'webdav' ? p.url : `${p.endpoint}/${p.bucket}`);
const secretName = (p: BackupPlace) => (p.type === 'webdav' ? 'webdav' : p.type === 's3' ? 's3' : null);
const secretLabel = (p: BackupPlace) => (p.type === 'webdav' ? 'WebDAV app password' : 'S3 secret key');
/** The target for a place. Its secret (WebDAV app password, S3 secret key) comes from the keychain, or from stdin when asked. */
async function target(env: Env, c: Pick<Config, 'id'>, p: BackupPlace, opts: { askSecret?: boolean } = {}): Promise<Target> {
  if (p.type === 'folder') return folderTarget(p.path);
  const name = kname(c, secretName(p) as string);
  let secret = env.keychain.get(name);
  if (!secret && opts.askSecret) {
    const s = (await env.readStdin()).trim();
    if (!s) throw new Error(`give the ${secretLabel(p)} on stdin (for WebDAV an app password, never your account password)`);
    secret = new Uint8Array(Buffer.from(s, 'utf8'));
    env.keychain.set(name, secret);
  }
  if (!secret) throw new Error(`no ${secretLabel(p)} stored; run \`synalla-memory backup-to ...\` again`);
  const sec = Buffer.from(secret).toString('utf8');
  return p.type === 'webdav' ? webdavTarget({ url: p.url, user: p.user, password: sec })
    : s3Target({ endpoint: p.endpoint, bucket: p.bucket, region: p.region, accessKeyId: p.accessKeyId, secretAccessKey: sec });
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
        const c: Config = { id, dim, ...(urlArg >= 0 && rest[urlArg + 1] ? { embedUrl: rest[urlArg + 1] as string } : {}),
          ...(rest.includes('--no-embed') ? { embed: 'none' as const } : {}),
          ...(rest.includes('--gpu') && rest[rest.indexOf('--gpu') + 1] === 'vulkan' ? { embedGpu: 'vulkan' as const } : {}) };
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
          let hermesFailed = false;
          try {
            const hs = new Map(Object.entries(c.hermesSeen ?? {}));
            const items = readHermes(env.hermesDb ?? hermesDbPath(), hs);
            for (const it of items) store.addItem(it);
            c.hermesSeen = Object.fromEntries(hs);
            save(env, c);
            if (hs.size > 0) env.out(`Hermes: ${items.length} session(s) imported.\n`);
          } catch (e) { hermesFailed = true; env.err(`Hermes: ${(e as Error).message}\n`); }
          let openclawFailed = false;
          try {
            const os = new Map(Object.entries(c.openclawSeen ?? {}));
            const o = readOpenClaw(env.openclawDir ?? openclawStateDir(), os);
            for (const it of o.items) store.addItem(it);
            c.openclawSeen = Object.fromEntries(os);
            save(env, c);
            if (os.size > 0) env.out(`OpenClaw: ${o.items.length} session(s) imported.\n`);
            for (const f of o.failed) { openclawFailed = true; env.err(`OpenClaw (agent ${f.agent}): ${f.error}\n`); }
          } catch (e) { openclawFailed = true; env.err(`OpenClaw: ${(e as Error).message}\n`); }
          const em = await embedder(env, c);
          try { if (em.e) env.out(`Embedded ${await embedMissing(store, em.e)} new chunk(s).\n`); } finally { em.stop(); }
          return r.failed.length > 0 || hermesFailed || openclawFailed ? 1 : 0;
        } finally { store.close(); }
      }
      case 'import-mail':
      case 'import-notes': {
        const path = rest[0];
        if (!path) throw new Error(cmd === 'import-mail' ? 'usage: synalla-memory import-mail <file.mbox>' : 'usage: synalla-memory import-notes <folder>');
        if (!existsSync(path)) throw new Error(`not found: ${path}`);
        const isDir = statSync(path).isDirectory();
        if (cmd === 'import-mail' && isDir) throw new Error(`${path} is a folder: give the mbox file (in a Google Takeout export, Mail/*.mbox)`);
        if (cmd === 'import-notes' && !isDir) throw new Error(`${path} is a file: give the folder that holds your notes`);
        const c = load(env), store = openStore(env, c);
        try {
          const stats: MailStats = { seen: 0, kept: 0, spamTrash: 0, badDate: 0, bulkHeadersOnly: 0, empty: 0, errors: 0 };
          const notes = { skipped: 0 };
          const items = cmd === 'import-mail' ? readMbox(path, stats) : readNotes(path, notes);
          let added = 0, same = 0;
          for (const it of items) {
            if (store.hasSameItem(it)) { same++; continue; }
            store.addItem(it); added++;
          }
          if (cmd === 'import-mail') {
            env.out(`Mail: ${stats.seen} message(s) read, ${added} imported, ${same} unchanged; left out: ${stats.spamTrash} spam or trash, `
              + `${stats.badDate} without a date, ${stats.empty} empty, ${stats.duplicates ?? 0} duplicate copies, ${stats.errors} unreadable`
              + `${stats.truncated ? `; ${stats.truncated} over 64 MB read in part` : ''}.\n`);
          } else env.out(`Notes: ${added} imported, ${same} unchanged${notes.skipped ? `, ${notes.skipped} skipped (unreadable or over 1 MB)` : ''}.\n`);
          const em = await embedder(env, c);
          try { if (em.e) env.out(`Embedded ${await embedMissing(store, em.e)} new chunk(s).\n`); } finally { em.stop(); }
          return stats.errors > 0 ? 1 : 0;
        } finally { store.close(); }
      }
      case 'embed': {
        const c = load(env);
        if (!c.embedUrl && c.embed === 'none') throw new Error('this memory uses keyword search only (--no-embed)');
        const store = openStore(env, c), em = await embedder(env, c);
        try { env.out(`Embedded ${await embedMissing(store, em.e as Embedder)} chunk(s).\n`); return 0; } finally { store.close(); em.stop(); }
      }
      case 'recall': {
        const q = rest.join(' ').trim();
        if (!q) throw new Error('usage: synalla-memory recall <question>');
        const c = load(env), store = openStore(env, c);
        const em = await embedder(env, c).catch(e => { store.close(); throw e; });
        try {
          const s = new McpServer(store, em.e ? { embedder: em.e } : {});
          const r = await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'recall', arguments: { question: q, limit: 5 } } }) as
            { result: { structuredContent: { passages: { text: string }[]; facts: { line: string }[] } } };
          const { passages, facts } = r.result.structuredContent;
          if (facts.length > 0) env.out(`Facts:\n${facts.slice(0, 10).map(f => f.line).join('\n')}\n`);
          for (const p of passages) env.out(`---\n${p.text}\n`);
          return 0;
        } finally { store.close(); em.stop(); }
      }
      case 'serve': {
        const c = load(env), store = openStore(env, c);
        const em = await embedder(env, c).catch(e => { store.close(); throw e; });
        try { await serveStdio(new McpServer(store, em.e ? { embedder: em.e } : {})); return 0; } finally { store.close(); em.stop(); }
      }
      case 'backup-to': {
        const c = load(env);
        const place = parsePlace(rest);
        if (secretName(place)) env.keychain.delete(kname(c, secretName(place) as string));
        await target(env, c, place, { askSecret: true }); // reads the secret from stdin into the keychain
        c.backup = place;
        save(env, c);
        env.out(`Backups will go to ${describePlace(c.backup)}.\n`);
        return 0;
      }
      case 'backup': {
        const c = load(env);
        if (!c.backup) throw new Error('choose a place first: synalla-memory backup-to folder <path>');
        const t = await target(env, c, c.backup);
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
        if (!dir || ci < 0 || fi < 0) throw new Error('usage: restore <dir> --code <recovery code> --from <place> [--before <date>]');
        const b = fromRecoveryCode(rest[ci + 1] ?? '');
        const id = randomBytes(4).toString('hex');
        const place = parsePlace(rest.slice(fi + 1, fi + 6).filter(x => !x.startsWith('--')));
        const t = await target(env, { id }, place, { askSecret: true });
        const before = bi >= 0 ? new Date(rest[bi + 1] ?? '') : undefined;
        if (before && Number.isNaN(before.getTime())) throw new Error('--before needs a date such as 2026-11-20');
        mkdirSync(dir, { recursive: true });
        if (existsSync(join(dir, 'config.json'))) throw new Error(`${dir} already holds a memory`);
        const got = await restore(t, b, join(dir, 'memory.db'), before ? { before } : {});
        env.keychain.set(`store-${id}`, got.key);
        env.keychain.set(`backup-${id}`, b);
        const builtinFits = got.dim === EMBED_MODEL.dim;
        writeFileSync(join(dir, 'config.json'), JSON.stringify({ id, dim: got.dim, backup: place, ...(builtinFits ? {} : { embed: 'none' }) }, null, 2));
        env.out(`Restored snapshot ${got.seq} of ${got.createdAt} into ${dir}. Keys are in the ${env.keychain.kind}.\n`
          + (builtinFits ? '' : `Its vectors have ${got.dim} numbers, not the built-in model's ${EMBED_MODEL.dim}: recall uses keywords until you set embedUrl in config.json.\n`));
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
      case 'extract-with': {
        const c = load(env);
        const [url, model] = rest;
        const oi = rest.indexOf('--owner');
        const owner = oi >= 0 ? (rest[oi + 1] ?? '').trim() : '';
        if (!url || !model || url.startsWith('--') || !owner) throw new Error('usage: extract-with <url> <model> --owner <your name> [--cloud-ok]');
        new URL(url);
        const local = isLocal(url);
        if (!local && !rest.includes('--cloud-ok')) {
          throw new Error(`${url} is not on this machine: every record is sent there to extract facts. If you agree, run again with --cloud-ok.`);
        }
        const key = local ? '' : (await env.readStdin()).trim();
        if (key) env.keychain.set(kname(c, 'extract'), new Uint8Array(Buffer.from(key, 'utf8')));
        c.extract = { url, model, owner, ...(local ? {} : { cloudAgreedAt: env.now().toISOString() }) };
        save(env, c);
        env.out(`Facts will be extracted by ${model} at ${url}${local ? '' : ' (records leave this machine; you agreed)'}.\n`);
        return 0;
      }
      case 'extract': {
        const c = load(env);
        if (!c.extract) throw new Error('choose a model first: synalla-memory extract-with <url> <model> --owner <your name>');
        const li = rest.indexOf('--limit');
        const limit = li >= 0 ? Number(rest[li + 1]) : 50;
        if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('--limit needs a positive whole number');
        const key = env.keychain.get(kname(c, 'extract'));
        const model = httpChatModel({ url: c.extract.url, model: c.extract.model, ...(key ? { apiKey: Buffer.from(key).toString('utf8') } : {}) });
        const store = openStore(env, c);
        try {
          const r = await extractPending(store, model, c.extract.owner, { limit, now: env.now, agentSessions: rest.includes('--agent-sessions') });
          const more = store.pendingExtraction(1, { agentSessions: rest.includes('--agent-sessions') }).length > 0;
          env.out(`Facts: ${r.facts} from ${r.items} item(s); ${r.failed} item(s) failed. ${more ? 'More items wait: run extract again.' : 'All items read.'}\n`);
          const em = await embedder(env, c);
          try { if (em.e) env.out(`Embedded ${await embedMissing(store, em.e)} new vector(s).\n`); } finally { em.stop(); }
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
          env.out(`Backups: ${c.backup ? describePlace(c.backup) : 'none chosen'}; last ${c.lastBackup ?? 'never'}.\n`);
          if (c.backup && c.lastBackup) {
            const t = await target(env, c, c.backup);
            const snaps = await listSnapshots(t, need(env, c, 'backup'));
            if (snaps.length === 0) env.out('WARNING: no snapshot found at the backup place, although one was taken. Check it.\n');
            else env.out(`${snaps.length} snapshot(s) there, newest ${snaps[0]?.createdAt}.\n`);
          }
          for (const r of reminders(c, env.now())) env.out(`Reminder: ${r}\n`);
          return 0;
        } finally { store.close(); }
      }
      default:
        env.out('usage: synalla-memory init | import | import-mail <mbox> | import-notes <folder> | embed | extract-with ... | extract | recall <q> | serve | backup-to ... | backup | restore ... | export --plain <dir> | koofr-login-done | status\n');
        return cmd ? 2 : 0;
    }
  } catch (e) {
    env.err(`synalla-memory: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

export function defaultEnv(): Env {
  const home = process.env['SYNALLA_MEMORY_HOME'] ?? join(homedir(), '.synalla', 'memory');
  return {
    home,
    keychain: systemKeychain(process.platform, undefined, { dir: join(home, 'keys') }),
    out: s => process.stdout.write(s),
    err: s => process.stderr.write(s),
    readStdin: async () => { let s = ''; for await (const d of process.stdin) s += d; return s; },
    now: () => new Date(),
  };
}
