// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// Secret scrubber: replaces secrets in imported text with markers before anything is stored (pilot plan W1).
// Spec: test/fixtures/scrub/SPEC.md. Reviewed by two adversarial reviews; built by hand after local-model builds failed.

export const KINDS = ['private-key', 'url-password', 'jwt', 'aws-access-key', 'github-token', 'anthropic-key',
  'openai-key', 'stripe-key', 'slack-token', 'google-api-key', 'prefixed-token', 'nostr-secret', 'auth-header',
  'assignment', 'high-entropy'];

export function marker(kind: unknown): string {
  if (typeof kind !== 'string' || !KINDS.includes(kind)) throw new TypeError('unknown kind');
  return '[secret:' + kind + ']';
}

const B = '(?<![A-Za-z0-9_-])';
const E = '(?![A-Za-z0-9_-])';
const PK = '-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY( BLOCK)?-----';
const PK_END = '-----END ([A-Z0-9]+ )*PRIVATE KEY( BLOCK)?-----';
const KEYS = 'password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key'
  + '|secret[_-]?access[_-]?key|client[_-]?secret|auth[_-]?token|(?:access|refresh|session|id)[_-]?token';
const TYPES = '(?:string|number|boolean|bigint|null|undefined|true|false|none|any|unknown|void)(?![A-Za-z0-9_])';
const BARE = '(?![$%{<(\\[\\/~.]|' + TYPES + ')(?=[^\\s\'",;()\\[\\]{}]*[A-Za-z])(?=[^\\s\'",;()\\[\\]{}]*[^A-Za-z.\\s\'",;()\\[\\]{}])'
  + '([^\\s\'",;()\\[\\]{}]{6,4096})';
const AUTH = '\\bauthorization\\s*[:=]\\s*["\']?(?:bearer|basic|token)\\s+([A-Za-z0-9._~+\\/=-]{8,})'
  + '|\\bbearer\\s+([A-Za-z0-9._~+\\/=-]{16,})';

// [kind, regex, value groups]: no groups = the whole match is the span; otherwise the first group that matched.
const RULES: [string, RegExp, number[]][] = [
  ['private-key', new RegExp(PK + '(?:[\\s\\S]*?' + PK_END + '|(?:\\r?\\n[A-Za-z0-9+\\/=]+)*)', 'g'), []],
  ['url-password', /:\/\/([^\s:@\/?#]*):([^\s@\/?#]+)@/g, [2]],
  ['jwt', new RegExp(B + 'eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}' + E, 'g'), []],
  ['aws-access-key', new RegExp(B + '(AKIA|ASIA)[A-Z0-9]{16}' + E, 'g'), []],
  ['github-token', new RegExp(B + '(gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})' + E, 'g'), []],
  ['anthropic-key', new RegExp(B + 'sk-ant-[A-Za-z0-9_-]{20,}' + E, 'g'), []],
  ['openai-key', new RegExp(B + 'sk-(proj-)?(?=[A-Za-z_-]*[0-9])[A-Za-z0-9_-]{20,}' + E, 'g'), []],
  ['stripe-key', new RegExp(B + '(sk|rk)_(live|test)_[A-Za-z0-9]{16,}' + E, 'g'), []],
  ['slack-token', new RegExp(B + 'xox[abposr]-[A-Za-z0-9-]{10,}' + E, 'g'), []],
  ['google-api-key', new RegExp(B + 'AIza[A-Za-z0-9_-]{35}' + E, 'g'), []],
  ['prefixed-token', new RegExp(B + '(hf_|glpat-|whsec_|npm_|gsk_|pypi-|dop_v1_|shp(?:at|ss|ca|pa)_)[A-Za-z0-9_-]{20,}' + E, 'g'), []],
  ['prefixed-token', new RegExp(B + 'SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}' + E, 'g'), []],
  ['nostr-secret', new RegExp(B + 'nsec1[02-9ac-hj-np-z]{58}' + E, 'g'), []],
  ['auth-header', new RegExp(AUTH, 'gi'), [1, 2]],
  ['assignment', new RegExp('(?<![A-Za-z0-9-])--?(?:' + KEYS + '|key|pass|auth)(?![A-Za-z0-9])(?:=|[ \\t]+)' + BARE, 'gi'), [1]],
  // "the key you asked for: VALUE", "token: VALUE" in prose: a value that mixes letters and digits, on the same line.
  ['assignment', new RegExp('(?<![A-Za-z0-9])(?:key|token|password|passphrase|secret|credential)s?(?![A-Za-z0-9])[^\\n:]{0,40}:[ \\t]+'
    + '(?![`]|[A-Za-z]:[\\\\/]|\\.{0,2}\\/)(?=[^\\s]*[0-9])(?=[^\\s]*[A-Za-z])([^\\s\'",;()\\[\\]{}]{12,4096})', 'gi'), [1]],
  ['assignment', new RegExp('(?<![A-Za-z0-9])(?:' + KEYS + ')(?![A-Za-z0-9])["\']?\\s*[:=]\\s*'
    + '(?:"([^"\\n]{6,4096})"|\'([^\'\\n]{6,4096})\'|' + BARE + ')', 'gi'), [1, 2, 3]],
];

function entropy(s: string): number {
  const n: Record<string, number> = {};
  for (const c of s) n[c] = (n[c] ?? 0) + 1;
  let h = 0;
  for (const k of Object.keys(n)) { const p = (n[k] as number) / s.length; h -= p * Math.log2(p); }
  return h;
}

export function scrub(text: unknown): { text: string; found: { kind: string; start: number; end: number }[] } {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  const spans: { kind: string; start: number; end: number }[] = [];
  const free = (s: number, e: number) => spans.every(x => e <= x.start || s >= x.end);
  for (const [kind, re, groups] of RULES) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      let value = m[0], start = m.index;
      if (groups.length > 0) {
        value = groups.map(g => m![g]).find(v => v !== undefined) as string;
        start = m.index + m[0].lastIndexOf(value);
      }
      if (free(start, start + value.length)) spans.push({ kind, start, end: start + value.length });
    }
  }
  const tok = /[A-Za-z0-9+\/_-]+=*/g;
  for (let m = tok.exec(text); m !== null; m = tok.exec(text)) {
    const t = m[0];
    if (t.length >= 32 && /[0-9]/.test(t) && /[a-z]/.test(t) && /[A-Z]/.test(t) && /[A-Za-z0-9]{20}/.test(t)
        && !/^(sha(1|256|384|512)-|AAAA)/.test(t) && !/\/[a-z]+\/|^\/|\/$/.test(t) && entropy(t) >= 4.2 && free(m.index, m.index + t.length))
      spans.push({ kind: 'high-entropy', start: m.index, end: m.index + t.length });
  }
  spans.sort((a, b) => a.start - b.start);
  let out = '', at = 0;
  for (const s of spans) { out += text.slice(at, s.start) + marker(s.kind); at = s.end; }
  return { text: out + text.slice(at), found: spans };
}
