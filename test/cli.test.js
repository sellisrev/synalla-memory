// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, reminders } from '../src/cli.ts';
import { toRecoveryCode, fromRecoveryCode } from '../src/recovery_code.ts';

function fakeKeychain() {
  const m = new Map();
  return { kind: 'test keychain', get: n => m.get(n) ?? null, set: (n, v) => m.set(n, new Uint8Array(v)), delete: n => m.delete(n), m };
}
function env(home, extra = {}) {
  const out = [], err = [];
  return { home, keychain: fakeKeychain(), out: s => out.push(s), err: s => err.push(s), readStdin: async () => '',
    now: () => new Date('2026-11-24T10:00:00Z'), outText: () => out.join(''), errText: () => err.join(''), ...extra };
}

test('init, import, recall, backup, then restore elsewhere with only the recovery code', async () => {
  const root = mkdtempSync(join(tmpdir(), 'synalla-cli-'));
  try {
    const projects = join(root, 'claude', 'C--proj'); mkdirSync(projects, { recursive: true });
    const rec = o => JSON.stringify({ sessionId: 's1', timestamp: '2026-11-20T09:00:00Z', ...o });
    writeFileSync(join(projects, 's1.jsonl'), [rec({ type: 'user', message: { content: 'Our landlord is Frau Kerschbaumer.' } }),
      rec({ type: 'assistant', message: { content: [{ type: 'text', text: 'Noted.' }] } })].join('\n'));
    const a = env(join(root, 'home-a'), { claudeProjects: join(root, 'claude'), hermesDb: join(root, 'no-hermes', 'state.db') });
    assert.equal(await main(['init', '--dim', '8'], a), 0);
    const code = a.outText().match(/RECOVERY CODE[^\n]*\n\n\s+(\S+)/)[1];
    const id = JSON.parse(readFileSync(join(root, 'home-a', 'config.json'), 'utf8')).id;
    assert.deepEqual(fromRecoveryCode(code), a.keychain.get(`backup-${id}`));
    assert.equal(await main(['init'], a), 1, 'refuses to init twice');
    assert.equal(await main(['import'], a), 0);
    assert.match(a.outText(), /1 session\(s\) imported/);
    assert.equal(await main(['recall', 'landlord?'], a), 0);
    assert.match(a.outText(), /Frau Kerschbaumer/);
    assert.equal(await main(['backup'], a), 1);
    assert.match(a.errText(), /choose a place first/);
    const cloud = join(root, 'cloud');
    assert.equal(await main(['backup-to', 'folder', cloud], a), 0);
    assert.equal(await main(['backup'], a), 0);
    assert.match(a.outText(), /Snapshot 1:/);
    assert.equal(await main(['status'], a), 0);
    assert.match(a.outText(), /1 snapshot\(s\) there/);

    const b = env(join(root, 'home-b'), { keychain: a.keychain }); // same machine, same keychain
    assert.equal(await main(['restore', join(root, 'home-b'), '--code', code.toLowerCase(), '--from', 'folder', cloud], b), 0, b.errText());
    assert.equal(await main(['recall', 'landlord'], b), 0);
    assert.match(b.outText(), /Frau Kerschbaumer/);
    assert.equal(await main(['recall', 'landlord'], a), 0, 'the first memory still opens: keys are per memory');
    assert.equal(await main(['restore', join(root, 'home-b'), '--code', code, '--from', 'folder', cloud], b), 1, 'never overwrites');

    const wrong = env(join(root, 'home-c'));
    const bad = code.slice(0, 3) + (code[3] === 'A' ? 'B' : 'A') + code.slice(4);
    assert.equal(await main(['restore', join(root, 'home-c'), '--code', bad, '--from', 'folder', cloud], wrong), 1);
    assert.match(wrong.errText(), /typo/);

    assert.equal(await main(['export', '--plain', join(root, 'readable')], a), 0);
    assert.ok(existsSync(join(root, 'readable', 'synalla-memory', 'readable', 'claude-code', '2026-11.md')));
    assert.match(a.outText(), /NOT encrypted/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('without init every command says how to start; unknown commands print usage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'synalla-cli-'));
  try {
    const e = env(join(root, 'none'));
    assert.equal(await main(['status'], e), 1);
    assert.match(e.errText(), /run `synalla-memory init` first/);
    assert.equal(await main(['nope'], e), 2);
    assert.equal(await main([], e), 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reminders: no backup place, stale backup, and the yearly Koofr login', () => {
  const now = new Date('2026-11-24T10:00:00Z');
  assert.match(reminders({ id: 'x', dim: 8 }, now)[0], /No backup place/);
  assert.match(reminders({ dim: 8, backup: { type: 'folder', path: 'x' }, lastBackup: '2026-11-01T00:00:00Z' }, now)[0], /last 3 days/);
  const koofr = { dim: 8, backup: { type: 'webdav', url: 'https://app.koofr.net/dav/Koofr', user: 'u' }, lastBackup: now.toISOString() };
  assert.match(reminders(koofr, now)[0], /Log in to Koofr/);
  assert.deepEqual(reminders({ ...koofr, koofrLoginAt: '2026-01-01T00:00:00Z' }, now), []);
  assert.match(reminders({ ...koofr, koofrLoginAt: '2025-11-01T00:00:00Z' }, now)[0], /Log in to Koofr/);
  assert.deepEqual(reminders({ ...koofr, backup: { type: 'webdav', url: 'https://cloud.example.org/dav', user: 'u' } }, now), []);
});

test('recovery code: round trip, forgiving input, typos refused', () => {
  const k = new Uint8Array(32).map((_, i) => i * 7);
  const c = toRecoveryCode(k);
  assert.match(c, /^([0-9A-HJKMNP-TV-Z]{5}-){10}[0-9A-HJKMNP-TV-Z]{5}$/);
  assert.deepEqual(fromRecoveryCode(c.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l')), k);
  assert.throws(() => fromRecoveryCode('short'), /not a recovery code/);
  assert.throws(() => toRecoveryCode(new Uint8Array(3)), TypeError);
});
