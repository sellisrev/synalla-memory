// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { MemoryStore } from '../src/store.ts';
import { checkWants, scanWants, matchWants, wantsPrompt, TOPICS, WANT_THRESHOLD } from '../src/wants.ts';

const open = () => MemoryStore.open(':memory:', { key: new Uint8Array(randomBytes(32)), dim: 4 });
const reply = (o) => JSON.stringify({ new: [], met: [], ...o });

test('checkWants keeps only quoted wants with a known topic and a confidence in range', () => {
  const text = 'I still need a babysitter for Saturday. My sister needs a van.';
  const r = checkWants(reply({ new: [
    { what: 'a babysitter for Saturday', topic: 'babysitting', confidence: 0.95, quote: 'need a  Babysitter for saturday' },
    { what: 'a van', topic: 'moving-help', confidence: 0.4, quote: 'not in the text' },
    { what: 'x', topic: 'not-a-topic', confidence: 0.9, quote: 'I still need' },
    { what: 'y', topic: 'babysitting', confidence: 1.5, quote: 'I still need' },
  ] }), text, new Set());
  assert.deepEqual(r.opened.map(w => w.topic), ['babysitting']);
  assert.equal(r.dropped, 3);
  assert.throws(() => checkWants('not json', text, new Set()), /not JSON/);
  assert.throws(() => checkWants('{"new": []}', text, new Set()), /"met"/);
});

test('checkWants closes only wants that are open, with a quote from the record', () => {
  const r = checkWants(reply({ met: [{ id: 3, quote: 'booked Léa' }, { id: 9, quote: 'booked Léa' }, { id: 3, quote: 'nowhere' }] }),
    'Good news: booked Léa for Saturday.', new Set([3]));
  assert.deepEqual(r.met, [{ wid: 3, quote: 'booked Léa' }]);
  assert.equal(r.dropped, 2);
});

test('scanWants opens a want on the day it comes up and closes it on the day it is met, in date order', async () => {
  const s = open();
  s.addItem({ id: 'b', date: '2026-03-10', source: 'notes', chunks: ['x'], text: 'Booked Léa Martin for Saturday, sorted.' });
  s.addItem({ id: 'a', date: '2026-03-02', source: 'notes', chunks: ['x'], text: 'I need a babysitter for Saturday 21 March.' });
  const prompts = [];
  const model = { async complete(p) {
    prompts.push(p);
    if (p.includes('I need a babysitter')) return reply({ new: [{ what: 'a babysitter for 21 March', topic: 'babysitting', confidence: 0.95, quote: 'I need a babysitter' }] });
    const id = Number(/id (\d+): a babysitter/.exec(p)[1]);
    return reply({ met: [{ id, quote: 'Booked Léa Martin' }] });
  } };
  const r = await scanWants(s, model, 'Claire');
  assert.deepEqual(r, { items: 2, opened: 1, met: 1, failed: 0 });
  assert.match(prompts[0], /- \(none\)/, 'first item: no open wants yet');
  assert.match(prompts[1], /id \d+: a babysitter for 21 March/, 'the second item sees the open want');
  const [w] = s.allWants();
  assert.equal(w.opened_at, '2026-03-02');
  assert.equal(w.closed_at, '2026-03-10');
  assert.equal(w.closed_by, 'b');
  assert.deepEqual(s.openWants(), []);
  assert.deepEqual(s.pendingWantScan(10), [], 'every item read once');
  s.close();
});

test('scanWants skips agent sessions unless asked, and records an item whose every window failed', async () => {
  const s = open();
  s.addItem({ id: 'cc', date: '2026-03-02', source: 'claude-code', chunks: ['x'], text: 'I need a lift to the airport.' });
  s.addItem({ id: 'm', date: '2026-03-03', source: 'mail', chunks: ['x'], text: 'hello' });
  const bad = { async complete() { throw new Error('model down'); } };
  const r = await scanWants(s, bad, 'Claire');
  assert.deepEqual(r, { items: 0, opened: 0, met: 0, failed: 1 });
  assert.deepEqual(s.pendingWantScan(10).map(i => i.id), [], 'without agentSessions the session is not pending');
  assert.deepEqual(s.pendingWantScan(10, { agentSessions: true }).map(i => i.id), ['cc']);
  s.close();
});

test('matchWants: same topic, not expired, same place; below the threshold nothing is proposed', () => {
  const w = (o) => ({ wid: 1, item: 'a', what: 'a babysitter', topic: 'babysitting', confidence: 0.95, quote: 'q', opened_at: '2026-03-02', closed_at: null, closed_by: null, closed_quote: null, ...o });
  const e = (id, o = {}) => ({ id, type: 'help', topic: 'babysitting', tags: ['lyon'], text: 't', expires: 2000, ...o });
  const entries = [e('z'), e('a'), e('old', { expires: 500 }), e('far', { tags: ['leeds'] }), e('near', { topic: 'childcare' })];
  assert.deepEqual(matchWants([w()], entries, 1000, { place: ['lyon'] }), [{ wid: 1, entries: [entries[1], entries[0]] }]);
  assert.deepEqual(matchWants([w({ confidence: WANT_THRESHOLD - 0.01 })], entries, 1000, { place: ['lyon'] }), []);
  assert.deepEqual(matchWants([w({ closed_at: '2026-03-10' })], entries, 1000, { place: ['lyon'] }), []);
  assert.equal(matchWants([w()], entries, 1000)[0].entries.length, 3, 'without a place, every city matches');
});

test('the prompt lists the open wants by id and the whole topic list', () => {
  const p = wantsPrompt('Claire', [{ wid: 7, what: 'a physio' }]);
  assert.match(p, /- id 7: a physio/);
  for (const t of TOPICS) assert.ok(p.includes(t));
});
