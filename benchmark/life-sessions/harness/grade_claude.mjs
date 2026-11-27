// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// Claude as the second blind grader (grade.py's other family): every question of <run>/grading_input.json, in batches,
// through Claude Code in print mode (no tools, no CLAUDE.md). Same rules and letters as the local grader; writes
// <run>/grades_claude.json ({question id: {letter: score}}), resumable per batch (<run>/claude_batches/).
// Usage: node benchmark/life-sessions/harness/grade_claude.mjs <run dir> [--model opus] [--batch 15] [--jobs 2]

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const run = resolve(process.argv[2] ?? '');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const MODEL = arg('--model', 'opus'), BATCH = Number(arg('--batch', '15')), JOBS = Number(arg('--jobs', '2'));
const input = JSON.parse(readFileSync(join(run, 'grading_input.json'), 'utf8'));
const bdir = join(run, 'claude_batches'); mkdirSync(bdir, { recursive: true });
const CLAUDE = process.platform === 'win32' ? 'claude.exe' : 'claude';
const LETTERS = 'XYZWVUTS';

function prompt(items) {
  return `You are grading answers from memory systems, blind. ${input.rules}\n\n`
    + 'Each item has a question, the reference answer, and answers under letters. Grade every letter of every item with '
    + '1, 0.5 or 0. Judge only against the reference; do not reward style or length. Reply with JSON only, no prose: '
    + '{"<item id>": {"<letter>": <score>, ...}, ...}\n\nItems:\n' + JSON.stringify(items, null, 1);
}

function ask(text) {
  return new Promise((res, rej) => {
    const child = spawn(CLAUDE, ['-p', '--model', MODEL, '--output-format', 'json', '--no-session-persistence', '--tools', '',
      '--strict-mcp-config', '--setting-sources', 'project'], { env: { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => child.kill(), 900000);
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    child.on('close', code => { clearTimeout(t); code === 0 ? res(out) : rej(new Error(`exit ${code}: ${err.slice(-500)}`)); });
    child.stdin.end(text);
  });
}

function check(items, grades) {
  for (const it of items) {
    const g = grades[it.id];
    if (!g) throw new Error(`no grades for ${it.id}`);
    for (const L of LETTERS) if (L in it && ![0, 0.5, 1].includes(g[L])) throw new Error(`${it.id} ${L}: ${g[L]}`);
  }
}

async function batch(i, items) {
  const f = join(bdir, `b${String(i).padStart(3, '0')}.json`);
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8')).grades;
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = JSON.parse(await ask(prompt(items)));
      const text = String(r.result ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '');
      const grades = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      check(items, grades);
      writeFileSync(f, JSON.stringify({ ids: items.map(x => x.id), grades, cost: r.total_cost_usd ?? null, usage: r.usage ?? null }, null, 1));
      return grades;
    } catch (e) { last = e; console.log(`batch ${i} attempt ${attempt}: ${e.message.slice(0, 200)}`); }
  }
  throw last;
}

const batches = [];
for (let i = 0; i < input.items.length; i += BATCH) batches.push(input.items.slice(i, i + BATCH));
const all = {};
let next = 0, done = 0;
await Promise.all(Array.from({ length: JOBS }, async () => {
  while (next < batches.length) {
    const i = next++;
    Object.assign(all, await batch(i, batches[i]));
    console.log(`batch ${i + 1}/${batches.length} done (${++done})`);
  }
}));
const ordered = Object.fromEntries(input.items.map(it => [it.id, all[it.id]]));
writeFileSync(join(run, 'grades_claude.json'), JSON.stringify(ordered, null, 1));
console.log(`DONE ${Object.keys(ordered).length} questions -> grades_claude.json`);
