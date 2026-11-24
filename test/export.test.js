// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { MemoryStore } from '../src/store.ts';
import { folderTarget } from '../src/backup.ts';
import { exportPlain, renderPlain } from '../src/export.ts';

test('renderPlain: one file per source and month, oldest first, undated apart', () => {
  const files = renderPlain([
    { id: 'm1', date: '2026-10-03T08:00:00Z', source: 'mail', title: 'Rent', text: 'Rent is due.' },
    { id: 'm2', date: '2026-10-20', source: 'mail', title: '', text: 'Second.' },
    { id: 'n1', date: '', source: 'Claude Code!', title: 'x', text: 'No date.' },
  ]);
  assert.deepEqual([...files.keys()], ['mail/2026-10.md', 'claude-code/undated.md']);
  assert.equal(files.get('mail/2026-10.md'), '# mail, 2026-10\n\n## Rent\n\n_2026-10-03T08:00:00Z · m1_\n\nRent is due.\n\n## m2\n\n_2026-10-20 · m2_\n\nSecond.\n');
});

test('exportPlain writes readable files, scrubbed, and removes files whose items are gone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'synalla-exp-'));
  try {
    const store = MemoryStore.open(':memory:', { key: new Uint8Array(randomBytes(32)), dim: 4 });
    const secret = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    store.addItem({ id: 'a', date: '2026-09-01', source: 'notes', title: 'Keys', chunks: ['c'], text: `aws ${secret} stored` });
    store.addItem({ id: 'b', date: '2026-10-01', source: 'notes', title: 'Plan', chunks: ['c'], text: 'Plan text' });
    const t = folderTarget(dir);
    const w = await exportPlain(store, t);
    assert.deepEqual(w, ['synalla-memory/readable/notes/2026-09.md', 'synalla-memory/readable/notes/2026-10.md']);
    const sep = readFileSync(join(dir, 'synalla-memory', 'readable', 'notes', '2026-09.md'), 'utf8');
    assert.match(sep, /## Keys/); assert.equal(sep.includes(secret), false);
    assert.match(readFileSync(join(dir, 'synalla-memory', 'readable', 'README.md'), 'utf8'), /NOT encrypted/);
    store.deleteItem('a');
    await exportPlain(store, t);
    assert.equal(existsSync(join(dir, 'synalla-memory', 'readable', 'notes', '2026-09.md')), false);
    assert.equal(existsSync(join(dir, 'synalla-memory', 'readable', 'notes', '2026-10.md')), true);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
