// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { readOpenClaw, readOpenClawDb, openclawStateDir, activeSegments, OpenClawFormatChangedError } from '../src/import_openclaw.ts';

const Database = createRequire(import.meta.url)('better-sqlite3-multiple-ciphers');

// The OpenClaw 2026.11 agent schema: the columns the importer reads plus some it must ignore.
function makeDb(path, { dropColumn, chunks = true } = {}) {
  const db = new Database(path);
  db.pragma('journal_mode=WAL');
  const wcols = ['session_id TEXT PRIMARY KEY', 'session_key TEXT NOT NULL', 'previous_session_id TEXT', 'reason TEXT',
    'created_at INTEGER NOT NULL', 'updated_at INTEGER', 'transcript_updated_at INTEGER', 'started_at INTEGER', 'hook_external_content_source TEXT',
    'parent_session_key TEXT', 'spawned_by TEXT', 'display_name TEXT', 'chat_type TEXT']
    .filter(c => !dropColumn || !c.startsWith(dropColumn + ' '));
  db.exec(`CREATE TABLE session_windows(${wcols.join(', ')});
    CREATE TABLE session_nodes(session_key TEXT PRIMARY KEY, current_session_id TEXT, entry_json TEXT NOT NULL);
    CREATE TABLE transcript_events(session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT, created_at INTEGER NOT NULL,
      event_zstd BLOB, event_utf8_bytes INTEGER, navigation_json TEXT, message_role TEXT, PRIMARY KEY (session_id, seq));
    CREATE TABLE transcript_rewrite_watermarks(session_id TEXT PRIMARY KEY, generation TEXT, updated_at INTEGER);
    CREATE TABLE session_transcript_cold_archives(session_id TEXT PRIMARY KEY, generation TEXT, archive_name TEXT, archive_sha256 TEXT,
      event_count INTEGER, raw_bytes INTEGER, archive_bytes INTEGER, last_seq INTEGER, archived_at INTEGER, storage TEXT, archive_blob BLOB);`
    + (chunks ? `CREATE TABLE session_transcript_cold_archive_chunks(session_id TEXT, chunk_index INTEGER, archive_name TEXT, archive_sha256 TEXT,
      first_seq INTEGER, last_seq INTEGER, event_count INTEGER, raw_bytes INTEGER, archive_bytes INTEGER, archive_blob BLOB);` : ''));
  return db;
}

let n = 0;
const msg = (role, content, extra = {}) => ({ type: 'message', id: extra.id ?? `m${++n}`, parentId: extra.parentId, timestamp: extra.ts ?? '2026-11-20T09:00:00Z', message: { role, content }, ...extra });

/** A linked transcript: each event's parent is the one before it, unless it says otherwise. */
function chain(events) {
  let prev = null;
  return events.map(e => { const x = { ...e, id: e.id ?? `e${++n}` }; if (!('parentId' in e) || e.parentId === undefined) x.parentId = prev; prev = x.type === 'leaf' ? prev : x.id; return x; });
}

function addEvents(db, sid, events, { zstd = [] } = {}) {
  const ins = db.prepare('INSERT INTO transcript_events(session_id, seq, event_json, created_at, event_zstd, event_utf8_bytes, navigation_json, message_role) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  events.forEach((e, seq) => {
    const json = JSON.stringify(e), z = zstd.includes(seq);
    ins.run(sid, seq, z ? null : json, 1795000000000 + seq, z ? zstdCompressSync(Buffer.from(json)) : null, z ? json.length : null,
      z ? '{"version":1}' : null, e.message?.role ?? null);
  });
}

/** A cold archive as OpenClaw writes it (decodeSessionColdRecords): a header record, then event records. */
function coldArchive(sid, events, firstSeq = 0) {
  const lines = [{ kind: 'header', version: 1, sessionId: sid, generation: 'g1' },
    ...events.flatMap((e, i) => [{ kind: 'event', row: { seq: firstSeq + i, event_json: JSON.stringify(e), created_at: 1 } },
      { kind: 'identity', row: { event_id: e.id, seq: firstSeq + i, event_type: e.type, parent_id: e.parentId ?? null, message_idempotency_key: null, created_at: 1 } }])];
  return zstdCompressSync(Buffer.from(lines.map(l => JSON.stringify(l)).join('\n') + '\n'));
}

function agentDb(dir, agent = 'main') {
  const d = join(dir, 'agents', agent, 'agent'); mkdirSync(d, { recursive: true });
  return join(d, 'openclaw-agent.sqlite');
}

