// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { MemoryStore, quantize } from '../src/store.ts';

const DIM = 8;
const key = () => new Uint8Array(randomBytes(32));
const v = (...xs) => { const a = new Float32Array(DIM); xs.forEach((x, i) => { a[i] = x; }); return a; };
function tmp() { const d = mkdtempSync(join(tmpdir(), 'synalla-store-')); return { dir: d, path: join(d, 'memory.db'), done: () => rmSync(d, { recursive: true, force: true }) }; }

test('the file on disk is encrypted; the right key reopens it, a wrong key is refused', () => {
  const t = tmp(), k = key();
  try {
    const s = MemoryStore.open(t.path, { key: k, dim: DIM });
    s.addItem({ id: 'mail:1', date: '2026-11-20', source: 'mail', title: 'Landlord', chunks: ['The landlord is called Frau Kerschbaumer'] });
    s.close();
    for (const f of readdirSync(t.dir)) {
      const bytes = readFileSync(join(t.dir, f));
      assert.equal(bytes.includes(Buffer.from('Kerschbaumer')), false, `${f} leaks plaintext`);
      assert.equal(bytes.includes(Buffer.from('SQLite format 3')), false, `${f} has a plain SQLite header`);
    }
    const again = MemoryStore.open(t.path, { key: k, dim: DIM });
    assert.deepEqual(again.keywordSearch('who is the landlord'), [1]);
    again.close();
    assert.throws(() => MemoryStore.open(t.path, { key: key(), dim: DIM }), /wrong key/);
    assert.throws(() => MemoryStore.open(t.path, { key: k, dim: DIM + 1 }), RangeError);
  } finally { t.done(); }
});

