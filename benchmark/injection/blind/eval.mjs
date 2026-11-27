// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// Scores src/speaks_to_agent.ts on the blind set (../README.md, "Blind set"): caught = an injection snippet marked,
// false positive = a harmless snippet marked. --list prints misses and false positives (read only after recording).
// Usage (repo root): node --import ./tools/ts-resolve.mjs benchmark/injection/blind/eval.mjs [--list]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { speaksToAgent } from '../../../src/speaks_to_agent.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const set = JSON.parse(readFileSync(join(HERE, 'set.json'), 'utf8'));
const wilson = (k, n) => { const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), w = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [(c - w) / d, (c + w) / d].map(x => (100 * x).toFixed(1)); };
const rows = set.map(s => ({ ...s, why: speaksToAgent(s.text) }));
const inj = rows.filter(r => r.injection), harm = rows.filter(r => !r.injection);
const c = inj.filter(r => r.why).length, f = harm.filter(r => r.why).length;
const lines = [`injections marked ${c}/${inj.length} = ${(100 * c / inj.length).toFixed(1)}% (95% interval ${wilson(c, inj.length).join('-')}%)`,
  `harmless marked ${f}/${harm.length} = ${(100 * f / harm.length).toFixed(1)}% (95% interval ${wilson(f, harm.length).join('-')}%)`, ''];
const by = key => { const g = new Map(); for (const r of rows) { const k = r[key]; if (!g.has(k)) g.set(k, [0, 0, 0, 0]); const x = g.get(k);
  if (r.injection) { x[1]++; if (r.why) x[0]++; } else { x[3]++; if (r.why) x[2]++; } } return [...g].map(([k, x]) => `| ${k} | ${x[0]}/${x[1]} | ${x[2]}/${x[3]} |`); };
lines.push('| Writer | Injections marked | Harmless marked |', '|---|---:|---:|', ...by('writer'), '', '| Theme | Injections marked | Harmless marked |', '|---|---:|---:|', ...by('theme'));
console.log(lines.join('\n'));
writeFileSync(join(HERE, 'RESULT.md'), `# Injection defence, blind set\n\n${lines.join('\n')}\n`);
if (process.argv.includes('--list')) for (const r of rows) if (!!r.why !== r.injection) console.log(`${r.injection ? 'MISS' : 'FP'} ${r.id} ${r.why ?? ''}\n  ${JSON.stringify(r.text).slice(0, 500)}`);
