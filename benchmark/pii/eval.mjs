// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// Money and ID numbers blind set (README.md). `build` turns the writers' batches (raw/*.json) into set<N>.json:
// checks every value occurs in its text, makes IBAN check digits, card Luhn digits and French NIR keys valid (in the
// text and the truth). `score` runs src/pii.ts on the set once and reports against the bars.
// Usage (repo root): node --import ./tools/ts-resolve.mjs benchmark/pii/eval.mjs build|score [--set N] [--list]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPii } from '../../src/pii.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SET = arg('--set', '1'), RAW = join(HERE, SET === '1' ? 'raw' : `raw${SET}`), OUT = join(HERE, `set${SET === '1' ? '' : SET}.json`);

function ibanFix(v) { // keeps the format (spaces, case), recomputes the two check digits
  const compact = v.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(compact)) return v;
  const r = (compact.slice(4) + compact.slice(0, 2) + '00').replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
  let m = 0; for (const d of r) m = (m * 10 + Number(d)) % 97;
  const check = String(98 - m).padStart(2, '0');
  let seen = 0;
  return v.replace(/[0-9A-Za-z]/g, ch => { seen++; return seen === 3 ? check[0] : seen === 4 ? check[1] : ch; });
}
function luhnFix(v) {
  const digits = v.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return v;
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i++) { let x = Number(body[body.length - 1 - i]); if (i % 2 === 0) { x *= 2; if (x > 9) x -= 9; } sum += x; }
  const check = String((10 - (sum % 10)) % 10);
  let n = 0;
  return v.replace(/\d/g, d => (++n === digits.length ? check : d));
}
function nirFix(v) {
  const d = v.replace(/\s/g, '');
  if (!/^[12]\d{4}(?:\d{2}|2[AB])\d{6}\d{2}$/i.test(d)) return v;
  const body = d.slice(0, 13).toUpperCase().replace('2A', '19').replace('2B', '18');
  const key = String(97 - Number(BigInt(body) % 97n)).padStart(2, '0');
  let n = 0, total = d.length;
  return v.replace(/[0-9AB]/gi, c => { n++; return n === total - 1 ? key[0] : n === total ? key[1] : c; });
}
const masked = v => /[*•x]{3,}|X{3,}/.test(v);

function build() {
  const recs = [], problems = [];
  for (const f of readdirSync(RAW).filter(f => f.endsWith('.json')).sort()) {
    let batch;
    try { batch = JSON.parse(readFileSync(join(RAW, f), 'utf8')); } catch (e) { problems.push(`${f}: not JSON (${e.message})`); continue; }
    for (const r of batch) {
      if (typeof r.text !== 'string' || !Array.isArray(r.values)) { problems.push(`${f} ${r.id}: bad shape`); continue; }
      let text = r.text; const values = [];
      for (const v of r.values) {
        if (!text.includes(v.value)) { problems.push(`${f} ${r.id}: value not in text`); continue; }
        let fixed = v.value;
        if (!masked(fixed)) {
          if (v.kind === 'iban') fixed = ibanFix(fixed);
          else if (v.kind === 'card-number') fixed = luhnFix(fixed);
          else if (v.kind === 'social-security-number' && /^\s*[12]/.test(fixed) && fixed.replace(/\s/g, '').length === 15) fixed = nirFix(fixed);
        }
        text = text.split(v.value).join(fixed);
        values.push({ value: fixed, kind: v.kind });
      }
      recs.push({ id: r.id, batch: f.replace('.json', ''), text, values });
    }
  }
  writeFileSync(OUT, JSON.stringify(recs, null, 1));
  console.log(`${recs.length} records (${recs.filter(r => r.values.length).length} positive, ${recs.filter(r => !r.values.length).length} harmless), ${recs.reduce((a, r) => a + r.values.length, 0)} values; problems: ${problems.length}`);
  for (const p of problems) console.log('  ' + p);
}

const wilson = (k, n) => { const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), w = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [(c - w) / d, (c + w) / d].map(x => (100 * x).toFixed(1)); };

function score() {
  const set = JSON.parse(readFileSync(OUT, 'utf8')), list = process.argv.includes('--list');
  let caught = 0, total = 0, harmless = 0, changed = 0, extra = 0;
  const byKind = {}, misses = [], fps = [];
  for (const r of set) {
    const spans = findPii(r.text);
    let out = '', at = 0; for (const s of spans) { out += r.text.slice(at, s.start) + '⟦X⟧'; at = s.end; } out += r.text.slice(at);
    const leaks = v => v.length < 8 ? out.includes(v) : [...Array(v.length - 7).keys()].some(i => out.includes(v.slice(i, i + 8)));
    if (!r.values.length) { harmless++; if (spans.length) { changed++; fps.push([r.id, spans.map(s => r.text.slice(s.start, s.end))]); } continue; }
    for (const v of r.values) {
      total++; const k = (byKind[v.kind] ??= { caught: 0, total: 0 }); k.total++;
      if (!leaks(v.value)) { caught++; k.caught++; } else misses.push([r.id, v.kind, v.value]);
    }
    for (const s of spans) { const t = r.text.slice(s.start, s.end); if (!r.values.some(v => v.value.includes(t) || t.includes(v.value))) { extra++; fps.push([r.id, [t]]); } }
  }
  console.log(`caught ${caught}/${total} = ${(100 * caught / total).toFixed(1)}% (${wilson(caught, total).join('-')}); bar 95%`);
  console.log(`harmless changed ${changed}/${harmless} = ${(100 * changed / harmless).toFixed(1)}% (${wilson(changed, harmless).join('-')}); bar 2%`);
  console.log(`extra hides in positive records: ${extra}`);
  for (const [k, v] of Object.entries(byKind)) console.log(`  ${k}: ${v.caught}/${v.total}`);
  if (list) { for (const m of misses) console.log('MISS', JSON.stringify(m)); for (const f of fps) console.log('FP', JSON.stringify(f)); }
}

process.argv[2] === 'build' ? build() : process.argv[2] === 'score' ? score() : console.error('usage: eval.mjs build|score');
