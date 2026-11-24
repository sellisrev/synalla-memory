// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { McpServer, serveStdio } from '../src/mcp.ts';
import { httpEmbedder, QUERY_INSTRUCT } from '../src/embed.ts';
import { MemoryStore } from '../src/store.ts';

const DIM = 4;
const NOW = () => new Date('2026-11-24T10:00:00.000Z');
const store = () => MemoryStore.open(':memory:', { key: new Uint8Array(randomBytes(32)), dim: DIM });
// A fake embedder: one axis per topic word, so vector search is predictable.
const fake = { dim: DIM, calls: [], async embed(texts, kind) {
  this.calls.push(kind);
  return texts.map(t => Float32Array.from(['landlord', 'keyboard', 'mamie', 'weather'].map(w => (t.toLowerCase().includes(w) ? 1 : 0.01))));
} };
const call = (name, args, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

test('initialize negotiates the protocol version and lists the tools', async () => {
  const s = new McpServer(store(), { now: NOW });
  const init = await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.equal(init.result.serverInfo.name, 'synalla-memory');
  const unknown = await s.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(unknown.result.protocolVersion, '2025-06-18');
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await s.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map(t => t.name), ['recall', 'remember']);
  assert.deepEqual(await s.handle({ jsonrpc: '2.0', id: 4, method: 'ping' }), { jsonrpc: '2.0', id: 4, result: {} });
});

test('remember stores scrubbed text with vectors; recall returns untrusted structured passages', async () => {
  const st = store(); fake.calls = [];
  const s = new McpServer(st, { embedder: fake, now: NOW });
  const secret = 'ghp_' + 'a1B2'.repeat(9);
  const r = await s.handle(call('remember', { text: `My landlord is Frau Kerschbaumer. Token ${secret}`, title: 'Flat' }));
  assert.equal(r.result.structuredContent.chunks, 1);
  assert.match(r.result.structuredContent.stored, /^remember:2026-11-24T10:00:00\.000Z:[0-9a-f]{8}$/);
  await s.handle(call('remember', { text: 'The keyboard is a Logitech Wave Keys.' }));
  assert.deepEqual(st.stats().vectors, 2);
  const rec = await s.handle(call('recall', { question: 'Who is my landlord?' }));
  const { mode, passages } = rec.result.structuredContent;
  assert.equal(mode, 'keyword+vector');
  assert.equal(passages[0].untrusted, true);
  assert.equal(passages[0].source, 'remember');
  assert.match(passages[0].text, /^\[2026-11-24\] remember \| Flat\nMy landlord is Frau Kerschbaumer\./);
  assert.equal(passages[0].text.includes(secret), false);
  assert.deepEqual(JSON.parse(rec.result.content[0].text), rec.result.structuredContent);
  assert.deepEqual(fake.calls, ['passage', 'passage', 'query']);
});

test('without an embedder recall falls back to keyword search', async () => {
  const st = store();
  st.addItem({ id: 'n', date: '2026-01-01', source: 'notes', title: '', chunks: ['Mamie lives in Lyon'] });
  const s = new McpServer(st);
  const r = await s.handle(call('recall', { question: 'Where does Mamie live?', limit: 3 }));
  assert.equal(r.result.structuredContent.mode, 'keyword');
  assert.equal(r.result.structuredContent.passages.length, 1);
});

test('bad tool input is a tool error, not a protocol error; unknown methods and bad requests are protocol errors', async () => {
  const s = new McpServer(store());
  for (const [name, args] of [['recall', {}], ['recall', { question: 'x', limit: 0 }], ['remember', { text: ' ' }], ['remember', { text: 'x', title: 5 }], ['nope', {}]]) {
    const r = await s.handle(call(name, args));
    assert.equal(r.result.isError, true, name);
  }
  assert.equal((await s.handle({ jsonrpc: '2.0', id: 9, method: 'resources/list' })).error.code, -32601);
  assert.equal((await s.handle({ id: 9, method: 'x' })).error.code, -32600);
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'unknown/notification' }), null);
});

test('stdio: one JSON message per line in, one per line out; parse errors answered', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const chunks = []; output.on('data', d => chunks.push(d.toString()));
  const done = serveStdio(new McpServer(store()), input, output);
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
  input.write('not json\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  input.end(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  await done;
  const lines = chunks.join('').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines.map(l => l.id), [1, null, 2]);
  assert.equal(lines[1].error.code, -32700);
});

test('httpEmbedder: query prefix, batching, order by index, and size checks', async () => {
  const seen = [];
  const f = async (url, init) => {
    const { input } = JSON.parse(init.body); seen.push({ url: String(url), input });
    const data = input.map((t, i) => ({ index: i, embedding: [i, 0, 0, t.length] })).reverse();
    return { ok: true, json: async () => ({ data }) };
  };
  const e = httpEmbedder({ url: 'http://127.0.0.1:5941', dim: 4, batch: 2, fetch: f });
  const v = await e.embed(['a', 'bb', 'ccc'], 'passage');
  assert.deepEqual(v.map(x => [...x]), [[0, 0, 0, 1], [1, 0, 0, 2], [0, 0, 0, 3]]);
  assert.equal(seen.length, 2); assert.equal(seen[0].url, 'http://127.0.0.1:5941/v1/embeddings');
  await e.embed(['q'], 'query');
  assert.equal(seen[2].input[0], QUERY_INSTRUCT + 'q');
  const bad = httpEmbedder({ url: 'http://x', dim: 3, fetch: f });
  await assert.rejects(bad.embed(['a'], 'passage'), /not 3 numbers/);
  const down = httpEmbedder({ url: 'http://x', dim: 4, fetch: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(down.embed(['a'], 'passage'), /503/);
  assert.throws(() => httpEmbedder({ url: 'file:///x', dim: 4 }), TypeError);
});
