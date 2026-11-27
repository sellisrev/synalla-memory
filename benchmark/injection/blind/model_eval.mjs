// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// Round 2 of the injection defence (../README.md): a local chat model asked the plain question (prompt.txt) about each
// record of the blind set, alone and combined with the rules (marked if either says so). Thinking off, temperature 0.
// Usage (repo root): node --import ./tools/ts-resolve.mjs benchmark/injection/blind/model_eval.mjs [--list]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { speaksToAgent } from '../../../src/speaks_to_agent.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPT = readFileSync(join(HERE, 'prompt.txt'), 'utf8');
const CACHE = join(HERE, 'cache'); mkdirSync(CACHE, { recursive: true });
const URL_ = process.env.INJ_MODEL_URL ?? 'http://127.0.0.1:9090/v1/chat/completions', MODEL = process.env.INJ_MODEL ?? 'fast';
let asked = 0, secs = 0;
async function ask(text) {
  const f = join(CACHE, createHash('sha256').update(PROMPT + '\0' + MODEL + '\0' + text).digest('hex') + '.json');
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  const t0 = Date.now();
  const r = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, temperature: 0,
    max_tokens: 50, chat_template_kwargs: { enable_thinking: false }, messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: text }] }) });
  const j = await r.json(); const t = j.choices?.[0]?.message?.content ?? '';
  const yes = /"instructs_ai"\s*:\s*true/.test(t);
  asked++; secs += (Date.now() - t0) / 1000; writeFileSync(f, JSON.stringify(yes)); return yes;
}
const wilson = (k, n) => { const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), w = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [(c - w) / d, (c + w) / d].map(x => (100 * x).toFixed(1)); };
const set = JSON.parse(readFileSync(join(HERE, 'set.json'), 'utf8'));
const rows = [];
for (const [i, s] of set.entries()) { rows.push({ ...s, model: await ask(s.text), rules: !!speaksToAgent(s.text) }); if (i % 100 === 99) console.error(`${i + 1}/${set.length}`); }
const line = (name, pick) => { const inj = rows.filter(r => r.injection), h = rows.filter(r => !r.injection); const c = inj.filter(pick).length, f = h.filter(pick).length;
  return `${name}: injections marked ${c}/${inj.length} = ${(100 * c / inj.length).toFixed(1)}% (${wilson(c, inj.length).join('-')}), harmless marked ${f}/${h.length} = ${(100 * f / h.length).toFixed(1)}% (${wilson(f, h.length).join('-')})`; };
const out = [line('rules', r => r.rules), line('model', r => r.model), line('rules or model', r => r.rules || r.model), `model calls ${asked} (${asked ? (secs / asked).toFixed(2) : 0} s each)`];
console.log(out.join('\n'));
writeFileSync(join(HERE, MODEL === 'fast' ? 'RESULT_model.md' : `RESULT_model_${MODEL}.md`), `# Injection defence, blind set: local model (${MODEL}, thinking off)\n\n${out.join('\n')}\n`);
if (process.argv.includes('--list')) for (const r of rows) if (r.model !== r.injection) console.log(`${r.injection ? 'MISS' : 'FP'} ${r.id}\n  ${JSON.stringify(r.text).slice(0, 400)}`);
