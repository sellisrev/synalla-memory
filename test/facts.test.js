// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { MemoryStore } from '../src/store.ts';
import { checkFacts, factLine, itemText, extractionPrompt, extractPending, httpChatModel, ITEM_CHARS } from '../src/facts.ts';

const DIM = 4;
const open = () => MemoryStore.open(':memory:', { key: new Uint8Array(randomBytes(32)), dim: DIM });
const fact = (o = {}) => ({ subject: 'Anna', predicate: 'lives_in', object: 'Wien', valid_from: null, valid_to: null, mentioned_at: '2026-01-01', quote: 'q', ...o });

test('supersession matches the harness (extract.py load) on 60 random cases, 616 facts', () => {
  const cases = JSON.parse(readFileSync(new URL('./fixtures/facts/supersede_parity.json', import.meta.url), 'utf8'));
  for (const [n, c] of cases.entries()) {
    const s = open();
    for (const it of c.items) s.addItem({ id: it.id, date: it.date, source: 'notes', chunks: ['x'], text: 'x' });
    const fids = [];
    for (const it of c.items) fids.push(...s.setFacts(it.id, c.facts.filter(f => f.item === it.id)));
    const got = s.facts(fids).map(f => f.valid_to ?? f.superseded_on);
    assert.deepEqual(got, c.ends, `case ${n}`);
    s.close();
  }
});

test('re-extracting or deleting an item recomputes what its facts had superseded', () => {
  const s = open();
  s.addItem({ id: 'a', date: '2026-01-01', source: 'mail', chunks: ['x'] });
  s.addItem({ id: 'b', date: '2026-06-01', source: 'mail', chunks: ['y'] });
  const [fa] = s.setFacts('a', [fact({ valid_from: '2026-01-01' })]);
  s.setFacts('b', [fact({ object: 'Lyon', valid_from: '2026-06-01', mentioned_at: '2026-06-01' })]);
  assert.equal(s.facts([fa])[0].superseded_on, '2026-06-01');
  s.setFacts('b', [fact({ object: 'Wien', valid_from: '2026-06-01', mentioned_at: '2026-06-01' })]);
  assert.equal(s.facts([fa])[0].superseded_on, null, 'same value again: nothing superseded');
  s.setFacts('b', [fact({ object: 'Lyon', valid_from: '2026-06-01' })]);
  s.deleteItem('b');
  assert.equal(s.facts([fa])[0].superseded_on, null, 'the later fact is gone');
  assert.equal(s.stats().facts, 1);
  s.close();
});

test('pending extraction, facts search, factsAbout and changedSince', () => {
  const s = open();
  s.addItem({ id: 'a', date: '2026-01-01', source: 'mail', chunks: ['x'], text: 'Anna moved to Wien' });
  s.addItem({ id: 'b', date: '2026-06-01', source: 'mail', chunks: ['y'], text: 'Anna lives in Lyon now' });
  assert.deepEqual(s.pendingExtraction().map(i => i.id), ['a', 'b']);
  s.setFacts('a', [fact({ valid_from: '2026-01-01', quote: 'Anna moved to Wien' })]);
  s.setFacts('b', [fact({ object: 'Lyon', valid_from: '2026-06-01', mentioned_at: '2026-06-01', quote: 'lives in Lyon' }),
    fact({ subject: 'Bob', predicate: 'prefers', object: 'tea', mentioned_at: '2026-06-01', quote: 'tea' })]);
  assert.deepEqual(s.pendingExtraction(), []);
  const hits = s.facts(s.searchFacts('Where does Anna live?', null));
  assert.deepEqual(hits.map(f => f.object).sort(), ['Lyon', 'Wien']);
  assert.deepEqual(s.factsAbout(' anna ').map(f => f.object), ['Wien', 'Lyon']);
  assert.deepEqual(s.changedSince('2026-05-01').map(f => f.object).sort(), ['Lyon', 'Wien', 'tea'], 'Wien ended (superseded) in June');
  assert.deepEqual(s.changedSince('2026-07-01'), []);
  assert.deepEqual(s.missingFactVectors().map(f => f.text), ['Anna | lives_in | Wien', 'Anna | lives_in | Lyon', 'Bob | prefers | tea']);
  s.setFactVectors(s.missingFactVectors().map((f, i) => ({ fid: f.fid, vec: Float32Array.from([i === 1 ? 1 : 0, i === 1 ? 0 : 1, 0, 0]) })));
  assert.equal(s.facts(s.searchFacts('zzz', Float32Array.from([1, 0, 0, 0]), 1))[0].object, 'Lyon');
  assert.throws(() => s.setFacts('nope', []), RangeError);
  assert.throws(() => s.setFacts('a', [{ subject: 'x' }]), TypeError);
  s.close();
});

