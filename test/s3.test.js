// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { signS3, s3Target, backup, restore } from '../src/backup.ts';
import { MemoryStore } from '../src/store.ts';

// AWS's worked examples for Signature Version 4 in the S3 API reference ("Examples: Signature Calculations").
const EX = { region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', date: new Date('2013-05-24T00:00:00Z') };
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

test('SigV4 matches the AWS example: GET Object', () => {
  const h = signS3({ ...EX, method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', headers: { Range: 'bytes=0-9' }, payloadHash: EMPTY });
  assert.equal(h.authorization, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
    + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('SigV4 matches the AWS example: GET Bucket (list objects)', () => {
  const h = signS3({ ...EX, method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/', query: [['max-keys', '2'], ['prefix', 'J']], payloadHash: EMPTY });
  assert.match(h.authorization, /Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/);
});

function fakeS3() {
  const objects = new Map();
  const server = createServer((req, res) => {
    if (!/^AWS4-HMAC-SHA256 Credential=K\//.test(req.headers.authorization ?? '')) { res.writeHead(403).end(); return; }
    const u = new URL(req.url, 'http://x');
    const body = []; req.on('data', d => body.push(d)); req.on('end', () => {
      const key = decodeURIComponent(u.pathname.replace(/^\/bkt\/?/, ''));
      if (req.method === 'GET' && u.searchParams.get('list-type') === '2') {
        const p = u.searchParams.get('prefix') ?? '';
        const keys = [...objects.keys()].filter(k => k.startsWith(p) && !k.slice(p.length).includes('/')).sort();
        // Two keys per page, to exercise continuation.
        const start = Number(u.searchParams.get('continuation-token') ?? 0), page = keys.slice(start, start + 2);
        const more = start + 2 < keys.length;
        return res.writeHead(200).end(`<ListBucketResult>${page.map(k => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key></Contents>`).join('')}`
          + `<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ''}</ListBucketResult>`);
      }
      if (req.method === 'PUT') { objects.set(key, Buffer.concat(body)); return res.writeHead(200).end(); }
      if (req.method === 'GET') return objects.has(key) ? res.writeHead(200).end(objects.get(key)) : res.writeHead(404).end();
      if (req.method === 'DELETE') { objects.delete(key); return res.writeHead(204).end(); }
      res.writeHead(405).end();
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, objects, endpoint: `http://127.0.0.1:${server.address().port}` })));
}

test('S3 target: put/get/list with continuation/delete, and a full backup and restore', async () => {
  const { server, objects, endpoint } = await fakeS3();
  const dir = mkdtempSync(join(tmpdir(), 'synalla-s3-'));
  try {
    const t = s3Target({ endpoint, bucket: 'bkt', region: 'eu-central-003', accessKeyId: 'K', secretAccessKey: 'S' });
    for (const n of ['a', 'b&c', 'd', 'e']) await t.put(`x/${n}`, new Uint8Array([1]));
    await t.put('x/sub/deep', new Uint8Array([2]));
    assert.deepEqual(await t.list('x/'), ['x/a', 'x/b&c', 'x/d', 'x/e']);
    assert.equal(await t.get('x/none'), null);
    await t.delete('x/a');
    assert.equal(objects.has('x/a'), false);
    const key = new Uint8Array(randomBytes(32)), b = new Uint8Array(randomBytes(32));
    const store = MemoryStore.open(join(dir, 'm.db'), { key, dim: 4 });
    store.addItem({ id: 'n', date: '', source: 'notes', chunks: ['kept in S3'] });
    await backup(store, key, b, t);
    store.close();
    const got = await restore(t, b, join(dir, 'back.db'));
    const back = MemoryStore.open(join(dir, 'back.db'), { key: got.key, dim: 4 });
    assert.equal(back.keywordSearch('kept').length, 1);
    back.close();
    const bad = s3Target({ endpoint, bucket: 'bkt', region: 'r', accessKeyId: 'nope', secretAccessKey: 'S' });
    await assert.rejects(bad.put('x/y', new Uint8Array([1])), /403/);
    assert.throws(() => s3Target({ endpoint: 'http://example.com', bucket: 'bkt', region: 'r', accessKeyId: 'K', secretAccessKey: 'S' }), /https/);
    assert.throws(() => s3Target({ endpoint, bucket: 'Bad_Bucket', region: 'r', accessKeyId: 'K', secretAccessKey: 'S' }), /bucket/);
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});
