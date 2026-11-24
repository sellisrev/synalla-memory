// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { macKeychain, linuxSecretService, windowsDpapi, systemKeychain } from '../src/keychain.ts';

const key = new Uint8Array(randomBytes(32));
const hex = Buffer.from(key).toString('hex');

function recorder(answers = []) {
  const calls = [];
  const r = (cmd, args, input) => { calls.push({ cmd, args, input }); return answers.shift() ?? { status: 0, stdout: '', stderr: '' }; };
  return { r, calls };
}

test('macOS: the secret goes on stdin to `security -i`, never in arguments; not found is null', () => {
  const { r, calls } = recorder([{ status: 0, stdout: '', stderr: '' }, { status: 0, stdout: hex + '\n', stderr: '' }, { status: 44, stdout: '', stderr: '' }]);
  const k = macKeychain(r);
  k.set('store', key);
  assert.deepEqual(calls[0].args, ['-i']);
  assert.match(calls[0].input, new RegExp(`-w ${hex}`));
  assert.deepEqual([...k.get('store')], [...key]);
  assert.equal(calls.some(c => c.args.join(' ').includes(hex)), false);
  assert.equal(k.get('backup'), null);
});

test('Linux: secret-tool store reads the secret from stdin', () => {
  const { r, calls } = recorder([{ status: 0, stdout: '', stderr: '' }, { status: 0, stdout: hex, stderr: '' }, { status: 1, stdout: '', stderr: '' }]);
  const k = linuxSecretService(r);
  k.set('store', key);
  assert.equal(calls[0].input, hex);
  assert.equal(calls[0].args.join(' ').includes(hex), false);
  assert.deepEqual([...k.get('store')], [...key]);
  assert.equal(k.get('other'), null);
});

test('names are checked; garbage from the keychain is refused', () => {
  const k = macKeychain(() => ({ status: 0, stdout: 'not hex', stderr: '' }));
  assert.throws(() => k.get('../x'), TypeError);
  assert.throws(() => k.get('store'), /not a key/);
  assert.equal(systemKeychain('darwin').kind, 'macOS Keychain');
  assert.equal(systemKeychain('linux').kind, 'Secret Service (libsecret)');
});

test('Windows DPAPI, for real on Windows: round trip, file holds no plaintext, delete', () => {
  if (process.platform !== 'win32') return; // the macOS and Linux paths are covered with a recorded runner above
  const dir = mkdtempSync(join(tmpdir(), 'synalla-kc-'));
  try {
    const k = windowsDpapi(undefined, join(dir, "it's keys"));
    assert.equal(k.get('store'), null);
    k.set('store', key);
    assert.deepEqual([...k.get('store')], [...key]);
    const [f] = readdirSync(join(dir, "it's keys"));
    const blob = readFileSync(join(dir, "it's keys", f));
    assert.equal(blob.includes(Buffer.from(key)), false);
    assert.equal(blob.includes(Buffer.from(hex)), false);
    k.delete('store');
    assert.equal(k.get('store'), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
