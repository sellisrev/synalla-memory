// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial
//
// Held-out test of the secret scrubber (pilot plan W1, M1 exit: at least 95% of planted secrets caught, false
// positives published). Written after the scrubber was frozen, from secret formats seen in real work (not from its
// rules), with a fixed seed so anyone can rerun it:   node --import ../../tools/ts-resolve.mjs heldout.mjs
// A planted secret counts as caught when its value no longer appears in the scrubbed text. A harmless sample counts as
// a false positive when the scrubber changes it at all.
import { createHash } from 'node:crypto';
import { scrub } from '../../src/scrub.ts';

export const SEED = 'synalla-scrub-heldout-2026-11-24';
let counter = 0;
const rnd = () => { const h = createHash('sha256').update(SEED + ':' + counter++).digest(); return h.readUInt32BE(0) / 2 ** 32; };
const pick = a => a[Math.floor(rnd() * a.length)];
const chars = (set, n) => Array.from({ length: n }, () => set[Math.floor(rnd() * set.length)]).join('');
const AZ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', az = 'abcdefghijklmnopqrstuvwxyz', D = '0123456789', HEX = '0123456789abcdef';
const AN = AZ + az + D, B64 = AN + '+/', URLSAFE = AN + '-_';

// Secret generators: [name, typical variable name, value]
const SECRETS = [
  ['aws-access-key', 'AWS_ACCESS_KEY_ID', () => 'AKIA' + chars(AZ + D, 16)],
  ['aws-secret', 'AWS_SECRET_ACCESS_KEY', () => chars(B64, 40)],
  ['github-pat-classic', 'GITHUB_TOKEN', () => 'ghp_' + chars(AN, 36)],
  ['github-pat-fine', 'GH_TOKEN', () => 'github_pat_' + chars(AN, 22) + '_' + chars(AN, 59)],
  ['github-oauth', 'GITHUB_OAUTH', () => 'gho_' + chars(AN, 36)],
  ['anthropic', 'ANTHROPIC_API_KEY', () => 'sk-ant-api03-' + chars(URLSAFE, 93) + 'AA'],
  ['openai-project', 'OPENAI_API_KEY', () => 'sk-proj-' + chars(URLSAFE, 74) + 'T3BlbkFJ' + chars(URLSAFE, 74)],
  ['openai-legacy', 'OPENAI_KEY', () => 'sk-' + chars(AN, 20) + 'T3BlbkFJ' + chars(AN, 20)],
  ['stripe-live', 'STRIPE_SECRET_KEY', () => 'sk_live_' + chars(AN, 24)],
  ['stripe-restricted', 'STRIPE_KEY', () => 'rk_live_' + chars(AN, 24)],
  ['slack-bot', 'SLACK_BOT_TOKEN', () => 'xoxb-' + chars(D, 12) + '-' + chars(D, 13) + '-' + chars(AN, 24)],
  ['google-api', 'GOOGLE_API_KEY', () => 'AIza' + chars(URLSAFE, 35)],
  ['huggingface', 'HF_TOKEN', () => 'hf_' + chars(AN, 34)],
  ['gitlab', 'GITLAB_TOKEN', () => 'glpat-' + chars(URLSAFE, 20)],
  ['npm', 'NPM_TOKEN', () => 'npm_' + chars(AN, 36)],
  ['sendgrid', 'SENDGRID_API_KEY', () => 'SG.' + chars(URLSAFE, 22) + '.' + chars(URLSAFE, 43)],
  ['twilio', 'TWILIO_AUTH_TOKEN', () => chars(HEX, 32)],
  ['discord-bot', 'DISCORD_TOKEN', () => 'M' + chars(AN, 23) + '.' + chars(URLSAFE, 6) + '.' + chars(URLSAFE, 38)],
  ['digitalocean', 'DIGITALOCEAN_TOKEN', () => 'dop_v1_' + chars(HEX, 64)],
  ['shopify', 'SHOPIFY_ACCESS_TOKEN', () => 'shpat_' + chars(HEX, 32)],
  ['jwt', 'ID_TOKEN', () => 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ' + chars(URLSAFE, 60) + '.' + chars(URLSAFE, 43)],
  ['nostr-nsec', 'NOSTR_SECRET', () => 'nsec1' + chars('023456789acdefghjklmnpqrstuvwxyz', 58)],
  ['password', 'DB_PASSWORD', () => pick(['Tr0ub4dor&3', 'correct-Horse-9-battery', 'Summer2026!x', 'p@ssW0rd-Lyon77', 'Kx9#mq2!vR'])],
  ['generic-hex-secret', 'SESSION_SECRET', () => chars(HEX, 64)],
  ['generic-b64-secret', 'JWT_SECRET', () => chars(B64, 44)],
];

// Contexts: how the secret appears in a session or a note. [name, (varName, value) => text]
const CONTEXTS = [
  ['env-line', (k, v) => `${k}=${v}`],
  ['export', (k, v) => `export ${k}="${v}"`],
  ['json', (k, v) => `{"name": "svc", "${k.toLowerCase()}": "${v}", "region": "eu-west-1"}`],
  ['yaml', (k, v) => `service:\n  ${k.toLowerCase()}: ${v}\n  retries: 3`],
  ['cli-flag', (k, v) => `deploy --project shop --token ${v} --region eu`],
  ['curl-header', (k, v) => `curl -H "Authorization: Bearer ${v}" https://api.example.com/v1/items`],
  ['sentence', (k, v) => `Here is the key you asked for: ${v} (please rotate it after the demo).`],
  ['code-string', (k, v) => `const client = new Client({ apiKey: '${v}', timeout: 5000 });`],
];

// Harmless strings that look like secrets. [name, () => text]
const HARMLESS = [
  ['git-sha', () => `commit ${chars(HEX, 40)}\nAuthor: Dev <dev@example.com>`],
  ['git-short-sha', () => `Fixed in ${chars(HEX, 7)}, see the PR.`],
  ['uuid', () => `request_id=${chars(HEX, 8)}-${chars(HEX, 4)}-4${chars(HEX, 3)}-a${chars(HEX, 3)}-${chars(HEX, 12)}`],
  ['sha256-digest', () => `sha256sum: ${chars(HEX, 64)}  llama.zip`],
  ['docker-digest', () => `image: ghcr.io/org/app@sha256:${chars(HEX, 64)}`],
  ['npm-integrity', () => `"integrity": "sha512-${chars(B64, 86)}=="`],
  ['css-color', () => `color: #${chars(HEX, 6)}; background: #${chars(HEX, 3)};`],
  ['file-path', () => `Edited src/components/${chars(az, 8)}/${chars(az, 6)}Panel.tsx and tests/${chars(az, 5)}.test.ts`],
  ['url', () => `See https://github.com/${chars(az, 7)}/${chars(az, 9)}/pull/${chars(D, 4)}#discussion_r${chars(D, 9)}`],
  ['semver', () => `Bumped ${chars(az, 6)} from ${chars(D, 1)}.${chars(D, 2)}.${chars(D, 1)} to ${chars(D, 1)}.${chars(D, 2)}.${chars(D, 2)}`],
  ['timestamp', () => `2026-11-${chars('12', 1)}${chars(D, 1)}T${chars('01', 1)}${chars(D, 1)}:${chars('012345', 1)}${chars(D, 1)}:00.000Z`],
  ['base64-image-name', () => `Saved screenshot ${chars(AN, 12)}.png (${chars(D, 3)} KB)`],
  ['token-word', () => `The tokenizer counts ${chars(D, 4)} tokens; the token budget is fine.`],
  ['password-prose', () => `Reset your password from the settings page; the password field must be 12+ characters.`],
  ['secret-prose', () => `The secret to good tests is making them fail first.`],
  ['type-annotation', () => `function login(password: string, token?: string): Promise<Session>`],
  ['env-placeholder', () => `API_KEY=\${API_KEY}\nTOKEN=<your token here>\nPASSWORD=changeme`],
  ['hash-in-lockfile', () => `resolved "https://registry.npmjs.org/${chars(az, 6)}/-/${chars(az, 6)}-1.2.3.tgz#${chars(HEX, 40)}"`],
  ['ipv4', () => `server at ${chars('12', 1)}${chars(D, 2)}.${chars(D, 2)}.${chars(D, 1)}.${chars(D, 2)}:8080`],
  ['commit-message', () => `feat(${chars(az, 5)}): add ${chars(az, 6)} handling for ${chars(az, 8)} (#${chars(D, 3)})`],
];

export function generate() {
  counter = 0;
  const planted = [];
  for (const [name, varName, gen] of SECRETS) {
    for (const [ctx, wrap] of CONTEXTS) {
      for (let i = 0; i < 2; i++) { const v = gen(); planted.push({ kind: name, ctx, value: v, text: `Notes ${i}:\n${wrap(varName, v)}\nThat should work now.` }); }
    }
  }
  const harmless = [];
  for (const [name, gen] of HARMLESS) for (let i = 0; i < 20; i++) harmless.push({ kind: name, text: gen() });
  return { planted, harmless };
}

export function evaluate() {
  const { planted, harmless } = generate();
  const caught = planted.filter(p => !scrub(p.text).text.includes(p.value));
  const fp = harmless.filter(h => scrub(h.text).text !== h.text);
  const byKind = {}, byCtx = {}, fpByKind = {};
  for (const p of planted) {
    const ok = !scrub(p.text).text.includes(p.value);
    (byKind[p.kind] ??= [0, 0])[ok ? 0 : 1]++;
    (byCtx[p.ctx] ??= [0, 0])[ok ? 0 : 1]++;
  }
  for (const h of fp) fpByKind[h.kind] = (fpByKind[h.kind] ?? 0) + 1;
  return { planted: planted.length, caught: caught.length, harmless: harmless.length, falsePositives: fp.length, byKind, byCtx, fpByKind,
    missedExamples: planted.filter(p => scrub(p.text).text.includes(p.value)).slice(0, 12).map(p => `${p.kind}/${p.ctx}`) };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/').replace(/^([A-Z]):/, '/$1:')}` || process.argv[1]?.endsWith('heldout.mjs')) {
  const r = evaluate();
  console.log(`caught ${r.caught}/${r.planted} = ${(100 * r.caught / r.planted).toFixed(1)}%; false positives ${r.falsePositives}/${r.harmless} = ${(100 * r.falsePositives / r.harmless).toFixed(1)}%`);
  console.log('missed by kind:', Object.entries(r.byKind).filter(([, v]) => v[1]).map(([k, v]) => `${k} ${v[1]}/${v[0] + v[1]}`).join(', ') || 'none');
  console.log('missed by context:', Object.entries(r.byCtx).filter(([, v]) => v[1]).map(([k, v]) => `${k} ${v[1]}/${v[0] + v[1]}`).join(', ') || 'none');
  console.log('false positives by kind:', Object.entries(r.fpByKind).map(([k, v]) => `${k} ${v}`).join(', ') || 'none');
}
