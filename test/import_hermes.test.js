// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHermes, hermesDbPath, HermesFormatChangedError } from '../src/import_hermes.ts';

const Database = createRequire(import.meta.url)('better-sqlite3-multiple-ciphers');

// The documented schema (version 31), the columns the importer reads plus a few it must ignore.
function makeDb(path, { dropColumn } = {}) {
  const db = new Database(path);
  db.pragma('journal_mode=WAL');
  const scols = ['id TEXT PRIMARY KEY', 'source TEXT NOT NULL', 'started_at REAL NOT NULL', 'title TEXT', 'parent_session_id TEXT', 'model TEXT']
    .filter(c => !dropColumn || !c.startsWith(dropColumn + ' '));
  db.exec(`CREATE TABLE sessions(${scols.join(', ')});
    CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
      tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL, reasoning TEXT, active INTEGER DEFAULT 1, compacted INTEGER DEFAULT 0);`);
  return db;
}

test('reads live user and assistant text per session; skips tools, reasoning, archived rows and subagents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synalla-hermes-'));
  try {
    const p = join(dir, 'state.db');
    const db = makeDb(p);
    db.prepare("INSERT INTO sessions(id, source, started_at, title) VALUES ('s1', 'cli', 1795000000, 'Flat search'), ('s2', 'subagent', 1795000100, null), ('s3', 'telegram', 1795000200, null)").run();
    const m = db.prepare('INSERT INTO messages(session_id, role, content, tool_call_id, tool_calls, timestamp, reasoning, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    m.run('s1', 'system', 'You are Hermes', null, null, 1, null, 1);
    m.run('s1', 'user', 'Find flats in Wien 7', null, null, 2, null, 1);
    m.run('s1', 'assistant', 'Searching.', null, '[{"name":"mcp__synalla__recall"}]', 3, 'private reasoning', 1);
    m.run('s1', 'tool', 'RECALL RESULT FROM ANOTHER MEMBER', 'c1', null, 4, null, 1);
    m.run('s1', 'user', 'old turn compacted away', null, null, 1.5, null, 0);
    m.run('s1', 'assistant', 'Two flats match.', null, null, 5, null, 1);
    m.run('s2', 'user', 'subagent work', null, null, 6, null, 1);
    m.run('s3', 'user', 'Remind me to call Mamie\nsecond line', null, null, 7, null, 1);
    db.close();
    const seen = new Map();
    const items = readHermes(p, seen);
    assert.deepEqual(items.map(i => [i.id, i.title, i.date]), [
      ['hermes:s1', 'Flat search', new Date(1795000000 * 1000).toISOString()],
      ['hermes:s3', 'Remind me to call Mamie', new Date(1795000200 * 1000).toISOString()],
    ]);
    assert.equal(items[0].text, 'User: Find flats in Wien 7\n\nAssistant: Searching.\n\nAssistant: Two flats match.');
    assert.match(items[0].chunks[0], /^\[\d{4}-\d{2}-\d{2}\] hermes \| Flat search\n/);
    assert.deepEqual(readHermes(p, seen), [], 'nothing changed');
    const w = new Database(p);
    w.prepare("INSERT INTO messages(session_id, role, content, timestamp) VALUES ('s3', 'assistant', 'Done.', 8)").run();
    w.close();
    assert.deepEqual(readHermes(p, seen).map(i => i.id), ['hermes:s3']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a missing column fails loudly; a missing database gives nothing; the path follows HERMES_HOME and the platform', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synalla-hermes-'));
  try {
    const p = join(dir, 'state.db');
    makeDb(p, { dropColumn: 'title' }).close();
    assert.throws(() => readHermes(p, new Map()), e => e instanceof HermesFormatChangedError && e.column === 'sessions.title');
    assert.deepEqual(readHermes(join(dir, 'none.db'), new Map()), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(hermesDbPath({ HERMES_HOME: '/h' }, 'linux'), join('/h', 'state.db'));
  assert.equal(hermesDbPath({ LOCALAPPDATA: 'C:\L' }, 'win32'), join('C:\L', 'hermes', 'state.db'));
});
