// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// Round 5 of the secret scrubber (../blind/README.md): after the rules, a local chat model is asked about each line
// that still holds a mixed token of 8+ characters; values it names that occur in the line word for word are hidden.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrub } from '../../../src/scrub.ts';
// The scrubber's own placeholder check through its public function: inside `password = "..."` the rules hide any
// value except a placeholder, a masked value or public material.
const isPlaceholder = v => !v.includes('"') && scrub(`password = "${v}"`).found.length === 0;

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPT = readFileSync(join(HERE, 'prompt.txt'), 'utf8');
const CACHE = join(HERE, 'cache'); mkdirSync(CACHE, { recursive: true });
const THINK = process.env.SCRUB_THINK === '1'; // thinking on: about 15 s a line with fast; off: about 1 s
const URL_ = process.env.SCRUB_MODEL_URL ?? 'http://127.0.0.1:9090/v1/chat/completions', MODEL = process.env.SCRUB_MODEL ?? 'fast';
export const stats = { asked: 0, cached: 0, secs: 0 };

const kinds = t => +/[A-Za-z]/.test(t) + +/[0-9]/.test(t) + +/[^A-Za-z0-9]/.test(t);
const candidate = line => line.split(/\s+/).some(t => t.length >= 8 && kinds(t.replace(/[.,;:!?)"'»]+$/, '')) >= 2);

async function ask(context, line) {
  const key = createHash('sha256').update(PROMPT + '\0' + context + '\0' + line + (THINK ? '' : '\0nothink')).digest('hex');
  const f = join(CACHE, key + '.json');
  if (existsSync(f)) { stats.cached++; return JSON.parse(readFileSync(f, 'utf8')); }
  const t0 = Date.now();
  const r = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    model: MODEL, temperature: 0, max_tokens: THINK ? 1500 : 300, ...(THINK ? {} : { chat_template_kwargs: { enable_thinking: false } }), response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: (context ? `CONTEXT:\n${context}\n\n` : '') + `LINE:\n${line}` }] }) });
  const j = await r.json(); const txt = j.choices?.[0]?.message?.content ?? '';
  let secrets = [];
  try { const o = JSON.parse(txt.replace(/^```(?:json)?\s*|\s*```$/g, '')); if (Array.isArray(o.secrets)) secrets = o.secrets.filter(s => typeof s === 'string'); } catch { /* unreadable: nothing */ }
  stats.asked++; stats.secs += (Date.now() - t0) / 1000;
  writeFileSync(f, JSON.stringify(secrets));
  return secrets;
}

// Revision 1 (from sets 1 and 2 only, before set 3): a value the model names is hidden only if the scrubber's own
// checks agree it could be one: not a placeholder (USER, PASSWORD, ${VAR}, <...>, EXAMPLE, masked), not a plain word,
// and not named as public, publishable, a fingerprint, an id or a user or login name just before it.
const PUBLIC_BEFORE = /(?:public|publishable|fingerprint|thumbprint|key id|\bid|user(?:name)?|login|anmeldename|benutzer(?:name)?|identifiant)\b[^\n]{0,25}$/i;
function keep(s, line) {
  if (s.length < 4 || !line.includes(s) || /^\[secret:|\[secret:/.test(s) || isPlaceholder(s)) return false;
  if (/^[\p{L}]+$/u.test(s) && s.length < 12) return false; // a plain word
  const before = line.slice(0, line.indexOf(s));
  return !PUBLIC_BEFORE.test(before) && !/[A-Za-z][\w+.-]*:\/\/$/.test(before); // not the user part of a URL
}

/** Rules first, then the model on the lines that need it. Returns the scrubbed text. */
export async function scrubTwoPass(text) {
  const first = scrub(text).text;
  const lines = first.split('\n'), out = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (candidate(line.replace(/\[secret:[a-z-]+\]/g, ''))) {
      const ctx = lines.slice(Math.max(0, i - 3), i).join('\n');
      for (const s of await ask(ctx, line)) if (keep(s, line)) line = line.split(s).join('[secret:model]');
    }
    out.push(line);
  }
  return out.join('\n');
}
