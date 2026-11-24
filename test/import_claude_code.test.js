// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseSession, cleanUserText, toStoreItem, importClaudeCode, FormatChangedError } from '../src/import_claude_code.ts';
import { chunkText, itemChunks, header } from '../src/chunk.ts';
import { MemoryStore } from '../src/store.ts';

const S = 'abc-123';
const rec = (o) => JSON.stringify({ sessionId: S, timestamp: '2026-11-20T09:00:00.000Z', isSidechain: false, ...o });
const user = (content, extra = {}) => rec({ type: 'user', message: { role: 'user', content }, ...extra });
const asst = (content, extra = {}) => rec({ type: 'assistant', message: { role: 'assistant', content }, ...extra });

test('chunkText matches the Python harness on 42 generated texts', () => {
  const cases = JSON.parse(readFileSync(new URL('./fixtures/chunk/python_parity.json', import.meta.url), 'utf8'));
  for (const [i, c] of cases.entries()) assert.deepEqual(chunkText(c.text), c.chunks, `case ${i}`);
});

test('header and itemChunks follow the harness format', () => {
  assert.equal(header('2026-11-20T09:00:00Z', 'claude-code', 'T'.repeat(200)), `[2026-11-20] claude-code | ${'T'.repeat(150)}`);
  assert.deepEqual(itemChunks({ date: '', source: 'notes', text: ' hi ' }), ['[] notes | \nhi']);
  assert.throws(() => chunkText(null), TypeError);
});

test('a session keeps what was said, in order, and drops tools, thinking, subagents and wrappers', () => {
  const jsonl = [
    rec({ type: 'permission-mode', permissionMode: 'default' }),
    user('<system-reminder>internal</system-reminder>Where does Mamie live?\n[Image: original 100x100]'),
    asst([{ type: 'thinking', thinking: 'secret reasoning' }, { type: 'text', text: 'In Lyon.' },
      { type: 'tool_use', id: 't1', name: 'mcp__synalla__recall', input: { q: 'Mamie' } }]),
    user([{ type: 'tool_result', tool_use_id: 't1', content: 'RECALL RESULT FROM ANOTHER MEMBER' }], { toolUseResult: { x: 1 } }),
    user('subagent prompt', { isSidechain: true }),
    user('Caveat', { isMeta: true }),
    user('This session is being continued...', { isCompactSummary: true }),
    user('<task-notification><task-id>1</task-id></task-notification>'),
    user([{ type: 'text', text: 'And her phone?' }, { type: 'image', source: {} }], { timestamp: '2026-11-20T09:05:00.000Z' }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Mamie address', sessionId: S }),
    '{"type":"user","message":', // torn last line
  ].join('\n');
  const s = parseSession(jsonl);
  assert.deepEqual(s, {
    id: 'claude-code:abc-123', date: '2026-11-20T09:00:00.000Z', source: 'claude-code', title: 'Mamie address',
    text: 'User: Where does Mamie live?\n\nAssistant: In Lyon.\n\nUser: And her phone?', turns: 3,
  });
  const item = toStoreItem(s);
  assert.deepEqual(item.chunks, ['[2026-11-20] claude-code | Mamie address\n' + s.text]);
});

test('title falls back to the first user line; empty sessions give null', () => {
  assert.equal(parseSession([user('Fix the build\nmore'), asst([{ type: 'text', text: 'ok' }])].join('\n')).title, 'Fix the build');
  assert.equal(parseSession(user('<system-reminder>x</system-reminder>')), null);
  assert.equal(parseSession(''), null);
});

test('a changed format fails loudly, naming the field', () => {
  assert.throws(() => parseSession(user('x', { timestamp: undefined })), (e) => e instanceof FormatChangedError && e.field === 'timestamp' && e.line === 1);
  assert.throws(() => parseSession(rec({ type: 'user', message: { content: 5 } })), (e) => e.field === 'message.content');
  assert.throws(() => parseSession(rec({ type: 'assistant', message: { content: [{ text: 'no type' }] } })), (e) => e.field === 'message.content[].type');
  assert.throws(() => parseSession(rec({ type: 'user', sessionId: '' })), (e) => e.field === 'sessionId');
  assert.throws(() => parseSession(rec({ type: 'user' })), (e) => e.field === 'message');
});

test('cleanUserText removes only machine wrappers', () => {
  assert.equal(cleanUserText('<command-name>/clear</command-name>\n<command-args></command-args>\nkeep <b>this</b>'), 'keep <b>this</b>');
});

test('importClaudeCode: imports changed files only, replaces a session, reports a broken file and keeps going', async () => {
  const root = mkdtempSync(join(tmpdir(), 'synalla-cc-'));
  try {
    mkdirSync(join(root, 'C--proj'));
    const good = join(root, 'C--proj', 'abc-123.jsonl');
    writeFileSync(good, [user('first question'), asst([{ type: 'text', text: 'first answer' }])].join('\n'));
    writeFileSync(join(root, 'C--proj', 'bad.jsonl'), rec({ type: 'user', message: { content: 7 } }));
    writeFileSync(join(root, 'C--proj', 'notes.txt'), 'ignored');
    const store = MemoryStore.open(':memory:', { key: new Uint8Array(randomBytes(32)), dim: 4 });
    const seen = new Map();
    const r1 = await importClaudeCode(store, seen, root);
    assert.deepEqual(r1.imported, ['claude-code:abc-123']);
    assert.equal(r1.failed.length, 1); assert.match(r1.failed[0].error, /message.content/);
    assert.equal((await importClaudeCode(store, seen, root)).skipped, 1);
    writeFileSync(good, [user('second question'), asst([{ type: 'text', text: 'second answer' }])].join('\n'));
    utimesSync(good, new Date(), new Date(Date.now() + 5000));
    assert.deepEqual((await importClaudeCode(store, seen, root)).imported, ['claude-code:abc-123']);
    assert.deepEqual(store.keywordSearch('first'), []);
    assert.equal(store.keywordSearch('second').length, 1);
    assert.deepEqual(store.stats(), { items: 1, chunks: 1, vectors: 0, facts: 0, factVectors: 0 });
    assert.deepEqual(await importClaudeCode(store, new Map(), join(root, 'missing')), { imported: [], skipped: 0, failed: [] });
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
