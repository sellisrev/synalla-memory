// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { MemoryStore } from '../src/store.ts';
import { McpServer, INSTRUCTIONS } from '../src/mcp.ts';
import { startRevealPage } from '../src/reveal_page.ts';

const open = () => MemoryStore.open(':memory:', { key: new Uint8Array(randomBytes(32)), dim: 4 });
// A raw GET, so the test can send any Host header (fetch would set its own).
const get = (url, host) => new Promise((ok, fail) => {
  const u = new URL(url);
  const r = request({ host: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers: { host: host ?? u.host } }, res => {
    let b = ''; res.setEncoding('utf8'); res.on('data', d => { b += d; }); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: b }));
  });
  r.on('error', fail); r.end();
});
const call = async (srv, name, args) => (await srv.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result;

test('show_to_owner: the agent gets a loopback link with no values in it; the page puts them back', async () => {
  const store = open();
  const srv = new McpServer(store, { revealPage: () => startRevealPage(t => store.reveal(t)) });
  try {
    store.addItem({ id: 'n1', date: '2026-11-20', source: 'notes', title: 'Rent', text: 'Rent to DE89 3704 0044 0532 0130 00 <b>monthly</b>',
      chunks: ['Rent to DE89 3704 0044 0532 0130 00 <b>monthly</b>'] });
    const rec = (await call(srv, 'recall', { question: 'where does the rent go' })).structuredContent;
    const passage = rec.passages[0].text;
    assert.match(passage, /Rent to ⟦IBAN 1⟧/);
    const r = (await call(srv, 'show_to_owner', { text: `Your rent goes to ⟦IBAN 1⟧. ${passage}` })).structuredContent;
    assert.match(r.link, /^http:\/\/127\.0\.0\.1:\d+\/r\/[0-9a-f]{32}$/);
    assert.doesNotMatch(JSON.stringify(r), /DE89/);
    const page = await get(r.link);
    assert.equal(page.status, 200);
    assert.match(page.body, /<mark title="⟦IBAN 1⟧">DE89 3704 0044 0532 0130 00<\/mark>/);
    assert.match(page.body, /&lt;b&gt;monthly/); // text is escaped, never rendered as markup
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.match(page.headers['content-security-policy'], /default-src 'none'/);
    // a page asked for under another host name (DNS rebinding) or with a wrong code shows nothing
    assert.equal((await get(r.link, 'evil.example:80')).status, 404);
    assert.equal((await get(r.link.replace(/[0-9a-f]{32}$/, '0'.repeat(32)))).status, 404);
  } finally { await srv.close(); store.close(); }
});

test('links expire after an hour', async () => {
  let t = 0;
  const page = await startRevealPage(s => s, { now: () => t });
  try {
    const link = await page.publish('hello');
    assert.equal((await get(link)).status, 200);
    t += 61 * 60 * 1000;
    assert.equal((await get(link)).status, 404);
  } finally { page.close(); }
});

test('recall finds a real value the owner types under its stand-in, and the instructions explain stand-ins', async () => {
  const store = open();
  const srv = new McpServer(store);
  try {
    store.addItem({ id: 'c', date: '2026-11-20', source: 'notes', title: 'Card', text: 'The shared Visa 4539 1488 0343 6467 is for groceries',
      chunks: ['The shared Visa 4539 1488 0343 6467 is for groceries'] });
    const rec = (await call(srv, 'recall', { question: 'what is 4539 1488 0343 6467 for' })).structuredContent;
    assert.match(rec.passages[0]?.text ?? '', /Visa ⟦card number 1⟧ is for groceries/);
    assert.match(INSTRUCTIONS, /show_to_owner/);
    assert.match(INSTRUCTIONS, /never guess or reconstruct a value/);
    const noPage = await call(srv, 'show_to_owner', { text: 'x' });
    assert.equal(noPage.isError, true);
  } finally { await srv.close(); store.close(); }
});

test('export --plain writes stand-ins; with --reveal, the real values (a folder on this computer only)', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { main } = await import('../src/cli.ts');
  const root = mkdtempSync(join(tmpdir(), 'synalla-export-'));
  try {
    const notes = join(root, 'notes'); mkdirSync(notes);
    writeFileSync(join(notes, 'rent.md'), '# Rent\nRent goes to DE89 3704 0044 0532 0130 00 from January.');
    const e = { home: join(root, 'home'), keychain: (() => { const m = new Map(); return { kind: 't', get: n => m.get(n) ?? null, set: (n, v) => m.set(n, v), delete: n => m.delete(n) }; })(),
      out: s => e.o.push(s), err: s => e.r.push(s), o: [], r: [], readStdin: async () => '', now: () => new Date('2026-11-28T10:00:00Z'), openclawDir: join(root, 'oc') };
    assert.equal(await main(['init', '--no-embed'], e), 0);
    assert.equal(await main(['import-notes', notes], e), 0);
    const all = dir => { const out = []; const walk = d => { for (const f of readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(join(d, f.name)) : f.name.endsWith('.md') && f.name !== 'README.md' && out.push(readFileSync(join(d, f.name), 'utf8')); }; walk(dir); return out.join('\n'); };
    assert.equal(await main(['export', '--plain', join(root, 'a')], e), 0);
    assert.match(all(join(root, 'a')), /Rent goes to ⟦IBAN 1⟧/);
    assert.match(e.o.join(''), /add --reveal for the real values/);
    assert.equal(await main(['export', '--plain', join(root, 'b'), '--reveal'], e), 0);
    assert.match(all(join(root, 'b')), /Rent goes to DE89 3704 0044 0532 0130 00/);
    assert.doesNotMatch(all(join(root, 'b')), /⟦IBAN/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
