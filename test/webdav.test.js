// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { webdavTarget, backup, restore } from '../src/backup.ts';
import { MemoryStore } from '../src/store.ts';

// A minimal WebDAV server: folders must exist before PUT (409 otherwise), like Koofr and Nextcloud.
function davServer({ user = 'u', pass = 'app-pass' } = {}) {
  const files = new Map(), dirs = new Set(['/dav/']);
  const parent = p => p.replace(/[^/]+\/?$/, '');
  const server = createServer((req, res) => {
    if (req.headers.authorization !== 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')) { res.writeHead(401).end(); return; }
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const body = []; req.on('data', d => body.push(d)); req.on('end', () => {
      if (req.method === 'MKCOL') { if (dirs.has(p)) return res.writeHead(405).end(); if (!dirs.has(parent(p))) return res.writeHead(409).end(); dirs.add(p); return res.writeHead(201).end(); }
      if (req.method === 'PUT') { if (!dirs.has(parent(p))) return res.writeHead(409).end(); files.set(p, Buffer.concat(body)); return res.writeHead(201).end(); }
      if (req.method === 'GET') { if (!files.has(p)) return res.writeHead(404).end(); return res.writeHead(200).end(files.get(p)); }
      if (req.method === 'DELETE') { if (!files.delete(p)) return res.writeHead(404).end(); return res.writeHead(204).end(); }
      if (req.method === 'PROPFIND') {
        if (!dirs.has(p)) return res.writeHead(404).end();
        const kids = [...files.keys(), ...dirs].filter(k => k !== p && parent(k) === p);
        const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${encodeURI(p)}</d:href></d:response>`
          + kids.map(k => `<d:response><d:href>${encodeURI(k)}</d:href></d:response>`).join('') + '</d:multistatus>';
        return res.writeHead(207, { 'content-type': 'application/xml' }).end(xml);
      }
      res.writeHead(405).end();
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, files, url: `http://127.0.0.1:${server.address().port}/dav/Backups` })));
}

test('WebDAV: folders created on demand, list/get/put/delete, a full backup and restore', async () => {
  const { server, files, url } = await davServer();
  const dir = mkdtempSync(join(tmpdir(), 'synalla-dav-'));
  try {
    const t = webdavTarget({ url, user: 'u', password: 'app-pass' });
    assert.deepEqual(await t.list('synalla-memory/pieces/'), []);
    assert.equal(await t.get('synalla-memory/pieces/none'), null);
    await t.put('synalla-memory/pieces/a b', new Uint8Array([1, 2]));
    assert.deepEqual([...(await t.get('synalla-memory/pieces/a b'))], [1, 2]);
    assert.deepEqual(await t.list('synalla-memory/pieces/'), ['synalla-memory/pieces/a b']);
    await t.delete('synalla-memory/pieces/a b'); await t.delete('synalla-memory/pieces/a b');
    assert.equal(files.size, 0);

    const key = new Uint8Array(randomBytes(32)), b = new Uint8Array(randomBytes(32));
    const store = MemoryStore.open(join(dir, 'm.db'), { key, dim: 4 });
    store.addItem({ id: 'n', date: '', source: 'notes', chunks: ['Koofr keeps this safe'] });
    const r = await backup(store, key, b, t);
    store.close();
    assert.ok(r.uploaded >= 1);
    const got = await restore(t, b, join(dir, 'back.db'));
    const back = MemoryStore.open(join(dir, 'back.db'), { key: got.key, dim: got.dim });
    assert.equal(back.keywordSearch('koofr').length, 1);
    back.close();
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('WebDAV: a wrong app password says so; plain http is refused except on localhost', async () => {
  const { server, url } = await davServer();
  try {
    const t = webdavTarget({ url, user: 'u', password: 'wrong' });
    await assert.rejects(t.put('x/y', new Uint8Array([1])), /401 \(check the app password\)/);
    assert.throws(() => webdavTarget({ url: 'http://example.com/dav', user: 'u', password: 'p' }), /https/);
    await assert.rejects(webdavTarget({ url, user: 'u', password: 'p' }).get('../etc'), TypeError);
  } finally { server.close(); }
});
