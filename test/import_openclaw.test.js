// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { readOpenClaw, readOpenClawDb, openclawStateDir, OpenClawFormatChangedError } from '../src/import_openclaw.ts';

const Database = createRequire(import.meta.url)('better-sqlite3-multiple-ciphers');

// The OpenClaw 2026.11 agent schema: the columns the importer reads plus some it must ignore.
function makeDb(path, { dropColumn } = {}) {
  const db = new Database(path);
  db.pragma('journal_mode=WAL');
  const wcols = ['session_id TEXT PRIMARY KEY', 'session_key TEXT NOT NULL', 'previous_session_id TEXT', 'reason TEXT',
    'created_at INTEGER NOT NULL', 'updated_at INTEGER', 'started_at INTEGER', 'hook_external_content_source TEXT',
    'parent_session_key TEXT', 'spawned_by TEXT', 'display_name TEXT', 'chat_type TEXT']
    .filter(c => !dropColumn || !c.startsWith(dropColumn + ' '));
  db.exec(`CREATE TABLE session_windows(${wcols.join(', ')});
    CREATE TABLE transcript_events(session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT, created_at INTEGER NOT NULL,
      event_zstd BLOB, event_utf8_bytes INTEGER, navigation_json TEXT, message_role TEXT, PRIMARY KEY (session_id, seq));
    CREATE TABLE session_transcript_cold_archives(session_id TEXT, generation INTEGER, archive_name TEXT, archive_sha256 TEXT,
      event_count INTEGER, last_seq INTEGER, storage TEXT, archive_blob BLOB);
    CREATE TABLE session_transcript_cold_archive_chunks(session_id TEXT, chunk_index INTEGER, archive_name TEXT, archive_sha256 TEXT,
      first_seq INTEGER, last_seq INTEGER, archive_blob BLOB);`);
  return db;
}

const msg = (id, role, content, extra = {}) => ({ type: 'message', id, timestamp: '2026-11-20T09:00:00Z', message: { role, content }, ...extra });

function addEvents(db, sid, events, { zstd = [] } = {}) {
  const ins = db.prepare('INSERT INTO transcript_events(session_id, seq, event_json, created_at, event_zstd, event_utf8_bytes, navigation_json, message_role) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  events.forEach((e, seq) => {
    const json = JSON.stringify(e), z = zstd.includes(seq);
    ins.run(sid, seq, z ? null : json, 1795000000000 + seq, z ? zstdCompressSync(Buffer.from(json)) : null, z ? json.length : null,
      z ? '{"version":1}' : null, e.message?.role ?? null);
  });
}