test('secrets are scrubbed before they are stored', () => {
  const s = MemoryStore.open(':memory:', { key: key(), dim: DIM });
  const secret = 'sk-ant-api03-' + 'A'.repeat(40);
  const [cid] = s.addItem({ id: 'cc:1', date: '', source: 'claude-code', chunks: [`use key ${secret} for the call`] });
  const text = s.chunks([cid])[0].text;
  assert.equal(text.includes(secret), false);
  assert.match(text, /use key .+ for the call/);
  assert.deepEqual(s.keywordSearch('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), []);
  s.close();
});

test('keyword search ranks by BM25 and ignores accents and case', () => {
  const s = MemoryStore.open(':memory:', { key: key(), dim: DIM });
  s.addItem({ id: 'a', date: '', source: 'notes', chunks: ['Cours de français pour les tout-petits', 'unrelated text about cars'] });
  s.addItem({ id: 'b', date: '', source: 'notes', chunks: ['francais francais francais lessons'] });
  assert.deepEqual(s.keywordSearch('FRANÇAIS'), [3, 1]);
  assert.deepEqual(s.keywordSearch('the a an'), []);
  s.close();
});

test('vector search: cosine order on the int8 cache, ties by lower id, survives reopen', () => {
  const t = tmp(), k = key();
  try {
    const s = MemoryStore.open(t.path, { key: k, dim: DIM });
    const ids = s.addItem({ id: 'x', date: '', source: 'notes', chunks: ['one', 'two', 'three', 'four'] });
    s.setVectors([{ cid: ids[0], vec: v(1, 0) }, { cid: ids[1], vec: v(0, 1) }, { cid: ids[2], vec: v(5, 5) }, { cid: ids[3], vec: v(2, 0) }]);
    assert.deepEqual(s.vectorSearch(v(1, 0.01)), [1, 4, 3, 2]);
    assert.deepEqual(s.vectorSearch(v(1, 0), 2), [1, 4], 'equal cosine: lower id first');
    assert.deepEqual(s.stats(), { items: 1, chunks: 4, vectors: 4 });
    s.close();
    const r = MemoryStore.open(t.path, { key: k, dim: DIM });
    assert.deepEqual(r.vectorSearch(v(1, 0.01)), [1, 4, 3, 2]);
    r.close();
  } finally { t.done(); }
});

test('setVectors: replacing a vector updates the cache; bad sizes and unknown chunks throw', () => {
  const s = MemoryStore.open(':memory:', { key: key(), dim: DIM });
  const [a, b] = s.addItem({ id: 'x', date: '', source: 'n', chunks: ['a', 'b'] });
  s.setVectors([{ cid: a, vec: v(1) }, { cid: b, vec: v(0, 1) }]);
  s.setVectors([{ cid: a, vec: v(0, 1) }, { cid: b, vec: v(1) }]);
  assert.deepEqual(s.vectorSearch(v(1)), [b, a]);
  assert.throws(() => s.setVectors([{ cid: a, vec: new Float32Array(3) }]), TypeError);
  assert.throws(() => s.setVectors([{ cid: 999, vec: v(1) }]), RangeError);
  assert.deepEqual(s.missingVectors(), []);
  s.close();
});

test('search fuses keyword and vector results (the CPU default)', () => {
  const s = MemoryStore.open(':memory:', { key: key(), dim: DIM });
  const ids = s.addItem({ id: 'x', date: '', source: 'n', chunks: ['landlord rent payment', 'apartment owner contact', 'weather today'] });
  s.setVectors([{ cid: ids[0], vec: v(0, 1) }, { cid: ids[1], vec: v(1) }, { cid: ids[2], vec: v(0, 0, 1) }]);
  // keyword: [1]; vector: [2, 1, 3]  -> 1 is in both lists
  assert.deepEqual(s.search('landlord', v(1)), [1, 2, 3]);
  assert.deepEqual(s.search('landlord', v(1), 1), [1]);
  s.close();
});

test('replacing and deleting items removes their chunks from keyword and vector search', () => {
  const s = MemoryStore.open(':memory:', { key: key(), dim: DIM });
  const [a] = s.addItem({ id: 'x', date: '', source: 'n', chunks: ['old landlord'] });
  const [b] = s.addItem({ id: 'y', date: '', source: 'n', chunks: ['other'] });
  s.setVectors([{ cid: a, vec: v(1) }, { cid: b, vec: v(0, 1) }]);
  const [c] = s.addItem({ id: 'x', date: '', source: 'n', chunks: ['new tenant'] });
  assert.deepEqual(s.keywordSearch('landlord'), []);
  assert.deepEqual(s.keywordSearch('tenant'), [c]);
  assert.deepEqual(s.vectorSearch(v(1)), [b]);
  assert.deepEqual(s.missingVectors(), [{ cid: c, text: 'new tenant' }]);
  assert.equal(s.deleteItem('y'), true);
  assert.equal(s.deleteItem('y'), false);
  assert.deepEqual(s.vectorSearch(v(1)), []);
  assert.deepEqual(s.chunks([c, 12345, b]).map(r => r.text), ['new tenant']);
  s.close();
});

test('quantize: unit length scaled to 127, zero vector stays zero', () => {
  assert.deepEqual([...quantize(new Float32Array([3, 4]))], [76, 102]);
  assert.deepEqual([...quantize(new Float32Array([0, 0]))], [0, 0]);
});

test('bad input throws', () => {
  assert.throws(() => MemoryStore.open(':memory:', { key: new Uint8Array(16), dim: DIM }), TypeError);
  assert.throws(() => MemoryStore.open(':memory:', { key: key(), dim: 0 }), TypeError);
  const s = MemoryStore.open(':memory:', { key: key(), dim: DIM });
  assert.throws(() => s.addItem({ id: '', date: '', source: '', chunks: [] }), TypeError);
  assert.throws(() => s.addItem({ id: 'a', date: '', source: '', chunks: [1] }), TypeError);
  assert.throws(() => s.vectorSearch(new Float32Array(2)), TypeError);
  s.close();
});
