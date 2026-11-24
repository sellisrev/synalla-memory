// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuse, ftsQuery, DEFAULT_TOP, RRF_K } from '../src/fusion.ts';

test('defaults match the measured CPU setting', () => {
  assert.equal(DEFAULT_TOP, 25);
  assert.equal(RRF_K, 60);
});

test('fuse: an id in both lists beats ids in one; ranks matter', () => {
  // 3: 1/62 + 1/60; 1: 1/60; 2 and 4: 1/61 each, so 2 (seen first) comes before 4. Same as answer.py.
  assert.deepEqual(fuse([[1, 2, 3], [3, 4]]), [3, 1, 2, 4]);
  assert.deepEqual(fuse([[1, 2], [3, 2]]), [2, 1, 3]);
});

test('fuse: ties keep first-seen order, keyword list first', () => {
  assert.deepEqual(fuse([[10, 20], [30, 40]]), [10, 30, 20, 40]);
});

test('fuse: top cuts the list; duplicates in one list count once; empty input', () => {
  assert.deepEqual(fuse([[1, 2, 3, 4]], 2), [1, 2]);
  assert.deepEqual(fuse([[5, 5, 6], [6]]), [6, 5]);
  assert.deepEqual(fuse([]), []);
  assert.deepEqual(fuse([[], []]), []);
});

test('fuse: matches the Python harness (answer.py) on a fixed example', () => {
  const bm = [7, 3, 9, 1], vec = [3, 8, 7, 2];
  // answer.py: score[rid] += 1 / (60 + rank) over both lists, sorted by score descending (stable).
  assert.deepEqual(fuse([bm, vec], 25), [3, 7, 8, 9, 1, 2]);
});

test('fuse: bad input throws', () => {
  for (const bad of [null, 'x', [[1.5]], [['1']], [1]]) assert.throws(() => fuse(bad), TypeError);
  assert.throws(() => fuse([[1]], 0), TypeError);
  assert.throws(() => fuse([[1]], 1.5), TypeError);
  assert.throws(() => fuse([[1]], 5, -1), TypeError);
});

test('ftsQuery: words of 3+ letters, stop words dropped, quoted and OR-ed, at most 20', () => {
  assert.equal(ftsQuery('What is the name of my landlord?'), '"name" OR "landlord"');
  assert.equal(ftsQuery('Où habite Mamie ?'), '"habite" OR "mamie"');
  assert.equal(ftsQuery('a an is'), '"the"');
  assert.equal(ftsQuery('word word Word'), '"word"');
  const many = Array.from({ length: 30 }, (_, i) => 'term' + i).join(' ');
  assert.equal(ftsQuery(many).split(' OR ').length, 20);
  assert.throws(() => ftsQuery(null), TypeError);
});
