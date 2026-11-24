// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, reminders } from '../src/cli.ts';
import { toRecoveryCode, fromRecoveryCode } from '../src/recovery_code.ts';

function fakeKeychain() {
  const m = new Map();
  return { kind: 'test keychain', get: n => m.get(n) ?? null, set: (n, v) => m.set(n, new Uint8Array(v)), delete: n => m.delete(n), m };
}
function env(home, extra = {}) {
  const out = [], err = [];
  return { home, keychain: fakeKeychain(), out: s => out.push(s), err: s => err.push(s), readStdin: async () => '',
    now: () => new Date('2026-11-24T10:00:00Z'), outText: () => out.join(''), errText: () => err.join(''), ...extra };
}

test('init, import, recall, backup, then restore elsewhere with only the recovery code', async () => {
  const root = mkdtempSync(join(tmpdir(), 'synalla-cli-'));
  try {
    const projects = join(root, 'claude', 'C--proj'); mkdirSync(projects, { recursive: true });
    const rec = o => JSON.stringify({ sessionId: 's1', timestamp: '2026-11-20T09:00:00Z', ...o });
    writeFileSync(join(projects, 's1.jsonl'), [rec({ type: 'user', message: { content: 'Our landlord is Frau Kerschbaumer.' } }),
      rec({ type: 'assistant', message: { content: [{ type: 'text', text: 'Noted.' }] } })].join('\n'));
    const a = env(join(root, 'home-a'), { claudeProjects: join(root, 'claude'), hermesDb: join(root, 'no-hermes', 'state.db') });
    assert.equal(await main(['init', '--dim', '8', '--no-embed'], a), 0);
    const code = a.outText().match(/RECOVERY CODE[^\n]*\n\n\s+(\S+)/)[1];
    const id = JSON.parse(readFileSync(join(root, 'home-a', 'config.json'), 'utf8')).id;
    assert.deepEqual(fromRecoveryCode(code), a.keychain.get(`backup-${id}`));
    assert.equal(await main(['init'], a), 1, 'refuses to init twice');
    assert.equal(await main(['import'], a), 0);
    assert.match(a.outText(), /1 session\(s\) imported/);
    assert.equal(await main(['recall', 'landlord?'], a), 0);
    assert.match(a.outText(), /Frau Kerschbaumer/);
    assert.equal(await main(['backup'], a), 1);
    assert.match(a.errText(), /choose a place first/);
    const cloud = join(root, 'cloud');
    assert.equal(await main(['backup-to', 'folder', cloud], a), 0);
    assert.equal(await main(['backup'], a), 0);
    assert.match(a.outText(), /Snapshot 1:/);
    assert.equal(await main(['status'], a), 0);
    assert.match(a.outText(), /1 snapshot\(s\) there/);

    const b = env(join(root, 'home-b'), { keychain: a.keychain }); // same machine, same keychain
    assert.equal(await main(['restore', join(root, 'home-b'), '--code', code.toLowerCase(), '--from', 'folder', cloud], b), 0, b.errText());
    assert.equal(await main(['recall', 'landlord'], b), 0);
    assert.match(b.outText(), /Frau Kerschbaumer/);
    assert.equal(await main(['recall', 'landlord'], a), 0, 'the first memory still opens: keys are per memory');
    assert.equal(await main(['restore', join(root, 'home-b'), '--code', code, '--from', 'folder', cloud], b), 1, 'never overwrites');

    const wrong = env(join(root, 'home-c'));
    const bad = code.slice(0, 3) + (code[3] === 'A' ? 'B' : 'A') + code.slice(4);
    assert.equal(await main(['restore', join(root, 'home-c'), '--code', bad, '--from', 'folder', cloud], wrong), 1);
    assert.match(wrong.errText(), /typo/);

    assert.equal(await main(['export', '--plain', join(root, 'readable')], a), 0);
    assert.ok(existsSync(join(root, 'readable', 'synalla-memory', 'readable', 'claude-code', '2026-11.md')));
    assert.match(a.outText(), /NOT encrypted/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('without init every command says how to start; unknown commands print usage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'synalla-cli-'));
  try {
    const e = env(join(root, 'none'));
    assert.equal(await main(['status'], e), 1);
    assert.match(e.errText(), /run `synalla-memory init` first/);
    assert.equal(await main(['nope'], e), 2);
    assert.equal(await main([], e), 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reminders: no backup place, stale backup, and the yearly Koofr login', () => {
  const now = new Date('2026-11-24T10:00:00Z');
  assert.match(reminders({ id: 'x', dim: 8 }, now)[0], /No backup place/);
  assert.match(reminders({ dim: 8, backup: { type: 'folder', path: 'x' }, lastBackup: '2026-11-01T00:00:00Z' }, now)[0], /last 3 days/);
  const koofr = { dim: 8, backup: { type: 'webdav', url: 'https://app.koofr.net/dav/Koofr', user: 'u' }, lastBackup: now.toISOString() };
  assert.match(reminders(koofr, now)[0], /Log in to Koofr/);
  assert.deepEqual(reminders({ ...koofr, koofrLoginAt: '2026-01-01T00:00:00Z' }, now), []);
  assert.match(reminders({ ...koofr, koofrLoginAt: '2025-11-01T00:00:00Z' }, now)[0], /Log in to Koofr/);
  assert.deepEqual(reminders({ ...koofr, backup: { type: 'webdav', url: 'https://cloud.example.org/dav', user: 'u' } }, now), []);
});

test('recovery code: round trip, forgiving input, typos refused', () => {
  const k = new Uint8Array(32).map((_, i) => i * 7);
  const c = toRecoveryCode(k);
  assert.match(c, /^([0-9A-HJKMNP-TV-Z]{5}-){10}[0-9A-HJKMNP-TV-Z]{5}$/);
  assert.deepEqual(fromRecoveryCode(c.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l')), k);
  assert.throws(() => fromRecoveryCode('short'), /not a recovery code/);
  assert.throws(() => toRecoveryCode(new Uint8Array(3)), TypeError);
});

test('the built-in embedder starts for import and recall and is always stopped', async () => {
  const root = mkdtempSync(join(tmpdir(), 'synalla-cli-'));
  try {
    const projects = join(root, 'claude', 'C--p'); mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, 's.jsonl'), JSON.stringify({ type: 'user', sessionId: 's', timestamp: '2026-11-20T09:00:00Z', message: { content: 'Mamie lives in Lyon' } }));
    const events = [];
    const { createServer } = await import('node:http');
    const srv = createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => {
      const { input } = JSON.parse(b); res.end(JSON.stringify({ data: input.map((_, i) => ({ index: i, embedding: Array.from({ length: 1024 }, (_, j) => (j === 0 ? 1 : 0.01)) })) }));
    }); });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}`;
    const e = env(join(root, 'home'), { claudeProjects: join(root, 'claude'), hermesDb: join(root, 'none.db'),
      startBuiltin: async (home, dim, gpu) => { events.push(['start', dim, gpu]); return { url, stop: () => events.push(['stop']) }; } });
    assert.equal(await main(['init', '--gpu', 'vulkan'], e), 0);
    assert.equal(await main(['import'], e), 0);
    assert.match(e.outText(), /Embedded 1 new chunk/);
    assert.equal(await main(['recall', 'Where does Mamie live?'], e), 0);
    assert.match(e.outText(), /Mamie lives in Lyon/);
    assert.deepEqual(events, [['start', 1024, 'vulkan'], ['stop'], ['start', 1024, 'vulkan'], ['stop']]);
    srv.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('extract-with refuses a remote endpoint without --cloud-ok; extract reads items and stores checked facts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'synalla-cli-'));
  try {
    const { createServer } = await import('node:http');
    const srv = createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => {
      const prompt = JSON.parse(b).messages[0].content;
      const facts = prompt.includes('Lyon') ? [{ subject: 'Mamie', predicate: 'lives_in', object: 'Lyon', valid_from: '2026-11-20', valid_to: null, mentioned_at: '2026-11-20', quote: 'Mamie lives in Lyon' }] : [];
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ facts }) } }] }));
    }); });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}`;
    const projects = join(root, 'claude', 'C--p'); mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, 's.jsonl'), JSON.stringify({ type: 'user', sessionId: 's', timestamp: '2026-11-20T09:00:00Z', message: { content: 'Mamie lives in Lyon' } }));
    const e = env(join(root, 'home'), { claudeProjects: join(root, 'claude'), hermesDb: join(root, 'none.db') });
    assert.equal(await main(['init', '--no-embed'], e), 0);
    assert.equal(await main(['extract'], e), 1);
    assert.match(e.errText(), /choose a model first/);
    assert.equal(await main(['extract-with', 'https://api.example.com', 'm', '--owner', 'Maria'], e), 1);
    assert.match(e.errText(), /not on this machine.*--cloud-ok/);
    assert.equal(await main(['extract-with', url, 'daily', '--owner', 'Maria'], e), 0);
    assert.equal(await main(['import'], e), 0);
    assert.equal(await main(['extract'], e), 0, e.errText());
    assert.match(e.outText(), /Facts: 1 from 1 item\(s\); 0 item\(s\) failed\. All items read\./);
    assert.equal(await main(['recall', 'Where does Mamie live?'], e), 0);
    assert.match(e.outText(), /Facts:\n- Mamie \| lives_in \| Lyon \(valid from 2026-11-20, current;/);
    srv.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('S3: backup-to reads the secret from stdin; a restore on a new machine (empty keychain) asks for it again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'synalla-cli-'));
  const { createServer } = await import('node:http');
  const objects = new Map();
  const srv = createServer((req, res) => {
    if (!/Credential=AK\//.test(req.headers.authorization ?? '')) return res.writeHead(403).end();
    const u = new URL(req.url, 'http://x'); const key = decodeURIComponent(u.pathname.replace(/^\/bkt\/?/, ''));
    const body = []; req.on('data', d => body.push(d)); req.on('end', () => {
      if (req.method === 'GET' && u.searchParams.get('list-type')) {
        const p = u.searchParams.get('prefix');
        return res.end(`<R>${[...objects.keys()].filter(k => k.startsWith(p) && !k.slice(p.length).includes('/')).map(k => `<Contents><Key>${k}</Key></Contents>`).join('')}<IsTruncated>false</IsTruncated></R>`);
      }
      if (req.method === 'PUT') { objects.set(key, Buffer.concat(body)); return res.end(); }
      if (req.method === 'GET') return objects.has(key) ? res.end(objects.get(key)) : res.writeHead(404).end();
      if (req.method === 'DELETE') { objects.delete(key); return res.writeHead(204).end(); }
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${srv.address().port}`;
  try {
    const a = env(join(root, 'a'), { readStdin: async () => 'SECRET\n' });
    assert.equal(await main(['init', '--dim', '8', '--no-embed'], a), 0);
    const code = a.outText().match(/RECOVERY CODE[^\n]*\n\n\s+(\S+)/)[1];
    assert.equal(await main(['backup-to', 's3', endpoint, 'bkt', 'eu-central-003', 'AK'], a), 0, a.errText());
    assert.equal(await main(['backup'], a), 0, a.errText());
    const noSecret = env(join(root, 'b0'));
    assert.equal(await main(['restore', join(root, 'b0'), '--code', code, '--from', 's3', endpoint, 'bkt', 'eu-central-003', 'AK'], noSecret), 1);
    assert.match(noSecret.errText(), /S3 secret key on stdin/);
    const b = env(join(root, 'b'), { readStdin: async () => 'SECRET' });
    assert.equal(await main(['restore', join(root, 'b'), '--code', code, '--from', 's3', endpoint, 'bkt', 'eu-central-003', 'AK'], b), 0, b.errText());
    assert.equal(await main(['backup'], b), 0, 'the restored memory keeps backing up to the same place');
    assert.match(b.outText(), /Snapshot 2:/);
  } finally { srv.close(); rmSync(root, { recursive: true, force: true }); }
});
