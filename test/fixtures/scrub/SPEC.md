# scrub.ts: remove secrets from text before it is stored

Write `scrub.ts`: TypeScript that Node runs directly by stripping types. Use only erasable syntax: no `enum`,
`namespace`, parameter properties or decorators. The file has no imports and touches no clock, randomness, network,
console or globals. Functions are pure: they never change their arguments and return new objects and arrays.

The final check rejects the file if:
- any of these appears as a whole word anywhere, even in comments or strings (a longer word containing one is fine;
  a hyphen counts as a word boundary): `import`, `require`, `process`, `globalThis`, `global`, `eval`, `Function(`,
  `.constructor`, `fetch`, `Math.random`, `Date`, `performance`, `crypto`, `console`;
- the word `from` is followed by a quote character anywhere (so never write `from '` or `from "`, even in comments);
- it has more than 120 lines (the trailing newline counts as a line) or any line over 200 characters;
- the same block of 6 or more lines appears twice.

Several patterns below are longer than 200 characters, so build them with `new RegExp(...)` from string pieces joined
with `+`, and double every backslash inside the strings (`'\\s'` in the source is the regex `\s`). The pieces are
given below ready to copy.

## Background

A personal memory imports a developer's agent sessions, mail and notes. Sessions often contain secrets: API keys
pasted into a terminal, a database URL with its password, a private key. Before anything is stored, this module
replaces each secret with a marker, so it never reaches the store, a cloud model or a backup. It must not replace
ordinary text the owner will want to recall later: commit hashes, UUIDs, file paths, type annotations, model names.

The caller passes **decoded** text: for JSON lines it parses them and scrubs each string value, so `\n` in the input
is a real line break, not a backslash and an `n`.

## Exports (exactly these three names)

### `KINDS`
This array of 15 strings, in this order:
`'private-key', 'url-password', 'jwt', 'aws-access-key', 'github-token', 'anthropic-key', 'openai-key', 'stripe-key',
'slack-token', 'google-api-key', 'prefixed-token', 'nostr-secret', 'auth-header', 'assignment', 'high-entropy'`.

### `marker(kind)`
Returns `'[secret:' + kind + ']'`, for example `marker('jwt')` is `'[secret:jwt]'`. Throws a `TypeError` unless
`typeof kind === 'string'` and `kind` is one of `KINDS` (check with `KINDS.includes(kind)`; never convert the argument,
so `['jwt']`, `new String('jwt')` and `'toString'` all throw).

### `scrub(text)`
Throws a `TypeError` unless `typeof text === 'string'` (so `new String('x')` throws). Otherwise returns
`{ text, found }`:
- `found`: the secrets found, as `{ kind, start, end }` objects (`start` inclusive, `end` exclusive, indexes into the
  **input** string in UTF-16 code units, as JavaScript strings index), sorted by `start`. Spans never overlap and are
  never empty.
- `text`: the input with each span replaced by `marker(kind)`, everything else unchanged.

## Finding the spans

Rules 1 to 14 are regular expressions, run **in this order**, each over the **input** string with `exec` in a loop
(set `lastIndex = 0` first). Use exactly the flags given: `g` for all, plus `i` for rules 13 and 14; no other flags.

For each match, the **span** is the whole match, except for rules 2, 13 and 14, whose span is the **value group**:
the first of the listed groups that is not `undefined`, at `start = match.index + match[0].lastIndexOf(value)` (the
value always sits at the end of the match or just before a closing quote or `@`). Keep the span only if it overlaps
no span kept so far (`a.start < b.end && b.start < a.end` means overlap); only the span is compared, never the rest
of the match. Whether a match is kept or not, the loop simply continues from where the regex left off.

Pieces used below (copy them as JavaScript strings, exactly as written here between backquotes):
- `B` = `'(?<![A-Za-z0-9_-])'` and `E` = `'(?![A-Za-z0-9_-])'`: the secret may not be glued to other token characters.
- `PK` = `'-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY( BLOCK)?-----'`
- `PK_END` = `'-----END ([A-Z0-9]+ )*PRIVATE KEY( BLOCK)?-----'`
- `KEYS` = `'password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key'`
  + `'|secret[_-]?access[_-]?key|client[_-]?secret|auth[_-]?token|(?:access|refresh|session|id)[_-]?token'`
