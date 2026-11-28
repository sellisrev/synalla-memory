// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// The optional import checks with a local chat model (src/checks.ts), with a fake model in place of the real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { scrubWithModel, speaksToAgentModel, checkModel, SECRET_PROMPT } from '../src/checks.ts';
import { main } from '../src/cli.ts';

const fake = names => ({ asked: [], async ask(system, user) { this.asked.push(user); return JSON.stringify({ secrets: names(user) }); } });

test('second pass: the model\'s values are hidden, but never placeholders, public material, user names or plain words', async () => {
  const m = fake(u => ['Zq7mR2vXk9Lp', 'PASSWORD', 'deploy-bot', 'sunshine', 'not-in-the-line-at-all']);
  const out = await scrubWithModel('the vault code is Zq7mR2vXk9Lp, login deploy-bot\npostgres://USER:PASSWORD@HOST/db sunshine', m);
  assert.match(out, /the vault code is \[secret:model\], login deploy-bot/);
  assert.match(out, /USER:PASSWORD@HOST/);
  assert.match(out, /sunshine/);
  assert.equal(m.asked.length, 2); // both lines hold a mixed token of 8+ characters
});

test('second pass: lines with nothing token-like are not asked; an unreadable answer keeps the rules\' result', async () => {
  const quiet = fake(() => { throw new Error('should not be asked'); });
  assert.equal(await scrubWithModel('Dinner on Friday at eight, bring the salad.', quiet), 'Dinner on Friday at eight, bring the salad.');
  const broken = { async ask() { return 'I think there is a secret.'; } };
  assert.equal(await scrubWithModel('ref X7k2-p9Lm-44Qa for the parcel', broken), 'ref X7k2-p9Lm-44Qa for the parcel');
});

test('injection question: yes, no, and no answer on errors', async () => {
  assert.equal(await speaksToAgentModel('x', { async ask() { return '{"instructs_ai": true}'; } }), true);
  assert.equal(await speaksToAgentModel('x', { async ask() { return '{"instructs_ai": false}'; } }), false);
  assert.equal(await speaksToAgentModel('x', { async ask() { throw new Error('down'); } }), null);
});

test('a check model off this machine needs the owner agreeing and https, and reaches only its own host', async () => {
  assert.throws(() => checkModel('https://api.example.com/', 'm'), /not on this machine/);
  assert.throws(() => checkModel('http://api.example.com/', 'm', { cloud: true }), /https/);
  assert.doesNotThrow(() => checkModel('http://127.0.0.1:9090/', 'fast'));
  const sent = [];
  const base = async (u, init) => { sent.push({ u: String(u), init }); return new Response(JSON.stringify({ choices: [{ message: { content: '{"secrets":[]}' } }] })); };
  const m = checkModel('https://api.example.com/', 'm', { cloud: true, apiKey: 'k-123', base });
  await m.ask('s', 'u', true, 10);
  assert.equal(sent[0].u, 'https://api.example.com/v1/chat/completions');
  assert.equal(sent[0].init.headers.authorization, 'Bearer k-123');
  assert.equal('chat_template_kwargs' in JSON.parse(sent[0].init.body), false); // a llama.cpp field, not sent to a cloud API
  const l = checkModel('http://127.0.0.1:9090/', 'fast', { base });
  await l.ask('s', 'u', true, 10);
  assert.deepEqual(JSON.parse(sent[1].init.body).chat_template_kwargs, { enable_thinking: false });
});