test('facts are scrubbed of secrets too', () => {
  const s = open();
  s.addItem({ id: 'a', date: '2026-01-01', source: 'mail', chunks: ['x'] });
  const key = 'sk-ant-api03-' + 'B'.repeat(40);
  const [fid] = s.setFacts('a', [fact({ subject: 'API', predicate: 'key', object: key, quote: `key is ${key}` })]);
  const f = s.facts([fid])[0];
  assert.equal(f.object.includes(key), false); assert.equal(f.quote.includes(key), false);
  s.close();
});

test('checkFacts keeps only facts whose quote is in the text; bad replies throw', () => {
  const text = itemText({ date: '2026-03-04T10:00:00Z', source: 'mail', title: 'Move', text: 'Anna  moved to WIEN in March.' });
  assert.equal(text, 'Date: 2026-03-04\nSource: mail\nTitle: Move\n\nAnna  moved to WIEN in March.');
  const reply = JSON.stringify({ facts: [fact({ quote: 'anna moved to wien' }), fact({ quote: 'invented quote' }), fact({ quote: '  ' }), { subject: 1 }] });
  const { kept, dropped } = checkFacts(reply, text);
  assert.equal(kept.length, 1); assert.equal(dropped, 3);
  assert.throws(() => checkFacts('not json', text), /not JSON/);
  assert.throws(() => checkFacts('{"x":1}', text), /no "facts"/);
  assert.equal(itemText({ date: '', source: 's', title: '', text: 'x'.repeat(ITEM_CHARS + 10) }).length, 'Date: \nSource: s\nTitle: \n\n'.length + ITEM_CHARS);
  assert.match(extractionPrompt('Maria'), /owner of these records \(Maria\)[\s\S]*RECORD\n$/);
});

test('factLine is the harness format', () => {
  assert.equal(factLine(fact({ valid_from: '2026-01-01', quote: 'Q'.repeat(250) })),
    `- Anna | lives_in | Wien (valid from 2026-01-01, current; mentioned 2026-01-01; quote: "${'Q'.repeat(200)}")`);
  assert.equal(factLine(fact({ superseded_on: '2026-06-01' })), '- Anna | lives_in | Wien (valid from ?, superseded on 2026-06-01; mentioned 2026-01-01; quote: "q")');
  assert.match(factLine(fact({ valid_to: '2026-02-01', superseded_on: '2026-06-01' })), /superseded on 2026-02-01/);
});

test('extractPending: sends prompt + item text, stores kept facts, records failures without retrying', async () => {
  const s = open();
  s.addItem({ id: 'a', date: '2026-01-01', source: 'mail', chunks: ['x'], text: 'Anna lives in Wien.' });
  s.addItem({ id: 'b', date: '2026-01-02', source: 'mail', chunks: ['y'], text: 'Broken.' });
  const prompts = [];
  const model = { async complete(p) { prompts.push(p); if (p.includes('Broken')) return 'oops'; return JSON.stringify({ facts: [fact({ quote: 'Anna lives in Wien' })] }); } };
  const r = await extractPending(s, model, 'Maria');
  assert.deepEqual(r, { items: 1, facts: 1, failed: 1 });
  assert.ok(prompts[0].startsWith(extractionPrompt('Maria') + 'Date: 2026-01-01\n'));
  assert.deepEqual(s.pendingExtraction(), []);
  assert.deepEqual(await extractPending(s, model, 'Maria'), { items: 0, facts: 0, failed: 0 });
  s.close();
});

test('httpChatModel: structured output request as measured', async () => {
  let sent;
  const m = httpChatModel({ url: 'http://127.0.0.1:9090', model: 'daily', apiKey: 'k', fetch: async (u, init) => { sent = { u: String(u), init }; return { ok: true, json: async () => ({ choices: [{ message: { content: '{"facts":[]}' } }] }) }; } });
  assert.equal(await m.complete('P'), '{"facts":[]}');
  const body = JSON.parse(sent.init.body);
  assert.equal(sent.u, 'http://127.0.0.1:9090/v1/chat/completions');
  assert.equal(sent.init.headers.authorization, 'Bearer k');
  assert.deepEqual([body.model, body.temperature, body.max_tokens, body.response_format.json_schema.name, body.chat_template_kwargs.enable_thinking], ['daily', 0.1, 6000, 'facts', false]);
  const down = httpChatModel({ url: 'http://x', model: 'm', fetch: async () => ({ ok: false, status: 500 }) });
  await assert.rejects(down.complete('P'), /500/);
});

test('itemWindows: the measured setting reads one window; more windows only when asked', async () => {
  const { itemWindows } = await import('../src/facts.ts');
  const it = { date: '2026-01-01', source: 's', title: 't', text: 'a'.repeat(ITEM_CHARS) + 'b'.repeat(10) };
  assert.equal(itemWindows(it).length, 1);
  assert.equal(itemWindows(it)[0], itemText(it));
  const w = itemWindows(it, 5);
  assert.equal(w.length, 2);
  assert.ok(w[1].endsWith('b'.repeat(10)) && w[1].startsWith('Date: 2026-01-01'));
  assert.equal(itemWindows({ ...it, text: '' }, 5).length, 1);
});