- `TYPES` = `'(?:string|number|boolean|bigint|null|undefined|true|false|none|any|unknown|void)(?![A-Za-z0-9_])'`
- `BARE` = `'(?![$%{<(\\[\\/~.]|' + TYPES + ')(?=[^\\s\'",;()\\[\\]{}]*[A-Za-z])(?=[^\\s\'",;()\\[\\]{}]*[^A-Za-z.\\s\'",;()\\[\\]{}])'`
  + `'([^\\s\'",;()\\[\\]{}]{6,4096})'`

The rules (the regex source is the concatenation shown; `+` joins pieces):

| # | kind | regex source | span |
|---|---|---|---|
| 1 | `private-key` | `PK + '(?:[\\s\\S]*?' + PK_END + '\|(?:\\r?\\n[A-Za-z0-9+\\/=]+)*)'` | whole match |
| 2 | `url-password` | `':\\/\\/([^\\s:@\\/?#]*):([^\\s@\\/?#]+)@'` | group 2 |
| 3 | `jwt` | `B + 'eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}' + E` | whole match |
| 4 | `aws-access-key` | `B + '(AKIA\|ASIA)[A-Z0-9]{16}' + E` | whole match |
| 5 | `github-token` | `B + '(gh[pousr]_[A-Za-z0-9]{36,255}\|github_pat_[A-Za-z0-9_]{22,255})' + E` | whole match |
| 6 | `anthropic-key` | `B + 'sk-ant-[A-Za-z0-9_-]{20,}' + E` | whole match |
| 7 | `openai-key` | `B + 'sk-(proj-)?(?=[A-Za-z_-]*[0-9])[A-Za-z0-9_-]{20,}' + E` | whole match |
| 8 | `stripe-key` | `B + '(sk\|rk)_(live\|test)_[A-Za-z0-9]{16,}' + E` | whole match |
| 9 | `slack-token` | `B + 'xox[abposr]-[A-Za-z0-9-]{10,}' + E` | whole match |
| 10 | `google-api-key` | `B + 'AIza[A-Za-z0-9_-]{35}' + E` | whole match |
| 11 | `prefixed-token` | `B + '(hf_\|glpat-\|whsec_\|npm_\|gsk_\|pypi-\|dop_v1_\|shp(?:at\|ss\|ca\|pa)_)[A-Za-z0-9_-]{20,}' + E` | whole match |
| 11b | `prefixed-token` | `B + 'SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}' + E` (SendGrid) | whole match |
| 12 | `nostr-secret` | `B + 'nsec1[02-9ac-hj-np-z]{58}' + E` | whole match |
| 13 | `auth-header` | `'\\bauthorization\\s*[:=]\\s*["\']?(?:bearer\|basic\|token)\\s+([A-Za-z0-9._~+\\/=-]{8,})'` + `'\|\\bbearer\\s+([A-Za-z0-9._~+\\/=-]{16,})'` | group 1, else 2 |
| 13b | `assignment` | `'(?<![A-Za-z0-9-])--?(?:' + KEYS + '\|key\|pass\|auth)(?![A-Za-z0-9])(?:=\|[ \\t]+)' + BARE` (a command-line flag) | group 1 |
| 13c | `assignment` | `'(?<![A-Za-z0-9])(?:key\|token\|password\|passphrase\|secret\|credential)s?(?![A-Za-z0-9])[^\\n:]{0,40}:[ \\t]+'` + `'(?=[^\\s]*[0-9])(?=[^\\s]*[A-Za-z])([^\\s\'",;()\\[\\]{}]{12,4096})'` (prose: "the key you asked for: VALUE") | group 1 |
| 14 | `assignment` | `'(?<![A-Za-z0-9])(?:' + KEYS + ')(?![A-Za-z0-9])["\']?\\s*[:=]\\s*'` + `'(?:"([^"\\n]{6,4096})"\|\'([^\'\\n]{6,4096})\'\|' + BARE + ')'` | group 1, 2 or 3 |