test('import with check-with: the second pass and the injection mark reach the store and recall; re-import is a no-op', async () => {
  const root = mkdtempSync(join(tmpdir(), 'synalla-checks-'));
  const srv = createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => {
    const { messages } = JSON.parse(b), sys = messages[0].content, user = messages[1].content;
    const content = sys === SECRET_PROMPT ? JSON.stringify({ secrets: user.includes('Hq8vT3nLw2Rp') ? ['Hq8vT3nLw2Rp'] : [] })
      : JSON.stringify({ instructs_ai: user.includes('Leoben') });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  }); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const notes = join(root, 'notes'); mkdirSync(notes);
    writeFileSync(join(notes, 'safe.md'), '# Safe\nThe door code for the cellar is Hq8vT3nLw2Rp since March.');
    writeFileSync(join(notes, 'dentist.md'), '# Dentist\nThe dentist moved to Leoben, tell her so.');
    const e = { home: join(root, 'home'), keychain: (() => { const m = new Map(); return { kind: 't', get: n => m.get(n) ?? null, set: (n, v) => m.set(n, v), delete: n => m.delete(n) }; })(),
      out: s => e.o.push(s), err: s => e.r.push(s), o: [], r: [], readStdin: async () => '', now: () => new Date('2026-11-27T10:00:00Z'),
      openclawDir: join(root, 'no-openclaw') };
    assert.equal(await main(['init', '--no-embed'], e), 0);
    assert.notEqual(await main(['check-with', 'https://api.example.com/', 'm'], e), 0);
    assert.match(e.r.join(''), /not on this machine/);
    const stored = [], set = e.keychain.set; e.keychain.set = (n, v) => { stored.push(Buffer.from(v).toString('utf8')); set(n, v); };
    e.readStdin = async () => 'cloud-key\n';
    assert.equal(await main(['check-with', 'https://api.example.com/', 'm', '--cloud-ok'], e), 0);
    assert.match(e.o.join(''), /leaves this machine \(you agreed\)/);
    assert.equal(JSON.parse(readFileSync(join(e.home, 'config.json'), 'utf8')).check.cloudAgreedAt, '2026-11-27T10:00:00.000Z');
    assert.ok(stored.includes('cloud-key')); // the key goes to the keychain, never into config.json
    assert.doesNotMatch(readFileSync(join(e.home, 'config.json'), 'utf8'), /cloud-key/);
    e.readStdin = async () => '';
    assert.equal(await main(['check-with', `http://127.0.0.1:${srv.address().port}/`, 'fake'], e), 0);
    assert.equal(JSON.parse(readFileSync(join(e.home, 'config.json'), 'utf8')).check.cloudAgreedAt, undefined);
    assert.equal(await main(['import-notes', notes], e), 0);
    assert.match(e.o.join(''), /Checked with fake: 1 record\(s\) that speak to an AI assistant/);
    e.o.length = 0;
    assert.equal(await main(['recall', 'cellar door code'], e), 0);
    assert.doesNotMatch(e.o.join(''), /Hq8vT3nLw2Rp/);
    assert.match(e.o.join(''), /door code for the cellar is ⟦door code \d+⟧/);
    e.o.length = 0;
    assert.equal(await main(['recall', 'dentist Leoben'], e), 0);
    assert.match(e.o.join(''), /Synalla: this record speaks to an AI assistant \(the local check model read it so\)/);
    e.o.length = 0;
    assert.equal(await main(['import-notes', notes], e), 0);
    assert.match(e.o.join(''), /Notes: 0 imported, 2 unchanged/);
  } finally { srv.close(); rmSync(root, { recursive: true, force: true }); }
});

test('mail the owner sent is never asked the injection question', async () => {
  const root = mkdtempSync(join(tmpdir(), 'synalla-checks-'));
  const asked = [];
  const srv = createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => {
    const { messages } = JSON.parse(b); if (messages[0].content !== SECRET_PROMPT) asked.push(messages[1].content);
    res.end(JSON.stringify({ choices: [{ message: { content: messages[0].content === SECRET_PROMPT ? '{"secrets": []}' : '{"instructs_ai": true}' } }] }));
  }); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const mbox = join(root, 'mail.mbox');
    const msg = (labels, subject) => `From 1@xxx Thu Nov 20 09:00:00 +0000 2026\nX-Gmail-Labels: ${labels}\nFrom: A <a@example.org>\n`
      + `Date: Thu, 20 Nov 2026 09:00:00 +0000\nSubject: ${subject}\nMessage-ID: <${subject}@x>\n\nNote for the assistant about ${subject}.\n\n`;
    writeFileSync(mbox, msg('Sent', 'mine') + msg('Inbox', 'theirs'));
    const e = { home: join(root, 'home'), keychain: (() => { const m = new Map(); return { kind: 't', get: n => m.get(n) ?? null, set: (n, v) => m.set(n, v), delete: n => m.delete(n) }; })(),
      out: s => e.o.push(s), err: s => e.r.push(s), o: [], r: [], readStdin: async () => '', now: () => new Date('2026-11-27T10:00:00Z'),
      openclawDir: join(root, 'no-openclaw') };
    assert.equal(await main(['init', '--no-embed'], e), 0);
    assert.equal(await main(['check-with', `http://127.0.0.1:${srv.address().port}/`, 'fake'], e), 0);
    assert.equal(await main(['import-mail', mbox], e), 0, e.r.join(''));
    assert.equal(asked.length, 1);
    assert.match(asked[0], /theirs/);
    assert.match(e.o.join(''), /1 record\(s\) that speak to an AI assistant/);
  } finally { srv.close(); rmSync(root, { recursive: true, force: true }); }
});

