// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial
// The M1 bar for the secret scrubber, kept as a test so no change can quietly lower it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../benchmark/scrub/heldout.mjs';

test('held-out planted secrets: at least 95% caught, at most 2% of harmless look-alikes changed', () => {
  const r = evaluate();
  assert.equal(r.planted, 400); assert.equal(r.harmless, 400);
  assert.ok(r.caught / r.planted >= 0.95, `caught ${r.caught}/${r.planted}; missed ${r.missedExamples.join(', ')}`);
  assert.ok(r.falsePositives / r.harmless <= 0.02, `false positives ${r.falsePositives}: ${JSON.stringify(r.fpByKind)}`);
});

test('prose rule: file paths after "password ...:" are not secrets; a mixed value after "token:" is', async () => {
  const { scrub } = await import('../src/scrub.ts');
  const path = 'removed the password and saved an unlocked copy: `C:\Users\me\Downloads\payslip_2026_1.pdf`';
  assert.equal(scrub(path).text, path);
  assert.equal(scrub('the key is at: /home/me/keys/id_ed25519').text, 'the key is at: /home/me/keys/id_ed25519');
  assert.equal(scrub('the key is at: ./keys/id_ed25519_backup').text, 'the key is at: ./keys/id_ed25519_backup');
  assert.equal(scrub('token: Tr0ub4dor3xyz9').text, 'token: [secret:assignment]');
});
