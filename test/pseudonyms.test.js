// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { MemoryStore } from '../src/store.ts';

const open = () => MemoryStore.open(':memory:', { key: new Uint8Array(randomBytes(32)), dim: 4 });
const item = (id, text, extra = {}) => ({ id, date: '2026-11-27', source: 'notes', title: id, text, chunks: [text], ...extra });
const add = (s, it) => s.chunks(s.addItem(it))[0].text;

test('typed stand-ins: the same value gets the same one everywhere, and reveal puts it back', () => {
  const s = open();
  try {
    const a = add(s, item('a', 'Rent goes to DE89 3704 0044 0532 0130 00 from January. Wi-Fi: password = "lendkai21-sonne"'));
    const b = add(s, item('b', 'Reminder: the landlord IBAN is DE89370400440532013000.'));
    assert.match(a, /Rent goes to ⟦IBAN 1⟧ from January\. Wi-Fi: password = "⟦password 1⟧"/);
    assert.doesNotMatch(a + b, /DE89|lendkai21/);
    assert.match(b, /the landlord IBAN is ⟦IBAN \d⟧\./);
    assert.equal(s.reveal('Pay ⟦IBAN 1⟧, Wi-Fi ⟦password 1⟧, unknown ⟦IBAN 9⟧'), 'Pay DE89 3704 0044 0532 0130 00, Wi-Fi lendkai21-sonne, unknown ⟦IBAN 9⟧');
  } finally { s.close(); }
});

test('keys in a provider\'s format are dropped: the stand-in stays, the value is not kept', () => {
  const s = open();
  try {
    const key = 'sk-ant-api03-' + 'Zx9'.repeat(30);
    const t = add(s, item('k', `export ANTHROPIC_API_KEY=${key}`));
    assert.match(t, /⟦Anthropic API key 1⟧/);
    assert.match(s.reveal(t), /⟦Anthropic API key 1⟧ \(not kept/);
    assert.doesNotMatch(s.reveal(t), /Zx9Zx9/);
  } finally { s.close(); }
});

test('the check model\'s values get stand-ins wherever they occur; a query with a real value finds its stand-in', () => {
  const s = open();
  try {
    assert.equal(add(s, item('m', 'The cellar door code is Hq8vT3nLw2Rp since March. Again: Hq8vT3nLw2Rp.', { hidden: ['Hq8vT3nLw2Rp'] })), 'The cellar door code is ⟦door code 1⟧ since March. Again: ⟦door code 1⟧.');
    assert.equal(s.queryStandIns('which door takes Hq8vT3nLw2Rp?'), 'which door takes ⟦door code 1⟧?');
    s.addItem(item('i', 'IBAN AT61 1904 3002 3457 3201'));
    assert.equal(s.queryStandIns('who has AT61 1904 3002 3457 3201'), 'who has ⟦IBAN 1⟧');
  } finally { s.close(); }
});

test('an unchanged re-import is still recognised with stand-ins in the text', () => {
  const s = open();
  try {
    const it = item('r', 'Card 4539 1488 0343 6467 expires 04/29');
    s.addItem(it);
    assert.equal(s.hasSameItem(it), true);
    assert.equal(s.hasSameItem({ ...it, text: 'Card 4539 1488 0343 6467 expires 05/29' }), false);
    assert.equal(s.hasSameItem({ ...it, text: 'Card 5500 0000 0000 0004 expires 04/29' }), false); // a value with no stand-in yet
  } finally { s.close(); }
});
