// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial
// Tests for src/scrub.ts (from the software-factory contract).
const TARGET = 'scrub.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeScenario, runScenario, GOLDEN_SEEDS } from './fixtures/scrub/scenarios.mjs';

const implPath = path.join(import.meta.dirname, '..', 'src', TARGET);
const impl = await import(pathToFileURL(implPath).href);
const { KINDS, marker, scrub } = impl;
const kinds = s => scrub(s).found.map(f => f.kind);
const ALL = ['private-key', 'url-password', 'jwt', 'aws-access-key', 'github-token', 'anthropic-key', 'openai-key', 'stripe-key',
  'slack-token', 'google-api-key', 'prefixed-token', 'nostr-secret', 'auth-header', 'assignment', 'high-entropy'];

test('the file meets the final check: words, at most 120 lines, no line over 200 characters, no repeated block', () => {
  const raw = fs.readFileSync(implPath, 'utf8');
  const BANNED = [/\bimport\b/, /\bfrom\s*['"`]/, /\brequire\b/, /\bprocess\b/, /\bglobalThis\b/, /\bglobal\b/, /\beval\b/, /\bFunction\s*\(/,
    /\.constructor\b/, /\bfetch\b/, /\bMath\.random\b/, /\bDate\b/, /\bperformance\b/, /\bcrypto\b/, /\bconsole\b/];
  for (const re of BANNED) assert.ok(!re.test(raw), 'banned word or pattern ' + re);
  const lines = raw.split('\n');
  assert.ok(lines.length <= 120, `${lines.length} lines (max 120)`);
  lines.forEach((l, i) => assert.ok(l.length <= 200, `line ${i + 1} has ${l.length} characters (max 200)`));
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const norm = code.split('\n').map(l => l.trim()).filter(l => l.length > 2), seen = new Map();
  for (let i = 0; i + 6 <= norm.length; i++) {
    const blk = norm.slice(i, i + 6).join('\n');
    assert.ok(!(seen.has(blk) && i - seen.get(blk) >= 6), 'a block of 6+ lines appears twice: ' + norm[i]);
    if (!seen.has(blk)) seen.set(blk, i);
  }
});

test('exports exactly three names', () => {
  assert.deepEqual(Object.keys(impl).sort(), ['KINDS', 'marker', 'scrub']);
  assert.deepEqual(KINDS, ALL);
});

test('marker', () => {
  assert.equal(marker('jwt'), '[secret:jwt]');
  for (const k of ALL) assert.equal(marker(k), '[secret:' + k + ']');
  for (const v of ['JWT', 'jwt ', '', 'nope', 'toString', '__proto__', ['jwt'], new String('jwt'), null, undefined, 1, {}])
    assert.throws(() => marker(v), TypeError, String(v));
});

test('scrub: bad input throws', () => {
  for (const v of [null, undefined, 1, [], {}, true, new String('x')]) assert.throws(() => scrub(v), TypeError);
});

test('scrub: the spec examples', () => {
  assert.deepEqual(scrub('token=Zm9vYmFyYmF6cXV4'), { text: 'token=[secret:assignment]', found: [{ kind: 'assignment', start: 6, end: 22 }] });
  assert.equal(scrub('DB_PASSWORD=correcthorse9').text, 'DB_PASSWORD=[secret:assignment]');
  for (const s of ['PASSWORD_FILE=/etc/x', 'secret = true', 'token: string', '{ password: hashedPassword }', 'token = getToken()', 'api_key=${API_KEY}', 'input_token: 123456'])
    assert.deepEqual(scrub(s), { text: s, found: [] }, s);
  assert.equal(scrub('password = "password"').text, 'password = "[secret:assignment]"');
  assert.equal(scrub('postgres://admin:S3cr3tPass!@db.local:5432/app').text, 'postgres://admin:[secret:url-password]@db.local:5432/app');
  assert.equal(scrub('redis://:hunter22@host').text, 'redis://:[secret:url-password]@host');
  assert.equal(scrub('https://abc:abc@x.io').text, 'https://abc:[secret:url-password]@x.io');
  assert.deepEqual(scrub('key AKIAIOSFODNN7EXAMPLE here').found, [{ kind: 'aws-access-key', start: 4, end: 24 }]);
  assert.equal(scrub('Authorization: Basic dXNlcjpwYXNz').text, 'Authorization: Basic [secret:auth-header]');
  assert.deepEqual(scrub('commit 3f786850e387550fdab836ed7e6dc881de23001b').found, []);
  assert.equal(scrub('export ANTHROPIC_API_KEY=sk-ant-api03-AbCdEf0123456789_xyz').text, 'export ANTHROPIC_API_KEY=[secret:anthropic-key]');
  assert.deepEqual(scrub(''), { text: '', found: [] });
});

test('scrub: the value sits at the end of the match', () => {
  assert.deepEqual(scrub('amqp://xyz:a@h.io').found, [{ kind: 'url-password', start: 11, end: 12 }]);
  assert.deepEqual(scrub('token: "token1"').found, [{ kind: 'assignment', start: 8, end: 14 }]);
});

test('scrub: one example of each kind', () => {
  assert.deepEqual(kinds('-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nIBAAK\n-----END RSA PRIVATE KEY-----\nnext line'), ['private-key']);
  assert.deepEqual(kinds('-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----'), ['private-key']);
  assert.equal(scrub('-----BEGIN PRIVATE KEY-----\nMIIEow\nAbCd==\n(truncated)').text, '[secret:private-key]\n(truncated)');
  assert.deepEqual(kinds('redis://u:p4ss@h.local'), ['url-password']);
  assert.deepEqual(kinds('eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4'), ['jwt']);
  assert.deepEqual(kinds('ghp_' + 'a1B2'.repeat(9)), ['github-token']);
  assert.deepEqual(kinds('sk-proj-' + 'Ab3_'.repeat(6)), ['openai-key']);
  assert.deepEqual(kinds('sk_live_' + 'Ab3d'.repeat(5)), ['stripe-key']);
  assert.deepEqual(kinds('xoxb-1234567890-abc'), ['slack-token']);
  assert.deepEqual(kinds('AIza' + 'Sy0_-'.repeat(7)), ['google-api-key']);
  assert.deepEqual(kinds('hf_' + 'AbCdEfGhIj'.repeat(2)), ['prefixed-token']);
  assert.deepEqual(kinds('nsec1' + 'q'.repeat(58)), ['nostr-secret']);
  assert.deepEqual(kinds('authorization: bearer abcdefghijklmnop1234'), ['auth-header']);
  assert.deepEqual(kinds("api_key: 'abc123xyz789'"), ['assignment']);
  assert.deepEqual(kinds('"SecretAccessKey": "wJalrXUtnFEMI/K7MDENG"'), ['assignment']);
  assert.deepEqual(kinds('blob q8Zr4TfW2mN9xKp3LvB7cYd1HsJ6gE0aQw5RtUz'), ['high-entropy']);
});

test('scrub: every key word of rule 14 is recognised', () => {
  for (const k of ['password', 'passwd', 'passphrase', 'secret', 'token', 'apikey', 'api_key', 'api-key', 'accesskey', 'access_key',
    'secret_key', 'secretkey', 'private_key', 'private-key', 'privatekey', 'secret_access_key', 'SecretAccessKey', 'client_secret',
    'auth_token', 'authToken', 'access_token', 'refreshToken', 'session-token', 'id_token', 'PRIVATE_KEY', 'DB_PASSWORD'])
    assert.equal(scrub(k + ' = "Xy7_secret-9"').text, k + ' = "[secret:assignment]"', k);
});

test('scrub: an unclosed quote is not a value', () => {
  for (const s of ['token="s6E0Gx', "password='abc123x", 'secret = "short9	next'])
    assert.deepEqual(kinds(s), [], s);
});

test('scrub: ordinary text is left alone', () => {
  for (const s of ['id 123e4567-e89b-12d3-a456-426614174000', 'const veryLongCamelCaseIdentifierName2Here = 1',
    'see src/components/MyComponent2/index.tsx and https://example.com/a/b', 'my_secret_sauce = tomato', 'token: 5',
    'password: string;', 'apiKey: apiKey,', 'secret: config.secret', 'password=os.environ["DB_PASSWORD"]', 'PWD=/c/Claude/x', 'token: expired',
    '--model=Qwen3-Coder-30B-A3B-Instruct-Q4_K_M', 'sk-learn-compatible-estimator-wrapper', 'https://host:443?x=1&email=a@b.com',
    'integrity sha512-AbCdEf0123456789GhIjKlMnOpQrStUvWxYz012345==', 'Token management is hard',
    'the api key is in the vault', 'Merci pour ton message !', 'sk-short', 'AKIA1234', 'nsec1' + 'q'.repeat(57), 'xAKIAIOSFODNN7EXAMPLE'])
    assert.deepEqual(scrub(s), { text: s, found: [] }, s);
});

test('scrub: rule order and span-only overlap', () => {
  assert.deepEqual(kinds('sk-ant-' + 'a1B2'.repeat(6)), ['anthropic-key']);
  assert.deepEqual(kinds('token = sk-ant-' + 'a1B2'.repeat(6)), ['anthropic-key']);
  assert.deepEqual(kinds('Bearer ' + 'Zq8Rk2Lm4Np6Tv0Xb3Hd5Jf7Gc9Wa1Ys'), ['auth-header']);
  assert.deepEqual(kinds('eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4_token=hunter22x'), ['jwt', 'assignment']);
});

test('scrub: offsets count UTF-16 code units', () => {
  assert.deepEqual(scrub('👍 AKIAIOSFODNN7EXAMPLE').found, [{ kind: 'aws-access-key', start: 3, end: 23 }]);
});

test('scrub: a megabyte of awkward text takes well under two seconds', () => {
  const t = performance.now();
  scrub('a.'.repeat(500000)); scrub('a+'.repeat(500000)); scrub('x://'.repeat(250000));
  assert.ok(performance.now() - t < 2000);
});

test('scrub: fresh results', () => {
  const a = scrub('x'), b = scrub('x');
  assert.notEqual(a, b); assert.notEqual(a.found, b.found);
  a.found.push(1); assert.deepEqual(scrub('x').found, []);
});

for (const seed of GOLDEN_SEEDS) {
  test(`golden scenario ${seed}`, () => {
    const golden = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'scrub', 'golden.json'), 'utf8'))[seed];
    const steps = makeScenario(seed);
    const got = runScenario(impl, steps);
    for (let i = 0; i < golden.length; i++) assert.deepEqual(got[i], golden[i], `step ${i}: ${JSON.stringify(steps[i]).slice(0, 300)}`);
  });
}
