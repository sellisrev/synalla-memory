// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// Scores rules + model (second_pass.mjs) on a blind set with the same rules as ../blind/eval.mjs.
// Usage (repo root): node --import ./tools/ts-resolve.mjs benchmark/scrub/model/eval.mjs --set 1|2|3|4
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrub } from '../../../src/scrub.ts';
import { scrubTwoPass, stats } from './second_pass.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SET = process.argv.includes('--set') ? process.argv[process.argv.indexOf('--set') + 1] : '1', SUFFIX = SET === '1' ? '' : SET;
const LIMIT = process.argv.includes('--limit') ? Number(process.argv[process.argv.indexOf('--limit') + 1]) : Infinity;
const set = JSON.parse(readFileSync(join(HERE, '..', 'blind', 'set' + SUFFIX + '.json'), 'utf8')).slice(0, LIMIT);
const credential = s => { const m = /^[a-z][a-z0-9+.-]*:\/\/[^\s:@\/]*:([^\s@\/]+)@/i.exec(s); return SET !== '1' && m ? m[1] : s; };
const leaks = (secret, out) => { secret = credential(secret); if (secret.length < 8) return out.includes(secret);
  for (let i = 0; i + 8 <= secret.length; i++) if (out.includes(secret.slice(i, i + 8))) return true; return false; };
const wilson = (k, n) => { const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), w = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [(c - w) / d, (c + w) / d].map(x => (100 * x).toFixed(1)); };
let sc = 0, sn = 0, hc = 0, hn = 0, rc = 0, rh = 0; const list = [];
for (const [i, s] of set.entries()) {
  const rules = scrub(s.text).text, out = await scrubTwoPass(s.text);
  if (s.secrets.length) for (const sec of s.secrets) { sn++; if (!leaks(sec, out)) sc++; if (!leaks(sec, rules)) rc++; else if (!leaks(sec, out)) list.push(['NEWCATCH', s.id]); }
  else { hn++; if (out !== s.text) { hc++; if (rules === s.text) list.push(['NEWFP', s.id, out]); } if (rules !== s.text) rh++; }
  if (i % 100 === 99) console.error(`${i + 1}/${set.length} asked ${stats.asked} cached ${stats.cached}`);
}
console.log(`set ${SET}: rules ${rc}/${sn} caught, ${rh}/${hn} harmless changed`);
console.log(`set ${SET}: rules+model ${sc}/${sn} = ${(100 * sc / sn).toFixed(1)}% caught (${wilson(sc, sn).join('-')}), ${hc}/${hn} = ${(100 * hc / hn).toFixed(1)}% harmless changed (${wilson(hc, hn).join('-')})`);
console.log(`model calls ${stats.asked} (${stats.asked ? (stats.secs / stats.asked).toFixed(2) : 0} s each), cached ${stats.cached}`);
if (process.argv.includes('--list')) for (const x of list) console.log(JSON.stringify(x).slice(0, 400));