test('extractPending reads whole items by default (up to 10 windows), dedupes, keeps facts of windows that worked', async () => {
  const { MAX_WINDOWS } = await import('../src/facts.ts');
  assert.equal(MAX_WINDOWS, 10);
  const s = open();
  const long = 'Anna lives in Wien. ' + 'x'.repeat(ITEM_CHARS) + ' Anna lives in Wien. Bob owns a bike.';
  s.addItem({ id: 'a', date: '2026-01-01', source: 'mail', chunks: ['x'], text: long });
  s.addItem({ id: 'b', date: '2026-01-02', source: 'mail', chunks: ['y'], text: 'FAILHERE ' + 'y'.repeat(ITEM_CHARS) });
  const calls = [];
  const model = { async complete(p) {
    calls.push(p);
    if (p.includes('yyyy')) { if (p.includes('FAILHERE')) throw new Error('boom'); return JSON.stringify({ facts: [] }); }
    const fs = [fact({ quote: 'Anna lives in Wien' })];
    if (p.includes('Bob owns')) fs.push(fact({ subject: 'Bob', predicate: 'owns', object: 'bike', quote: 'Bob owns a bike' }));
    return JSON.stringify({ facts: fs });
  } };
  const r = await extractPending(s, model, 'Maria');
  assert.deepEqual(r, { items: 2, facts: 2, failed: 0 });
  assert.equal(calls.length, 4, 'two windows per item');
  assert.deepEqual(s.factsAbout('anna').map(f => f.object), ['Wien'], 'the same fact from two windows is kept once');
  assert.equal(s.factsAbout('bob').length, 1, 'a fact found only in the second window');
  const s2 = open();
  s2.addItem({ id: 'c', date: '2026-01-01', source: 'mail', chunks: ['x'], text: long });
  await extractPending(s2, model, 'Maria', { maxWindows: 1 });
  assert.equal(s2.factsAbout('bob').length, 0, 'maxWindows 1 is the old first-window-only setting');
  s.close(); s2.close();
});

test('extraction v2: one_value makes any predicate single-valued; considered and what-if facts never replace or get replaced', () => {
  const s = open();
  for (const [id, d] of [['a', '2026-03-01'], ['b', '2026-03-10'], ['c', '2026-03-20'], ['d', '2026-03-25']]) s.addItem({ id, date: d, source: 'mail', chunks: [id] });
  const [fa] = s.setFacts('a', [fact({ predicate: 'dentist', object: 'Dr. Ruiz', mentioned_at: '2026-03-01', one_value: true, status: 'true' })]);
  const [fb] = s.setFacts('b', [fact({ predicate: 'dentist', object: 'Dr. Soto', mentioned_at: '2026-03-10', one_value: true, status: 'considered' })]);
  const [fc] = s.setFacts('c', [fact({ predicate: 'dentist', object: 'Dr. Vega', mentioned_at: '2026-03-20', one_value: true, status: 'what_if' })]);
  let [a, b, c] = s.facts([fa, fb, fc]);
  assert.equal(a.superseded_on, null);                      // still the dentist: the others were never the value
  assert.equal(b.superseded_on, null); assert.equal(b.status, 'considered'); assert.equal(b.one_value, true);
  assert.match(factLine(b), /only considered, not decided/);
  assert.match(factLine(c), /only a what-if, not real/);
  const [fd] = s.setFacts('d', [fact({ predicate: 'dentist', object: 'Dr. Soto', mentioned_at: '2026-03-25', one_value: true, status: 'true' })]);
  [a] = s.facts([fa]);
  assert.equal(a.superseded_on, '2026-03-25');              // decided: now it replaces
  assert.equal(s.facts([fd])[0].superseded_on, null);
  // without one_value (v1 facts), a predicate outside the measured list still accumulates
  const [x] = s.setFacts('a', [fact({ predicate: 'gym', object: 'A', mentioned_at: '2026-03-01' })]);
  s.setFacts('b', [fact({ predicate: 'gym', object: 'B', mentioned_at: '2026-03-10' })]);
  assert.equal(s.facts([x])[0].superseded_on, null);
  assert.throws(() => s.setFacts('a', [fact({ status: 'maybe' })]), TypeError);
});

test('checkFacts keeps the v2 fields when given and drops a fact with a bad status', () => {
  const text = 'Anna moved to Lyon. She might switch gym.';
  const reply = JSON.stringify({ facts: [
    { ...fact({ object: 'Lyon', quote: 'Anna moved to Lyon' }), one_value: true, status: 'true' },
    { ...fact({ predicate: 'gym', object: 'X', quote: 'She might switch gym' }), one_value: true, status: 'perhaps' },
  ] });
  const r = checkFacts(reply, text);
  assert.equal(r.kept.length, 1); assert.equal(r.dropped, 1);
  assert.equal(r.kept[0].one_value, true); assert.equal(r.kept[0].status, 'true');
});