(In the table, `\|` stands for a plain `|`; the backslash is only there because of the table format.)

What rule 14 means in words: a key word such as `password`, `DB_PASSWORD`, `apiKey`, `"accessToken"` followed by `:`
or `=` and a value of 6 or more characters. A quoted value is always taken. An unquoted value is skipped when it
starts with `$ % { < ( [ / ~ .`, is a type word (`string`, `true`, ...), or is only letters and dots (a variable name
such as `hashedPassword` or `config.secret`); it needs at least one letter and one character that is not a letter or a
dot, and it stops at whitespace, quotes, `,` `;` and brackets.

Then the **high-entropy** step (kind `'high-entropy'`): run `/[A-Za-z0-9+\/_-]+=*/g` over the **input** (`/` is a token
character, so base64 secrets with `/` stay whole). A match (a
"token") becomes a span if all hold:
- its length is at least 32;
- it contains a digit, a lowercase letter `a-z` and an uppercase letter `A-Z`;
- it contains a run of at least 20 characters from `[A-Za-z0-9]` (so model names like
  `Qwen3-Coder-30B-A3B-Instruct-Q4_K_M` don't qualify: their pieces are short);
- it does not start with `sha1-`, `sha256-`, `sha384-`, `sha512-` (integrity hashes) or `AAAA` (SSH public keys);
- it does not look like a path: no `/lowercase/` segment, and it neither starts nor ends with `/`;
- its Shannon entropy is at least 4.2 bits per character: `H = -Σ p·log2(p)` over the distinct characters of the
  token, where `p` is that character's count divided by the token's length (`Math.log2`);
- it does not overlap a span already kept.

A 40-character lowercase hex commit hash never qualifies (no uppercase letter). `/` and `.` are not token characters,
so paths split into short pieces.

Finally sort the kept spans by `start` and build the output text.

## Examples

- `scrub('token=Zm9vYmFyYmF6cXV4')` returns
  `{ text: 'token=[secret:assignment]', found: [{ kind: 'assignment', start: 6, end: 22 }] }`.
- `scrub('DB_PASSWORD=correcthorse9').text` is `'DB_PASSWORD=[secret:assignment]'`.
- Unchanged: `'PASSWORD_FILE=/etc/x'`, `'secret = true'`, `'token: string'`, `'{ password: hashedPassword }'`,
  `'token = getToken()'`, `'api_key=${API_KEY}'`, `'input_token: 123456'`.
- `scrub('password = "password"').text` is `'password = "[secret:assignment]"'` (the value, not the key word: that is
  why `lastIndexOf` is used).
- `scrub('postgres://admin:S3cr3tPass!@db.local:5432/app').text` is
  `'postgres://admin:[secret:url-password]@db.local:5432/app'`; `'redis://:hunter22@host'` becomes
  `'redis://:[secret:url-password]@host'`; `'https://abc:abc@x.io'` becomes `'https://abc:[secret:url-password]@x.io'`.
- `scrub('key AKIAIOSFODNN7EXAMPLE here').found` is `[{ kind: 'aws-access-key', start: 4, end: 24 }]`.
- `scrub('Authorization: Basic dXNlcjpwYXNz').text` is `'Authorization: Basic [secret:auth-header]'`.
- `scrub('commit 3f786850e387550fdab836ed7e6dc881de23001b')` finds nothing.
- `scrub('export ANTHROPIC_API_KEY=sk-ant-api03-AbCdEf0123456789_xyz').text` is
  `'export ANTHROPIC_API_KEY=[secret:anthropic-key]'` (rule 6 runs before rule 14).
- `scrub('')` returns `{ text: '', found: [] }`.

## Changes

- 24 Nov 2026, after the held-out test (`benchmark/scrub/heldout.mjs`) caught 93.5% of 400 planted secrets: rules
  11b, 13b and 13c, DigitalOcean and Shopify prefixes, and `/` inside high-entropy tokens (with the path exclusion).
  The two golden scenarios this changed (23 and 26) had recorded the tail of an integrity hash after its `/` as a
  secret, which the integrity-hash rule meant to exclude; they were re-recorded.
