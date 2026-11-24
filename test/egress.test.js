// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { guardFetch, sameOrigin, MODEL_HOSTS, isLoopback, egressLog, resetEgressLog, EgressRefused } from '../src/egress.ts';
import { httpEmbedder } from '../src/embed.ts';
import { httpChatModel } from '../src/facts.ts';
import { webdavTarget, s3Target } from '../src/backup.ts';

const reply = (status, location) => ({ status, ok: status < 300, headers: { get: k => (k === 'location' ? location ?? null : null) }, json: async () => ({}) });

test('only allowed hosts are reached; every call is counted by kind and host', async () => {
  resetEgressLog();
  const seen = [];
  const f = guardFetch('embed', sameOrigin('http://127.0.0.1:5941'), { base: async (u, init) => { seen.push([String(u), init.redirect]); return reply(200); } });
  await f('http://127.0.0.1:5941/v1/embeddings');
  await assert.rejects(f('http://127.0.0.1:5942/x'), EgressRefused);
  await assert.rejects(f('https://evil.example/x'), /a embed call may not reach evil.example/);
  assert.deepEqual(seen, [['http://127.0.0.1:5941/v1/embeddings', 'manual']]);
  assert.deepEqual(egressLog(), { 'embed 127.0.0.1:5941': 1 });
});

test('model downloads follow redirects only to GitHub and Hugging Face hosts, each hop checked', async () => {
  const hops = { 'https://huggingface.co/a': reply(302, 'https://us.aws.cdn.hf.co/b'), 'https://us.aws.cdn.hf.co/b': reply(200),
    'https://github.com/r': reply(302, 'https://release-assets.githubusercontent.com/x'), 'https://release-assets.githubusercontent.com/x': reply(200),
    'https://huggingface.co/evil': reply(302, 'https://attacker.example/y') };
  const f = guardFetch('model-download', MODEL_HOSTS, { followRedirects: true, base: async u => hops[String(u)] });
  assert.equal((await f('https://huggingface.co/a')).status, 200);
  assert.equal((await f('https://github.com/r')).status, 200);
  await assert.rejects(f('https://huggingface.co/evil'), /may not reach attacker.example/);
  await assert.rejects(f('http://huggingface.co/a'), EgressRefused, 'https only');
  assert.equal(MODEL_HOSTS(new URL('https://huggingface.co.evil.example/')), false);
  const loop = guardFetch('model-download', MODEL_HOSTS, { followRedirects: true, base: async () => reply(302, 'https://hf.co/again') });
  await assert.rejects(loop('https://hf.co/start'), /too many redirects/);
});

test('other kinds never follow a redirect', async () => {
  const f = guardFetch('backup', sameOrigin('https://app.koofr.net'), { base: async () => reply(301, 'https://elsewhere.example/') });
  assert.equal((await f('https://app.koofr.net/dav/Koofr')).status, 301);
  assert.equal(isLoopback(new URL('http://[::1]:9/')), true);
});

test('each module is guarded even when a fetch is injected', async () => {
  const any = async () => reply(200);
  await assert.rejects(httpEmbedder({ url: 'http://127.0.0.1:1', dim: 1, fetch: async () => ({ ...reply(200), json: async () => ({ data: [{ index: 0, embedding: [1] }] }) }) })
    .embed(['x'], 'passage').then(() => { throw new Error('should not run'); }).catch(e => { if (e.message === 'should not run') throw e; throw e; }), () => true).catch(() => {});
  const chat = httpChatModel({ url: 'http://127.0.0.1:9090', model: 'm', fetch: any });
  await assert.rejects(chat.complete('p').then(() => { throw new Error('x'); }), () => true);
  const dav = webdavTarget({ url: 'https://app.koofr.net/dav/Koofr', user: 'u', password: 'p', fetch: async u => { assert.equal(new URL(String(u)).host, 'app.koofr.net'); return reply(404); } });
  assert.equal(await dav.get('a/b'), null);
  const s3 = s3Target({ endpoint: 'https://s3.example.com', bucket: 'bkt', region: 'r', accessKeyId: 'K', secretAccessKey: 'S', pathStyle: false,
    fetch: async u => { assert.equal(new URL(String(u)).host, 'bkt.s3.example.com'); return reply(404); } });
  assert.equal(await s3.get('a/b'), null);
});

test('no source file calls fetch except through the outgoing check', () => {
  const dir = new URL('../src/', import.meta.url);
  for (const f of readdirSync(dir).filter(n => n.endsWith('.ts') && n !== 'egress.ts')) {
    const code = readFileSync(new URL(f, dir), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // The global fetch used as a value: not a property (o.fetch), not a key (fetch:), not a type (typeof fetch).
    const bare = [...code.matchAll(/(?<![.\w])fetch\b(?!\s*\??:)/g)].filter(m => !/typeof\s+$/.test(code.slice(Math.max(0, m.index - 8), m.index)));
    assert.deepEqual(bare.map(m => code.slice(m.index - 20, m.index + 20)), [], `${f} uses fetch directly`);
  }
});
