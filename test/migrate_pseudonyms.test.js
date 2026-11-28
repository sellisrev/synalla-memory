// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/store.ts';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3-multiple-ciphers');

/** Rewrites a store into the form it had before stand-ins: raw money numbers, [secret:kind] markers, no migration mark. */
function makeLegacy(path, key, text) {
  const db = new Database(path);
  db.pragma(`cipher='sqlcipher'`); db.pragma('legacy=4'); db.pragma(`key="x'${Buffer.from(key).toString('hex')}'"`);
  db.prepare('UPDATE items SET text = ?').run(text);
  db.prepare('UPDATE chunks SET text = ?').run(text);
  db.prepare('UPDATE facts SET object = ?').run('DE89 3704 0044 0532 0130 00');
  db.prepare('DELETE FROM pseudonyms').run();
  db.prepare(`DELETE FROM meta WHERE k = 'pseudonyms'`).run();
  db.close();
}

test('a store from before stand-ins is migrated in place once: facts kept, changed chunks re-embedded, re-import unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synalla-migrate-')), path = join(dir, 'memory.db'), key = new Uint8Array(randomBytes(32));
  const raw = 'Rent goes to DE89 3704 0044 0532 0130 00. Wi-Fi: password = "lendkai21-sonne"';
  const legacyText = 'Rent goes to DE89 3704 0044 0532 0130 00. Wi-Fi: password = "[secret:assignment]"';
  try {
    let s = MemoryStore.open(path, { key, dim: 4 });
    const item = { id: 'n1', date: '2026-11-20', source: 'notes', title: 'Flat', text: raw, chunks: [raw] };
    const [cid] = s.addItem(item);
    s.setVectors([{ cid, vec: new Float32Array([1, 0, 0, 0]) }]);
    s.setFacts('n1', [{ subject: 'rent', predicate: 'goes to', object: 'x', valid_from: null, valid_to: null, mentioned_at: '2026-11-20', quote: 'Rent goes to' }]);
    s.close();
    makeLegacy(path, key, legacyText);

    s = MemoryStore.open(path, { key, dim: 4 }); // the migration runs here
    const [c] = s.chunks([cid]);
    assert.equal(c.text, 'Rent goes to ⟦IBAN 1⟧. Wi-Fi: password = "[secret:assignment]"');
    assert.deepEqual(s.missingVectors().map(m => m.cid), [cid]); // only the changed chunk is re-embedded
    const facts = s.factsAbout('rent');
    assert.equal(facts.length, 1);
    assert.equal(facts[0].object, '⟦IBAN 1⟧');
    assert.equal(s.keywordSearch('IBAN').length, 1); // the keyword index follows the update
    assert.equal(s.keywordSearch('DE89').length, 0);
    assert.equal(s.hasSameItem(item), true); // the old form counts as unchanged: no re-import, facts stay
    assert.equal(s.reveal('⟦IBAN 1⟧'), 'DE89 3704 0044 0532 0130 00');
    s.close();

    s = MemoryStore.open(path, { key, dim: 4 }); // and only once
    assert.equal(s.chunks([cid])[0].text, 'Rent goes to ⟦IBAN 1⟧. Wi-Fi: password = "[secret:assignment]"');
    s.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rehide with a later check model\'s values hides them in place everywhere', () => {
  const s = MemoryStore.open(':memory:', { key: new Uint8Array(randomBytes(32)), dim: 4 });
  try {
    const t = 'The cellar door code is Hq8vT3nLw2Rp since March.';
    const [cid] = s.addItem({ id: 'a', date: '2026-11-20', source: 'notes', title: 'Cellar', text: t, chunks: [t] });
    s.setVectors([{ cid, vec: new Float32Array([1, 0, 0, 0]) }]);
    assert.deepEqual(s.rehide(['a'], ['Hq8vT3nLw2Rp']), { items: 1, chunks: 1, facts: 0 });
    assert.equal(s.chunks([cid])[0].text, 'The cellar door code is ⟦door code 1⟧ since March.');
    assert.deepEqual(s.rehide(['a'], ['Hq8vT3nLw2Rp']), { items: 0, chunks: 0, facts: 0 });
  } finally { s.close(); }
});
