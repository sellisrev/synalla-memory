// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial
//
// Picks the LongMemEval subset used for Synalla's public number, by a rule fixed and published before any run.
//   node select.mjs <path to longmemeval_oracle.json>   -> writes subset.json
// Rule: 100 of the 500 questions. Strata are (question_type, abstention or not). Each stratum gets its share of 100
// (count / 5), rounded down, at least 1; the seats left go to the largest remainders (ties: stratum name). Within a
// stratum, question ids are ordered by SHA-256(SEED + id) and the first n are taken.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

export const SEED = 'synalla-longmemeval-subset-2026-11-24';
export const ORACLE_SHA256 = '821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c';
export const SIZE = 100;

export function select(questions) {
  const strata = new Map();
  for (const q of questions) {
    const k = `${q.question_type}${q.question_id.endsWith('_abs') ? ' (abstention)' : ''}`;
    if (!strata.has(k)) strata.set(k, []);
    strata.get(k).push(q.question_id);
  }
  const names = [...strata.keys()].sort();
  const quota = new Map(names.map(n => {
    const exact = (strata.get(n).length * SIZE) / questions.length;
    return [n, { n: Math.max(1, Math.floor(exact)), rem: exact - Math.floor(exact) }];
  }));
  let left = SIZE - [...quota.values()].reduce((s, q) => s + q.n, 0);
  for (const n of [...names].sort((a, b) => quota.get(b).rem - quota.get(a).rem || (a < b ? -1 : 1))) {
    if (left <= 0) break;
    quota.get(n).n++; left--;
  }
  const h = id => createHash('sha256').update(SEED + id).digest('hex');
  const out = {};
  for (const n of names) out[n] = [...strata.get(n)].sort((a, b) => (h(a) < h(b) ? -1 : 1)).slice(0, quota.get(n).n);
  return out;
}

if (process.argv[2]) {
  const raw = readFileSync(process.argv[2]);
  const sha = createHash('sha256').update(raw).digest('hex');
  if (sha !== ORACLE_SHA256) throw new Error(`oracle file checksum ${sha} is not the pinned ${ORACLE_SHA256}`);
  const strata = select(JSON.parse(raw.toString('utf8')));
  const ids = Object.values(strata).flat();
  writeFileSync(new URL('./subset.json', import.meta.url), JSON.stringify({ seed: SEED, oracleSha256: ORACLE_SHA256, size: ids.length, strata }, null, 1) + '\n');
  console.log(Object.entries(strata).map(([k, v]) => `${k}: ${v.length}`).join('\n'), `\ntotal ${ids.length}`);
}
