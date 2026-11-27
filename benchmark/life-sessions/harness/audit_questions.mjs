// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// Independent check of the reference answers (RULES.md, "Questions"): for each person, a model that did not write the
// generator reads the person's sessions exactly as the systems ingest them, plus the questions and references, and
// flags references the sessions do not support. It never sees the storylines, the truth or any system's answer.
// Every flag must quote the session text it rests on; flags whose quote is not in the sessions are dropped.
// Output: <out>/audit_<person>.json and <out>/AUDIT.md. Usage:
//   node benchmark/life-sessions/harness/audit_questions.mjs [--set out] [--model opus] [--jobs 3] [--only L01,L02]

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SET = resolve(HERE, '..', arg('--set', 'out')), MODEL = arg('--model', 'opus'), JOBS = Number(arg('--jobs', '3'));
const ONLY = arg('--only', '') ? new Set(arg('--only', '').split(',')) : null;
const CLAUDE = process.platform === 'win32' ? 'claude.exe' : 'claude';

function sessionsText(person) {
  const dir = join(SET, person, 'sessions');
  const parts = [];
  for (const f of readdirSync(dir).filter(x => x.endsWith('.jsonl')).sort()) {
    let title = '', day = '';
    const turns = [];
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.type === 'ai-title') title = j.aiTitle ?? '';
      if (j.type !== 'user' && j.type !== 'assistant') continue;
      day ||= String(j.timestamp ?? '').slice(0, 10);
      const c = j.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join('\n') : '';
      if (text.trim()) turns.push(`${j.type === 'user' ? 'User' : 'Assistant'}: ${text.trim()}`);
    }
    parts.push(`=== Session ${f.replace('.jsonl', '')} (${day}) ${title}\n${turns.join('\n')}`);
  }
  return parts.join('\n\n');
}

const TYPES = 'Types: now = what is true at the end; before = the earlier value; when = the date something happened; '
  + 'considered = something only considered or a what-if, not done; whose = the fact about the person, not a look-alike '
  + 'about someone else; need = whether a need is still open or met; needs_now = the list of needs still open at the end; '
  + 'none = the sessions do not contain it (the right answer is that it is not in memory).';

function prompt(person, sessions, qs) {
  return `You are checking a memory benchmark's reference answers. Below are all the conversations one person had with `
    + `their AI assistant over six weeks, in date order, then questions the person asks after the last session, each with `
    + `the benchmark's reference answer. Check every reference against the sessions only.\n\n${TYPES}\n\n`
    + 'For each question give a verdict:\n'
    + '- "ok": the sessions support the reference as the answer.\n'
    + '- "wrong": the sessions show a different answer.\n'
    + '- "incomplete": the reference is right but leaves out something the question asks for, or a reasonable reader of the '
    + 'sessions could give a different answer that should also count (say which).\n'
    + '- "unsupported": the sessions never establish the reference (for type none: the sessions do contain the answer).\n'
    + 'For every verdict other than "ok", quote the exact words from the sessions that show it (copy them character for '
    + 'character, at most 300 characters) and name the session number. Be strict but fair: small wording differences are '
    + 'ok; dates may omit the year.\n\nReply with JSON only: {"<question id>": {"verdict": "...", "why": "...", '
    + '"quote": "...", "session": "NNN", "better_reference": "..."}, ...} with "quote", "session" and "better_reference" '
    + `only when the verdict is not "ok".\n\nSESSIONS OF ${person}\n\n${sessions}\n\nQUESTIONS\n\n`
    + JSON.stringify(qs.map(q => ({ id: q.id, type: q.type, question: q.question, reference: q.gold })), null, 1);
}

function ask(text) {
  return new Promise((res, rej) => {
    const child = spawn(CLAUDE, ['-p', '--model', MODEL, '--output-format', 'json', '--no-session-persistence', '--tools', '',
      '--strict-mcp-config', '--setting-sources', 'project'], { env: { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => child.kill(), 1800000);
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    child.on('close', code => { clearTimeout(t); code === 0 ? res(out) : rej(new Error(`exit ${code}: ${err.slice(-400)}`)); });
    child.stdin.end(text);
  });
}

const norm = s => String(s ?? '').replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();

async function audit(person, qs) {
  const f = join(SET, `audit_${person}.json`);
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  const sessions = sessionsText(person), flat = norm(sessions);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = JSON.parse(await ask(prompt(person, sessions, qs)));
      const t = String(r.result ?? '');
      const v = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
      const missing = qs.filter(q => !v[q.id]).map(q => q.id);
      if (missing.length) throw new Error(`no verdict for ${missing.join(', ')}`);
      for (const q of qs) {
        const x = v[q.id];
        if (x.verdict !== 'ok') x.quote_found = !!x.quote && flat.includes(norm(x.quote).replace(/^\.\.\.|\.\.\.$/g, '').trim());
      }
      const out = { person, model: MODEL, verdicts: v, cost: r.total_cost_usd ?? null };
      writeFileSync(f, JSON.stringify(out, null, 1));
      return out;
    } catch (e) { console.log(`${person} attempt ${attempt}: ${e.message.slice(0, 200)}`); }
  }
  throw new Error(`${person}: no audit`);
}

const questions = JSON.parse(readFileSync(join(SET, 'questions.json'), 'utf8'));
const people = [...new Set(questions.map(q => q.person))].filter(p => !ONLY || ONLY.has(p));
const results = [];
let next = 0;
await Promise.all(Array.from({ length: JOBS }, async () => {
  while (next < people.length) {
    const p = people[next++];
    const r = await audit(p, questions.filter(q => q.person === p));
    results.push(r);
    const flags = Object.values(r.verdicts).filter(x => x.verdict !== 'ok');
    console.log(`${p}: ${flags.length} flagged (${flags.filter(x => x.quote_found).length} with a quote found in the sessions)`);
  }
}));
const rows = [];
for (const r of results.sort((a, b) => a.person.localeCompare(b.person)))
  for (const [id, x] of Object.entries(r.verdicts)) if (x.verdict !== 'ok' && x.quote_found) {
    const q = questions.find(y => y.id === id);
    rows.push(`| ${id} | ${q.type} | ${x.verdict} | ${q.question.replace(/\|/g, '/')} | ${q.gold.replace(/\|/g, '/')} | ${String(x.better_reference ?? '').replace(/\|/g, '/')} | ${String(x.why ?? '').replace(/\|/g, '/').replace(/\n/g, ' ')} |`);
  }
const dropped = results.flatMap(r => Object.entries(r.verdicts).filter(([, x]) => x.verdict !== 'ok' && !x.quote_found).map(([id]) => id));
writeFileSync(join(SET, 'AUDIT.md'), ['# Reference check by a second model', '', `${MODEL}, ${results.length} people, ${questions.filter(q => !ONLY || ONLY.has(q.person)).length} questions. `
  + `Flags kept only when their quote is in the sessions; ${dropped.length} flags dropped for a quote not found (${dropped.join(', ') || 'none'}).`, '',
  '| Question | Type | Verdict | Question text | Reference | Suggested | Why |', '|---|---|---|---|---|---|---|', ...rows, ''].join('\n'));
console.log(`DONE: ${rows.length} flags kept, ${dropped.length} dropped`);