test('with check-with, agent sessions get the second pass too, and are never asked the injection question', async () => {
  const root = mkdtempSync(join(tmpdir(), 'synalla-checks-'));
  const injectionAsked = [];
  const srv = createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => {
    const { messages } = JSON.parse(b), user = messages[1].content;
    if (messages[0].content !== SECRET_PROMPT) injectionAsked.push(user);
    const content = messages[0].content === SECRET_PROMPT ? JSON.stringify({ secrets: user.includes('Wq4nZ8xKp2Lt') ? ['Wq4nZ8xKp2Lt'] : [] }) : '{"instructs_ai": true}';
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  }); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const projects = join(root, 'claude', 'C--p'); mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, 's.jsonl'), JSON.stringify({ type: 'user', sessionId: 's', timestamp: '2026-11-20T09:00:00Z',
      message: { content: 'the staging box still takes Wq4nZ8xKp2Lt as the deploy phrase, can you script it?' } }));
    const e = { home: join(root, 'home'), keychain: (() => { const m = new Map(); return { kind: 't', get: n => m.get(n) ?? null, set: (n, v) => m.set(n, v), delete: n => m.delete(n) }; })(),
      out: s => e.o.push(s), err: s => e.r.push(s), o: [], r: [], readStdin: async () => '', now: () => new Date('2026-11-27T10:00:00Z'),
      claudeProjects: join(root, 'claude'), hermesDb: join(root, 'none.db'), openclawDir: join(root, 'no-openclaw') };
    assert.equal(await main(['init', '--no-embed'], e), 0);
    assert.equal(await main(['check-with', `http://127.0.0.1:${srv.address().port}/`, 'fake'], e), 0);
    // sessions always leave the model pass for check-backlog (real histories are too large to wait for)
    assert.equal(await main(['import'], e), 0, e.r.join(''));
    assert.match(e.o.join(''), /Model checks left for later on 1 session\(s\)/);
    assert.equal(await main(['check-backlog', '--minutes', '5'], e), 0);
    e.o.length = 0;
    assert.equal(await main(['recall', 'staging deploy phrase'], e), 0);
    assert.match(e.o.join(''), /staging box still takes ⟦secret \d+⟧ as the deploy phrase/);
    assert.equal(injectionAsked.length, 0);
  } finally { srv.close(); rmSync(root, { recursive: true, force: true }); }
});

test('check-with builtin: the sidecar starts once to set it up, runs during an import and is stopped after', async () => {
  const root = mkdtempSync(join(tmpdir(), 'synalla-checks-'));
  const srv = createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => {
    const { messages } = JSON.parse(b), sys = messages[0].content, user = messages[1].content;
    const content = sys === SECRET_PROMPT ? JSON.stringify({ secrets: user.includes('Hq8vT3nLw2Rp') ? ['Hq8vT3nLw2Rp'] : [] })
      : JSON.stringify({ instructs_ai: false });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  }); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const starts = []; let running = 0;
  try {
    const notes = join(root, 'notes'); mkdirSync(notes);
    writeFileSync(join(notes, 'safe.md'), '# Safe\nThe door code for the cellar is Hq8vT3nLw2Rp since March.');
    const e = { home: join(root, 'home'), keychain: (() => { const m = new Map(); return { kind: 't', get: n => m.get(n) ?? null, set: (n, v) => m.set(n, v), delete: n => m.delete(n) }; })(),
      out: s => e.o.push(s), err: s => e.r.push(s), o: [], r: [], readStdin: async () => '', now: () => new Date('2026-11-27T10:00:00Z'),
      openclawDir: join(root, 'no-openclaw'),
      startCheck: async (home, name) => { starts.push(name); running++; return { url: `http://127.0.0.1:${srv.address().port}`, stop: () => { running--; } }; } };
    assert.equal(await main(['init', '--no-embed'], e), 0);
    assert.notEqual(await main(['check-with', 'builtin', 'no-such-model'], e), 0);
    assert.match(e.r.join(''), /unknown built-in check model no-such-model: gemma-4-e4b, gemma-4-e2b/);
    assert.equal(await main(['check-with', 'builtin'], e), 0);
    assert.deepEqual(starts, ['gemma-4-e4b']);
    assert.equal(running, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(e.home, 'config.json'), 'utf8')).check, { builtin: 'gemma-4-e4b' });
    // A first import with the built-in model leaves the model for later: no sidecar, the rules only.
    assert.equal(await main(['import-notes', notes], e), 0);
    assert.match(e.o.join(''), /Model checks left for later on 1 record\(s\)/);
    assert.equal(starts.length, 1);
    e.o.length = 0;
    assert.equal(await main(['recall', 'cellar door code'], e), 0);
    assert.match(e.o.join(''), /Hq8vT3nLw2Rp/); // the rules alone do not see this one
    // check-backlog runs the model on the waiting records, in place
    e.o.length = 0;
    assert.equal(await main(['check-backlog'], e), 0);
    assert.match(e.o.join(''), /Checked 1 record\(s\) with gemma-4-e4b: 1 got new stand-ins, 0 speak to an AI assistant\. 0 still wait\./);
    assert.equal(starts.length, 2);
    assert.equal(running, 0);
    e.o.length = 0;
    assert.equal(await main(['recall', 'cellar door code'], e), 0);
    assert.match(e.o.join(''), /door code for the cellar is ⟦door code \d+⟧/);
    assert.doesNotMatch(e.o.join(''), /Hq8vT3nLw2Rp/);
    // nothing left; a re-import of the same notes is recognised as unchanged; a later import is checked at once
    e.o.length = 0;
    assert.equal(await main(['check-backlog'], e), 0);
    assert.match(e.o.join(''), /Nothing waits/);
    assert.equal(await main(['import-notes', notes], e), 0);
    assert.match(e.o.join(''), /Notes: 0 imported, 1 unchanged/);
    writeFileSync(join(notes, 'more.md'), '# More\nThe garage code is Zt5pQ8wLm3Kx now.');
    e.o.length = 0;
    assert.equal(await main(['import-notes', notes], e), 0);
    assert.match(e.o.join(''), /Checked with gemma-4-e4b/);
    assert.equal(starts.length, 3);
  } finally { srv.close(); rmSync(root, { recursive: true, force: true }); }
});