test('reads user and assistant text, compressed or not; skips tools, thinking, extension events and side sessions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synalla-openclaw-'));
  try {
    const p = agentDb(dir), db = makeDb(p);
    const w = db.prepare('INSERT INTO session_windows(session_id, session_key, created_at, started_at, display_name, parent_session_key, spawned_by, hook_external_content_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    w.run('w1', 'agent:main:main', 1795000000000, null, 'Flat search', null, null, null);
    w.run('w2', 'agent:main:telegram:direct:42', 1795000100000, 1795000100500, null, null, null, null);
    w.run('fork', 'agent:main:dashboard:fork1', 1795000150000, null, null, 'agent:main:main', null, null); // a user fork: kept
    w.run('sub', 'agent:main:subagent:abc', 1795000200000, null, null, 'agent:main:main', 'agent:main:main', null);
    w.run('check', 'agent:main:explicit:model-run-9f', 1795000300000, null, null, null, null, null);
    w.run('hook', 'agent:main:hook:gmail:1', 1795000400000, null, null, null, null, 'gmail');
    w.run('cron', 'agent:main:cron:daily-digest:run:abc', 1795000500000, null, null, null, null, null);
    w.run('dream', 'agent:main:dreaming-narrative-2026-11-26', 1795000600000, null, null, null, null, null);
    w.run('beat', 'agent:main:heartbeat-x', 1795000700000, null, null, null, null, null);
    db.prepare('INSERT INTO session_nodes(session_key, current_session_id, entry_json) VALUES (?, ?, ?)').run('agent:main:heartbeat-x', 'beat', JSON.stringify({ heartbeatIsolatedBaseSessionKey: 'agent:main:main' }));
    addEvents(db, 'w1', chain([
      { type: 'session', version: 4, id: 'w1' },
      { type: 'custom', customType: 'model-snapshot', data: {} },
      msg('user', 'Find flats in Wien 7'),
      msg('assistant', [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: 'Searching.' }, { type: 'toolCall', id: 'c1', name: 'recall', arguments: {} }]),
      msg('toolResult', [{ type: 'text', text: 'RECALL RESULT FROM ANOTHER MEMBER' }]),
      msg('assistant', [{ type: 'text', text: 'Two flats match.' }]),
      { type: 'custom_message', customType: 'x', content: 'injected by an extension' },
    ]), { zstd: [3, 4] });
    addEvents(db, 'w2', chain([msg('user', 'Remind me to call Mamie\nsecond line', { id: 'n1', parentId: null })]));
    for (const s of ['fork', 'sub', 'check', 'hook', 'cron', 'dream', 'beat']) addEvents(db, s, chain([msg('user', 'work in ' + s)]));
    db.close();
    const seen = new Map();
    const { items, failed } = readOpenClaw(dir, seen);
    assert.deepEqual(failed, []);
    assert.deepEqual(items.map(i => [i.id, i.title, i.date]), [
      ['openclaw:main:w1', 'Flat search', new Date(1795000000000).toISOString()],
      ['openclaw:main:w2', 'Remind me to call Mamie', new Date(1795000100500).toISOString()],
      ['openclaw:main:fork', 'work in fork', new Date(1795000150000).toISOString()],
    ]);
    assert.equal(items[0].text, 'User: Find flats in Wien 7\n\nAssistant: Searching.\n\nAssistant: Two flats match.');
    assert.match(items[0].chunks[0], /^\[\d{4}-\d{2}-\d{2}\] openclaw \| Flat search\n/);
    assert.deepEqual(readOpenClaw(dir, seen).items, [], 'nothing changed');
    const d2 = new Database(p);
    d2.prepare("INSERT INTO transcript_events(session_id, seq, event_json, created_at) VALUES ('w2', 1, ?, 1)").run(JSON.stringify(msg('assistant', 'Done.', { parentId: 'n1' })));
    d2.close();
    const again = readOpenClaw(dir, seen).items;
    assert.deepEqual(again.map(i => i.id), ['openclaw:main:w2']);
    assert.equal(again[0].text, 'User: Remind me to call Mamie\nsecond line\n\nAssistant: Done.');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the conversation is the active branch: a rewrite or rewind leaves the old branch out; a reset starts a new item', () => {
  const root = msg('user', 'What is the budget?', { id: 'u1', parentId: null });
  const a1 = msg('assistant', 'The budget is 900.', { id: 'a1', parentId: 'u1' });
  const a1b = msg('assistant', 'The budget is 1200.', { id: 'a1b', parentId: 'u1', supersedesEntryId: 'a1' });
  assert.deepEqual(activeSegments([{ type: 'session', id: 's' }, root, a1, a1b])[0].events.map(e => e.id), ['u1', 'a1b'], 'rewrite: newer copy only');
  const u2 = msg('user', 'And the deadline?', { id: 'u2', parentId: 'a1' });
  const rewind = { type: 'leaf', id: 'L1', parentId: 'u2', targetId: 'u1' };
  const a2 = msg('assistant', 'Budget 1200, final.', { id: 'a2', parentId: 'u1' });
  assert.deepEqual(activeSegments([root, a1, u2, rewind, a2])[0].events.map(e => e.id), ['u1', 'a2'], 'rewind: the old branch is gone');
  const compact = { type: 'compaction', id: 'c1', parentId: 'a1', summary: 's', firstKeptEntryId: 'a1', tokensBefore: 9 };
  const u3 = msg('user', 'Later question', { id: 'u3', parentId: 'c1' });
  assert.deepEqual(activeSegments([root, a1, compact, u3])[0].events.map(e => e.id), ['u1', 'a1', 'c1', 'u3'], 'compaction keeps history');
  const reset = { type: 'reset', id: 'r1', parentId: 'a1', reason: 'new' };
  const u4 = msg('user', 'November: new flat hunt', { id: 'u4', parentId: 'r1', ts: '2026-11-03T10:00:00Z' });
  const segs = activeSegments([root, a1, reset, u4]);
  assert.deepEqual(segs.map(s => [s.resetId, s.events.map(e => e.id)]), [[null, ['u1', 'a1']], ['r1', ['u4']]]);

  const dir = mkdtempSync(join(tmpdir(), 'synalla-openclaw-'));
  try {
    const p = agentDb(dir), db = makeDb(p);
    db.prepare("INSERT INTO session_windows(session_id, session_key, created_at) VALUES ('w', 'agent:main:main', 1795000000000)").run();
    addEvents(db, 'w', [root, a1, reset, u4]);
    db.close();
    const r = readOpenClawDb(p, 'main', new Map());
    assert.deepEqual(r.items.map(i => [i.id, i.date.slice(0, 10), i.title]), [
      ['openclaw:main:w', new Date(1795000000000).toISOString().slice(0, 10), 'What is the budget?'],
      ['openclaw:main:w:r1', '2026-11-03', 'November: new flat hunt']]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a cold window is read from its archive records: chunked files, one file, or the embedded blob', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synalla-openclaw-'));
  try {
    const p = agentDb(dir, 'work'), db = makeDb(p);
    const cold = join(dir, 'agents', 'work', 'sessions', 'cold'); mkdirSync(cold, { recursive: true });
    db.prepare("INSERT INTO session_windows(session_id, session_key, created_at) VALUES ('c1', 'agent:work:main', 1), ('c2', 'agent:work:other', 2), ('c3', 'agent:work:third', 3)").run();
    const ev1 = chain([msg('user', 'March: we chose the Ottakring flat', { id: 'x1', parentId: null }), msg('assistant', 'Noted.', { id: 'x2' })]);
    writeFileSync(join(cold, 'a'.repeat(64) + '.jsonl.zst'), coldArchive('c1', [ev1[0]], 0));
    writeFileSync(join(cold, 'b'.repeat(64) + '.jsonl.zst'), coldArchive('c1', [ev1[1]], 1));
    db.prepare("INSERT INTO session_transcript_cold_archives(session_id, generation, archive_name, archive_sha256, storage) VALUES ('c1', 'g1', ?, 'h1', 'file')").run('m'.repeat(64) + '.jsonl.zst');
    db.prepare("INSERT INTO session_transcript_cold_archive_chunks(session_id, chunk_index, archive_name, archive_sha256) VALUES ('c1', 0, ?, 'x'), ('c1', 1, ?, 'y')").run('a'.repeat(64) + '.jsonl.zst', 'b'.repeat(64) + '.jsonl.zst');
    db.prepare("INSERT INTO session_transcript_cold_archives(session_id, generation, archive_name, archive_sha256, storage, archive_blob) VALUES ('c2', 'g1', ?, 'h2', 'sqlite', ?)").run('c'.repeat(64) + '.jsonl.zst', coldArchive('c2', chain([msg('user', 'From the backup blob', { parentId: null })])));
    writeFileSync(join(cold, 'd'.repeat(64) + '.jsonl.zst'), coldArchive('c3', chain([msg('user', 'One file, no chunks', { parentId: null })])));
    db.prepare("INSERT INTO session_transcript_cold_archives(session_id, generation, archive_name, archive_sha256, storage) VALUES ('c3', 'g1', ?, 'h3', 'file')").run('d'.repeat(64) + '.jsonl.zst');
    db.close();
    const r = readOpenClawDb(p, 'work', new Map());
    assert.deepEqual(r.failed, []);
    assert.deepEqual(r.items.map(i => [i.id, i.text]), [
      ['openclaw:work:c1', 'User: March: we chose the Ottakring flat\n\nAssistant: Noted.'],
      ['openclaw:work:c2', 'User: From the backup blob'],
      ['openclaw:work:c3', 'User: One file, no chunks'],
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('failures: a missing column fails that agent; a missing archive fails that window only and is retried; old schemas without chunks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synalla-openclaw-'));
  try {
    makeDb(agentDb(dir, 'bad'), { dropColumn: 'session_key' }).close();
    const good = makeDb(agentDb(dir, 'good'), { chunks: false });
    good.prepare("INSERT INTO session_windows(session_id, session_key, created_at) VALUES ('g1', 'agent:good:main', 1), ('g2', 'agent:good:x', 2)").run();
    addEvents(good, 'g1', chain([msg('user', 'hello', { parentId: null })]));
    good.prepare("INSERT INTO session_transcript_cold_archives(session_id, generation, archive_name, archive_sha256, storage) VALUES ('g2', 'g', ?, 'h', 'file')").run('e'.repeat(64) + '.jsonl.zst');
    good.close();
    const seen = new Map();
    const r = readOpenClaw(dir, seen);
    assert.deepEqual(r.items.map(i => i.id), ['openclaw:good:g1'], 'the good window is read despite the broken one');
    assert.equal(r.failed.length, 2);
    assert.match(r.failed[0].error, /no column session_windows\.session_key/);
    assert.match(r.failed[1].error, /window g2/);
    assert.ok(seen.has('good:g1') && !seen.has('good:g2'), 'the failed window is retried next time');
    assert.throws(() => readOpenClawDb(agentDb(dir, 'bad'), 'bad', new Map()), e => e instanceof OpenClawFormatChangedError && e.column === 'session_windows.session_key');
    assert.deepEqual(readOpenClaw(join(dir, 'none'), new Map()), { items: [], failed: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an in-place rewrite changes the mark (watermark generation, transcript_updated_at)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synalla-openclaw-'));
  try {
    const p = agentDb(dir), db = makeDb(p);
    db.prepare("INSERT INTO session_windows(session_id, session_key, created_at, transcript_updated_at) VALUES ('w', 'agent:main:main', 1, 10)").run();
    addEvents(db, 'w', chain([msg('user', 'Meeting on Tuesday', { id: 'q', parentId: null })]));
    db.close();
    const seen = new Map();
    assert.equal(readOpenClawDb(p, 'main', seen).items[0].text, 'User: Meeting on Tuesday');
    const d = new Database(p);
    d.prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = 'w' AND seq = 0").run(JSON.stringify(msg('user', 'Meeting on Thursday', { id: 'q', parentId: null })));
    d.prepare("INSERT INTO transcript_rewrite_watermarks(session_id, generation, updated_at) VALUES ('w', 'g2', 2)").run();
    d.close();
    assert.equal(readOpenClawDb(p, 'main', seen).items[0]?.text, 'User: Meeting on Thursday');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the state directory follows OpenClaw: OPENCLAW_STATE_DIR, ~, OPENCLAW_HOME, OPENCLAW_PROFILE, HOME, USERPROFILE', () => {
  const os = () => '/os';
  assert.equal(openclawStateDir({ OPENCLAW_STATE_DIR: ' /s ' }, os), resolve('/s'));
  assert.equal(openclawStateDir({ OPENCLAW_STATE_DIR: '~/oc-state', HOME: '/h' }, os), resolve('/h/oc-state'));
  assert.equal(openclawStateDir({ OPENCLAW_HOME: '/oc' }, os), join(resolve('/oc'), '.openclaw'));
  assert.equal(openclawStateDir({ OPENCLAW_PROFILE: 'work', HOME: '/h' }, os), join(resolve('/h'), '.openclaw-work'));
  assert.equal(openclawStateDir({ OPENCLAW_PROFILE: 'default', USERPROFILE: '/u' }, os), join(resolve('/u'), '.openclaw'));
  assert.equal(openclawStateDir({ OPENCLAW_STATE_DIR: '  ' }, os), join(resolve('/os'), '.openclaw'));
});