test('reads user and assistant text per window, compressed or not; skips tools, thinking, extension events, rewritten copies and side sessions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synalla-openclaw-'));
  try {
    const agentDir = join(dir, 'agents', 'main', 'agent'); mkdirSync(agentDir, { recursive: true });
    const p = join(agentDir, 'openclaw-agent.sqlite');
    const db = makeDb(p);
    const w = db.prepare('INSERT INTO session_windows(session_id, session_key, created_at, started_at, display_name, parent_session_key, spawned_by, hook_external_content_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    w.run('w1', 'agent:main:main', 1795000000000, null, 'Flat search', null, null, null);
    w.run('w2', 'agent:main:telegram:direct:42', 1795000100000, 1795000100500, null, null, null, null);
    w.run('w3', 'agent:main:subagent:abc', 1795000200000, null, null, 'agent:main:main', 'agent:main:main', null);
    w.run('w4', 'agent:main:explicit:model-run-9f', 1795000300000, null, null, null, null, null);
    w.run('w5', 'agent:main:hook:gmail:1', 1795000400000, null, null, null, null, 'gmail');
    addEvents(db, 'w1', [
      { type: 'session', version: 4, id: 'w1' },
      { type: 'custom', customType: 'model-snapshot', data: {} },
      msg('m1', 'user', 'Find flats in Wien 7'),
      msg('m2', 'assistant', [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: 'Searching.' },
        { type: 'toolCall', id: 'c1', name: 'recall', arguments: {} }]),
      msg('m3', 'toolResult', [{ type: 'text', text: 'RECALL RESULT FROM ANOTHER MEMBER' }]),
      msg('m4', 'assistant', [{ type: 'text', text: 'Two flats mtach.' }]),
      msg('m5', 'assistant', [{ type: 'text', text: 'Two flats match.' }], { supersedesEntryId: 'm4' }),
      { type: 'custom_message', customType: 'x', content: 'injected by an extension' },
    ], { zstd: [3, 4] });
    addEvents(db, 'w2', [msg('n1', 'user', 'Remind me to call Mamie\nsecond line')]);
    for (const s of ['w3', 'w4', 'w5']) addEvents(db, s, [msg(s + 'u', 'user', 'side work ' + s)]);
    db.close();
    const seen = new Map();
    const { items, failed } = readOpenClaw(dir, seen);
    assert.deepEqual(failed, []);
    assert.deepEqual(items.map(i => [i.id, i.title, i.date]), [
      ['openclaw:main:w1', 'Flat search', new Date(1795000000000).toISOString()],
      ['openclaw:main:w2', 'Remind me to call Mamie', new Date(1795000100500).toISOString()],
    ]);
    assert.equal(items[0].text, 'User: Find flats in Wien 7\n\nAssistant: Searching.\n\nAssistant: Two flats match.');
    assert.match(items[0].chunks[0], /^\[\d{4}-\d{2}-\d{2}\] openclaw \| Flat search\n/);
    assert.deepEqual(readOpenClaw(dir, seen).items, [], 'nothing changed');
    const d2 = new Database(p);
    d2.prepare("INSERT INTO transcript_events(session_id, seq, event_json, created_at) VALUES ('w2', 1, ?, 1)").run(JSON.stringify(msg('n2', 'assistant', 'Done.')));
    d2.close();
    const again = readOpenClaw(dir, seen).items;
    assert.deepEqual(again.map(i => i.id), ['openclaw:main:w2']);
    assert.equal(again[0].text, 'User: Remind me to call Mamie\nsecond line\n\nAssistant: Done.');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a window in cold storage is read from its archive file (chunked) or from the embedded blob, before the rows still in SQLite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synalla-openclaw-'));
  try {
    const agentDir = join(dir, 'agents', 'work', 'agent'); mkdirSync(agentDir, { recursive: true });
    const cold = join(dir, 'agents', 'work', 'sessions', 'cold'); mkdirSync(cold, { recursive: true });
    const p = join(agentDir, 'openclaw-agent.sqlite');
    const db = makeDb(p);
    db.prepare("INSERT INTO session_windows(session_id, session_key, created_at) VALUES ('c1', 'agent:work:main', 1), ('c2', 'agent:work:other', 2)").run();
    const jsonl = evs => zstdCompressSync(Buffer.from(evs.map(e => JSON.stringify(e)).join('\n') + '\n'));
    writeFileSync(join(cold, 'aaa.jsonl.zst'), jsonl([msg('a1', 'user', 'March: we chose the Ottakring flat')]));
    writeFileSync(join(cold, 'bbb.jsonl.zst'), jsonl([msg('a2', 'assistant', 'Noted.')]));
    db.prepare("INSERT INTO session_transcript_cold_archives(session_id, generation, archive_name, archive_sha256) VALUES ('c1', 1, 'manifest', 'h1')").run();
    db.prepare("INSERT INTO session_transcript_cold_archive_chunks(session_id, chunk_index, archive_name, archive_sha256) VALUES ('c1', 0, 'aaa.jsonl.zst', 'x'), ('c1', 1, 'bbb.jsonl.zst', 'y')").run();
    db.prepare("INSERT INTO session_transcript_cold_archives(session_id, generation, archive_name, archive_sha256, archive_blob) VALUES ('c2', 1, 'ccc.jsonl.zst', 'h2', ?)").run(jsonl([msg('b1', 'user', 'From the backup blob')]));
    addEvents(db, 'c1', [msg('a3', 'user', 'April: keys handed over')]);
    db.close();
    const items = readOpenClawDb(p, 'work', new Map());
    assert.deepEqual(items.map(i => [i.id, i.text]), [
      ['openclaw:work:c1', 'User: March: we chose the Ottakring flat\n\nAssistant: Noted.\n\nUser: April: keys handed over'],
      ['openclaw:work:c2', 'User: From the backup blob'],
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a missing column fails loudly for that agent only; a missing database gives nothing; a failed read is retried next run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synalla-openclaw-'));
  try {
    for (const a of ['bad', 'good']) mkdirSync(join(dir, 'agents', a, 'agent'), { recursive: true });
    makeDb(join(dir, 'agents', 'bad', 'agent', 'openclaw-agent.sqlite'), { dropColumn: 'session_key' }).close();
    const good = makeDb(join(dir, 'agents', 'good', 'agent', 'openclaw-agent.sqlite'));
    good.prepare("INSERT INTO session_windows(session_id, session_key, created_at) VALUES ('g1', 'agent:good:main', 1), ('g2', 'agent:good:x', 2)").run();
    addEvents(good, 'g1', [msg('u', 'user', 'hello')]);
    good.prepare("INSERT INTO session_transcript_cold_archives(session_id, generation, archive_name, archive_sha256) VALUES ('g2', 1, 'missing.jsonl.zst', 'h')").run();
    good.close();
    const seen = new Map();
    const r = readOpenClaw(dir, seen);
    assert.equal(r.failed.length, 2);
    assert.match(r.failed[0].error, /no column session_windows\.session_key/);
    assert.equal(r.failed[1].agent, 'good');
    assert.equal(seen.size, 0, 'a database that failed part-way marks nothing as seen');
    assert.throws(() => readOpenClawDb(join(dir, 'agents', 'bad', 'agent', 'openclaw-agent.sqlite'), 'bad', new Map()),
      e => e instanceof OpenClawFormatChangedError && e.column === 'session_windows.session_key');
    assert.deepEqual(readOpenClaw(join(dir, 'none'), new Map()), { items: [], failed: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(openclawStateDir({ OPENCLAW_STATE_DIR: '/s' }), '/s');
});
