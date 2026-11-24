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
