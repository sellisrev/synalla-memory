// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// Scores the secret scrubber on the blind set (README.md). A secret counts as caught when no 8 characters of it in a
// row remain in the scrubbed text (a partly masked key still gives a lot away); a harmless snippet counts as a false
// positive when the scrubber changes it at all. Prints totals, by writer and by theme; with --list, the misses and
// false positives themselves (read them only once the set is retired: looking at them makes it less blind).
// Usage: node --import ../../../tools/ts-resolve.mjs eval.mjs [--list]

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrub } from '../../../src/scrub.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SET = process.argv.includes('--set') ? process.argv[process.argv.indexOf('--set') + 1] : '1', SUFFIX = SET === '1' ? '' : SET;
const set = JSON.parse(readFileSync(join(HERE, 'set' + SUFFIX + '.json'), 'utf8'));

/** Rule from set 2 on: a URL with a password counts by its password only. */
function credential(secret) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^\s:@\/]*:([^\s@\/]+)@/i.exec(secret);
  return SET !== '1' && m ? m[1] : secret;
}

function leaks(secret, out) {
  secret = credential(secret);
  if (secret.length < 8) return out.includes(secret);
  for (let i = 0; i + 8 <= secret.length; i++) if (out.includes(secret.slice(i, i + 8))) return true;
  return false;
}

function wilson(k, n) {
  const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), w = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - w) / d, (c + w) / d].map(x => (100 * x).toFixed(1));
}

export function evaluate() {
  const rows = [];
  for (const s of set) {
    const out = scrub(s.text).text;
    if (s.secrets.length) for (const sec of s.secrets) rows.push({ id: s.id, writer: s.writer, theme: s.theme, kind: 'secret', ok: !leaks(sec, out), secret: sec, text: s.text, out });
    else rows.push({ id: s.id, writer: s.writer, theme: s.theme, kind: 'harmless', ok: out === s.text, text: s.text, out });
  }
  return rows;
}

const rows = evaluate();
const sec = rows.filter(r => r.kind === 'secret'), harm = rows.filter(r => r.kind === 'harmless');
const caught = sec.filter(r => r.ok).length, fp = harm.filter(r => !r.ok).length;
const lines = [`secrets caught ${caught}/${sec.length} = ${(100 * caught / sec.length).toFixed(1)}% (95% interval ${wilson(caught, sec.length).join('-')}%)`,
  `harmless changed ${fp}/${harm.length} = ${(100 * fp / harm.length).toFixed(1)}% (95% interval ${wilson(fp, harm.length).join('-')}%)`, ''];
const by = key => {
  const g = new Map();
  for (const r of rows) { const k = r[key]; if (!g.has(k)) g.set(k, { s: 0, c: 0, h: 0, f: 0 }); const x = g.get(k); if (r.kind === 'secret') { x.s++; if (r.ok) x.c++; } else { x.h++; if (!r.ok) x.f++; } }
  return [...g].map(([k, x]) => `| ${k} | ${x.c}/${x.s} | ${x.f}/${x.h} |`);
};
lines.push('| Writer | Caught | Harmless changed |', '|---|---:|---:|', ...by('writer'), '', '| Theme | Caught | Harmless changed |', '|---|---:|---:|', ...by('theme'));
console.log(lines.join('\n'));
writeFileSync(join(HERE, 'RESULT' + SUFFIX + '.md'), `# Secret scrubber, blind set\n\n${lines.join('\n')}\n`);
if (process.argv.includes('--list')) {
  for (const r of sec.filter(r => !r.ok)) console.log(`MISS ${r.id}: ${JSON.stringify(r.secret)}\n  in: ${JSON.stringify(r.text).slice(0, 300)}\n  out: ${JSON.stringify(r.out).slice(0, 300)}`);
  for (const r of harm.filter(r => !r.ok)) console.log(`FP ${r.id}:\n  in: ${JSON.stringify(r.text).slice(0, 300)}\n  out: ${JSON.stringify(r.out).slice(0, 300)}`);
}
