// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// Secret scrubber: replaces secrets in imported text with markers before anything is stored (pilot plan W1).
// Spec: test/fixtures/scrub/SPEC.md. Reviewed by two adversarial reviews; built by hand after local-model builds failed.
// 27 Nov rules (after the first blind set, now the tuning set): passwords in French and German prose, command lines
// (sshpass, mysql -p, docker login -p, curl -u, echo | sudo -S, login() calls), recovery-code and password lists,
// password columns of tables, more config names (storePassword, appKey, Pwd=, PSK), session cookies, webhook URLs,
// more token formats; placeholders, masked values and public key material are never secrets.

export const KINDS = ['private-key', 'url-password', 'jwt', 'aws-access-key', 'github-token', 'anthropic-key',
  'openai-key', 'stripe-key', 'slack-token', 'google-api-key', 'prefixed-token', 'nostr-secret', 'auth-header',
  'assignment', 'high-entropy', 'webhook', 'recovery-code', 'password'];

export function marker(kind: unknown): string {
  if (typeof kind !== 'string' || !KINDS.includes(kind)) throw new TypeError('unknown kind');
  return '[secret:' + kind + ']';
}

const B = '(?<![A-Za-z0-9_-])';
const E = '(?![A-Za-z0-9_-])';
const PK = '-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY( BLOCK)?-----';
const PK_END = '-----END ([A-Z0-9]+ )*PRIVATE KEY( BLOCK)?-----';
const KEYS = 'password|passwd|passphrase|pwd|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key'
  + '|secret[_-]?access[_-]?key|client[_-]?secret|auth[_-]?token|(?:access|refresh|session|id)[_-]?token';
const TYPES = '(?:string|number|boolean|bigint|null|undefined|true|false|none|any|unknown|void)(?![A-Za-z0-9_])';
const VCH = '[^\\s\'"`,;()\\[\\]{}<>]';
const BARE = '(?![$%{<(\\[\\/~.!]|' + TYPES + ')(?=' + VCH + '*[A-Za-z])(?=' + VCH + '*[^A-Za-z.\\s\'"`,;()\\[\\]{}<>])'
  + '(' + VCH + '{6,4096})';
const AUTH = '\\bauthorization\\s*[:=]\\s*["\']?(?:bearer|basic|token|key)[ \\t=]+([A-Za-z0-9._~+\\/=:-]{8,})'
  + '|\\bbearer\\s+([A-Za-z0-9._~+\\/=-]{16,})';
// Words for a password or code in English, French and German prose.
const PW = "password|passwort|passwd|passphrase|pwd|pw|mot de passe|mdp|kennwort|passcode|code d['’]acc[eè]s|zugangscode"
  + '|netzwerkschl[uü]ssel|wlan-schl[uü]ssel|wifi-schl[uü]ssel|wpa-?key|cl[eé] (?:wifi|wi-fi|wpa|api|secr[eè]te)|psk|code pin|pin|puk|geheimzahl';
const PW_RE = new RegExp('(?<![A-Za-z0-9_.$:/@<{])(?:' + PW + '|secret key|recovery code|backup code|wiederherstellungscode|code de r[ée]cup[ée]ration'
  + '|cl[eé]|schl[uü]ssel|api key|api-key|requirepass)(?![A-Za-z0-9])', 'gi');
const FILE = /\.(?:pdf|txt|md|json|ya?ml|png|jpe?g|docx?|xlsx?|zip|gz|tar|pfx|p12|jks|pem|key|crt|csv|log|bak|conf|cfg|ini|env|sh|py|js|ts)$/i;
const LINK_RE =/[:=→]|\b(?:is|est|c['’]est|ist|lautet|use|nimm|utilise|sind|sont)\b/i;

const strong = (v: string) => /[0-9]/.test(v) && /[A-Za-z]/.test(v) || /[^A-Za-z0-9\s]/.test(v) && /[A-Za-z0-9]/.test(v) && v.length >= 6
  || (/^[0-9]{4,}$/.test(v));
const longMixed = (v: string) => v.length >= 16 && /[0-9]/.test(v) && /[A-Za-z]/.test(v);
// A password in prose: digits and letters, or an ASCII symbol other than - . _ (so "FTP-Server", "impots.gouv" and
// accented words are not passwords); never the name of a password manager.
const VAULTS = /^(?:1password|bitwarden|keepass(?:xc)?|lastpass|dashlane|vault|keychain|pass|enpass|proton ?pass)(?:[-\s].*)?$/i;
const proseSecret = (v: string) => !VAULTS.test(v) && !/^[A-Za-z]+(?:\.[A-Za-z]+)+$/.test(v) && !/^\w+=/.test(v)
  && (!/\s/.test(v) || /[0-9]/.test(v) && /[^\w\s]/.test(v))
  && (/[0-9]/.test(v) && /\p{L}/u.test(v) || /^[0-9]{6,}$/.test(v) || /[!#$%&*+=?@^~|\\/<>]/.test(v) && /\p{L}/u.test(v) && v.length >= 6);

/** Placeholders, masked values, code that reads a secret, and documentation examples: never secrets. */
function isPlaceholder(v: string): boolean {
  const s = v.replace(/^["'`«\s]+|["'`»\s,;:!?)]+$/g, '');
  return s.length === 0 || /^[A-Za-z_]+(?:\.[A-Za-z_]+)+$/.test(s)
    || /^(<[^>]*>|\$\{[^}]*\}|\$\(?[A-Za-z_][A-Za-z0-9_]*\)?|%[A-Za-z_]+%|\{\{[^}]*\}\}|\[[^\]]*\]|![a-z_]+)$/.test(s)
    || /^(?:p[r]ocess.env|os\.environ|os\.getenv|System\.getenv|getenv|secrets\.|vars\.|env\.|ENV\[|arn:aws)/.test(s) || /^[A-Za-z_][A-Za-z0-9_.]*\(/.test(s)
    || /\.\.\.|…|\*{3,}|x{6,}|X{6,}|•{3,}/.test(s)
    || /^(your|my|the)[_-]|^(YOUR|REPLACE|CHANGE|INSERT|ENTER)[_-]?|replace[_-]?me|change[_-]?me|placeholder|dummy|redacted|example|^(xxx+|value|changeit)$/i.test(s)
    || /^[A-Z_]{2,24}$/.test(s);
}

interface Rule { kind: string; re: RegExp; groups: number[]; ok?: (v: string, m: RegExpExecArray) => boolean }
const R = (kind: string, re: RegExp, groups: number[] = [], ok?: Rule['ok']): Rule => ok ? { kind, re, groups, ok } : { kind, re, groups };

const RULES: Rule[] = [
  R('private-key', new RegExp(PK + '(?:[\\s\\S]*?' + PK_END + '|(?:\\r?\\n[A-Za-z0-9+\\/=]+)*)', 'g')),
  R('private-key', new RegExp(B + 'AGE-SECRET-KEY-1[0-9A-Z]{40,}' + E, 'g')),
  // Webhook URLs are the credential themselves.
  R('webhook', /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9\/_-]{20,}/g),
  R('webhook', /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/g),
  R('webhook', /https:\/\/[a-z0-9-]+\.webhook\.office\.com\/[^\s"'<>]{20,}/g),
  R('url-password', /:\/\/([^\s:@\/?]*):([^\s@\/?]+)@/g, [2]),
  R('jwt', new RegExp(B + 'eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}' + E, 'g')),
  R('aws-access-key', new RegExp(B + '(AKIA|ASIA)[A-Z0-9]{16}' + E, 'g')),
  R('github-token', new RegExp(B + '(gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})' + E, 'g')),
  R('anthropic-key', new RegExp(B + 'sk-ant-[A-Za-z0-9_-]{20,}' + E, 'g')),
  R('openai-key', new RegExp(B + 'sk-(proj-|svcacct-|admin-)?(?=[A-Za-z_-]*[0-9])[A-Za-z0-9_-]{20,}' + E, 'g')),
  R('stripe-key', new RegExp(B + '(sk|rk)_(live|test)_[A-Za-z0-9]{16,}' + E, 'g')),
  R('slack-token', new RegExp(B + 'xox[abposred]-[A-Za-z0-9-]{10,}' + E, 'g')),
  R('google-api-key', new RegExp(B + 'AIza[A-Za-z0-9_-]{35}' + E, 'g')),
  R('prefixed-token', new RegExp(B + '(hf_|glpat-|gldt-|glptt-|glrt-|gloas-|glcbt-|dckr_pat_|npm_|gsk_|pypi-|dop_v1_|doo_v1_|dor_v1_|shp(?:at|ss|ca|pa)_'
    + '|xai-|pplx-|r8_|pcsk_|sq0atp-|sq0csp-|EAAA|SK[0-9a-f]{2}|lin_api_|ntn_|secret_|figd_|dapi.|AVNS_|rnd_|fly_|vercel_|nfp_|tfp_|atlasv1-)[A-Za-z0-9_-]{16,}' + E, 'g')),
  R('prefixed-token', /(?<![A-Za-z0-9_-])whsec_[A-Za-z0-9+\/=_-]{20,}/g),
  R('prefixed-token', new RegExp(B + 'sk_[A-Za-z0-9]{28,}' + E, 'g')), // RevenueCat and other sk_ keys
  R('prefixed-token', new RegExp(B + 'SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}' + E, 'g')),
  R('prefixed-token', new RegExp('(?:(?<=bot)|(?<![A-Za-z0-9_-]))\\d{8,10}:AA[A-Za-z0-9_-]{30,}' + E, 'g')), // Telegram bot token, also in /bot<token>/
  R('prefixed-token', new RegExp(B + 'AAAA[A-Za-z0-9_-]{7}:APA91b[A-Za-z0-9_-]{60,}' + E, 'g')), // FCM server key
  R('prefixed-token', new RegExp(B + '[MNO][A-Za-z0-9_-]{23,27}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{27,40}' + E, 'g')), // Discord bot token
  R('prefixed-token', new RegExp(B + '(?:key-)?[0-9a-f]{32}-[0-9a-f]{8}-[0-9a-f]{8}' + E, 'g')), // Mailgun
  R('nostr-secret', new RegExp(B + 'nsec1[02-9ac-hj-np-z]{58}' + E, 'g')),
  R('auth-header', new RegExp(AUTH, 'gi'), [1, 2]),
  // Command lines.
  R('password', new RegExp('\\b(?:sshpass|docker[ \\t]+login|podman[ \\t]+login|helm[ \\t]+registry[ \\t]+login|az[ \\t]+login|redis-cli|keytool|notarytool)\\b'
    + '[^\\n|;&]*?[ \\t](?:-p|-a|-storepass|-keypass|--password|--pass)(?:=|[ \\t]+)([\'"]?)([^\\s\'"]{3,})\\1', 'g'), [2]),
  R('password', /\b(?:mysql\w*|mariadb\w*)\b[^\n|;&]*?[ \t]-p(['"]?)([^\s'"]{3,})\1/g, [2]), // mysql -pX: attached, else it prompts
  R('password', /\brabbitmqctl[ \t]+(?:add_user|change_password)[ \t]+\S+[ \t]+(['"]?)([^\s'"]{3,})\1/g, [2]),
  R('password', /^[ \t]*(?:requirepass|masterauth)[ \t]+(['"]?)([^\s'"]{3,})\1/gm, [2]),
  R('password', /^[^\s:#]+:(\d+|\*):[^\s:]+:[^\s:]+:(\S{4,})$/gm, [2]), // .pgpass
  R('password', /\b(?:login|logins|user|username|benutzer|identifiant|account|root|admin|zugang)\b[^\n/]{0,40}?\S[ \t]+\/[ \t]+([^\s,;]{6,})/gi, [1], v => proseSecret(v.replace(/[.]$/, ''))),
  R('password', /[?&](?:X-Amz-Signature|X-Goog-Signature|sig|signature|access_token|api_key|apikey)=([^&\s"'#]{16,})/g, [1]),
  R('password', /"auth"\s*:\s*"([A-Za-z0-9+\/=]{12,})"/g, [1]), // docker config.json
  R('password', /name:[ \t]*['"]?[A-Za-z0-9_]*(?:SECRET|PASSWORD|TOKEN|KEY|PASS)[A-Za-z0-9_]*['"]?[ \t]*\r?\n[ \t]*value:[ \t]*['"]?([^'"\s]{6,})/gi, [1]),
  R('webhook', /https?:\/\/[^\s\/]+\/api\/webhook\/[A-Za-z0-9_-]{16,}/g), // Home Assistant
  R('password', /(?<![\w-])(?:-u|--user)[ \t]+['"]?[^\s:'"]+:([^\s'"@]{3,})/g, [1]),
  R('password', /\becho[ \t]+(['"]?)([^\s'"|]{3,})\1[ \t]*\|[ \t]*sudo\b[^\n]*-S/g, [2]),
  R('password', /\.(?:login|connect|auth(?:enticate)?)\(\s*["'][^"'\n]*["']\s*,\s*["']([^"'\n]{3,})["']/g, [1]),
  R('password', /\bPSK[ \t]+"([^"\n]{6,})"/g, [1]),
  R('password', /\boption[ \t]+(?:key|password)[ \t]+'([^'\n]{4,})'/g, [1]),
  R('assignment', new RegExp('(?<![A-Za-z0-9-])--?(?:' + KEYS + '|key|pass|auth)(?![A-Za-z0-9])(?:=|[ \\t]+)(?:"([^"\\n]{4,})"|\'([^\'\\n]{4,})\'|' + BARE + ')', 'gi'), [1, 2, 3]),
  // "the key you asked for: VALUE", "token: VALUE" in prose: a value that mixes letters and digits, on the same line.
  R('assignment', new RegExp('(?<![A-Za-z0-9])(?:key|token|password|passphrase|secret|credential|pat|cl[eé]|schl[uü]ssel)s?(?![A-Za-z0-9])[^\\n:.]{0,40}:[ \\t]+'
    + '(?![`]|[A-Za-z]:[\\\\/]|\\.{0,2}\\/)(?=[^\\s]*[0-9])(?=[^\\s]*[A-Za-z])([^\\s\'",;()\\[\\]{}]{12,4096})', 'gi'), [1]),
  R('assignment', new RegExp('(?<![A-Za-z0-9])(?:' + KEYS + ')(?![A-Za-z0-9])["\']?[ \\t]*[:=][ \\t]*'
    + '(?:"([^"\\n]{4,4096})"|\'([^\'\\n]{4,4096})\'|' + BARE + ')', 'gi'), [1, 2, 3]),
  // Config names that end in a secret word: storePassword=, appKey:, .erlang.cookie =, DB_PASS=, x-api-key: ...
  R('assignment', new RegExp('(?<![A-Za-z0-9])(?:[A-Za-z_.][A-Za-z0-9_.-]{0,40}?)?(password|passwd|pwd|pass|passphrase|secret|token|key|psk|cookie)["\']?[ \\t]*[:=][ \\t]*'
    + '(?:"([^"\\n]{4,4096})"|\'([^\'\\n]{4,4096})\'|(' + VCH + '{6,4096}))', 'gi'), [2, 3, 4],
    (v, m) => !/^[$%{<(\[\/~.!]/.test(v)
      && (/key$/i.test(m[1] ?? '') ? longMixed(v) && !/^0x[0-9a-f]+$/i.test(v) : strong(v) && !/^\d+$/.test(v))),
  // Session cookies and similar name=value pairs: _gitlab_session=..., sessionid=..., R_SESS=...
  R('assignment', /(?<![A-Za-z0-9])(?:[A-Za-z_][\w-]*?)?(?:sess(?:ion)?(?:id|_id)?|sid|jwt|auth|token)=([A-Za-z0-9%._~+\/:=-]{12,})/gi,
    [1], v => longMixed(v) || v.length >= 24),
];

// Public material, protected from every rule but the strong formats: fingerprints, public keys, key ids, DKIM records,
// JWK fields, publishable keys and object ids.
const PUBLIC: RegExp[] = [
  /\b(?:public[ _-]?key|clé publique|öffentlicher schlüssel|node[ _-]?key|disco[ _-]?key)\b["']?[ \t]*(?:[:=]|is|ist|est)?[ \t]*\S+/gi,
  /\b(?:fingerprint|empreinte|fingerabdruck)\b[^\n]{0,6}?[:=]?[ \t]*(?:[0-9A-F]{4}[ \t]+){4,}[0-9A-F]{4}/gi,
  /\b(?:AC|SM|MM|PN|MG|CA|RE|IS|SK)[0-9a-f]{32}\b/g,
  /\b(?:idempotency[ _-]?key|(?:extended[ _-]?)?request[ _-]?id|trace[ _-]?id|correlation[ _-]?id|paypal-request-id|distribution|deployment)\b[^\n]{0,4}?[:=]?[ \t]*\S+/gi,
  /\b(?:SHA256|SHA1|MD5):[A-Za-z0-9+\/=]{16,}/g,
  /-----BEGIN (?:[A-Z0-9]+ )*(?:PUBLIC KEY|CERTIFICATE|PGP PUBLIC KEY BLOCK)-----[\s\S]*?-----END (?:[A-Z0-9]+ )*(?:PUBLIC KEY|CERTIFICATE|PGP PUBLIC KEY BLOCK)-----/g,
  /\b(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-[a-z0-9]+|sk-ssh-ed25519@openssh\.com)[ \t]+AAAA[A-Za-z0-9+\/=]+/g,
  /\bv=DKIM1[^"\n]*/g,
  /"(?:n|e|x|y|kid|x5t|crv)"\s*:\s*"[^"]*"/g,
  new RegExp('\\b(?:key[ _-]?id|kid|fingerprint|empreinte|fingerabdruck|identifiant de cl[eé]|schl[uü]ssel-?id)\\b[^\\n]{0,40}?[:=]?[ \\t]*'
    + '(?:0x)?(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9A-F]{8,40})\\b', 'gi'),
  /(?<![A-Za-z0-9_-])pk_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /(?<![A-Za-z0-9_-])(?:chatcmpl|dpl|req|msg|evt|cus|pi|ch|txn|resp|run|cmpl|file|asst|thread|batch)[_-][A-Za-z0-9]{10,}/g,
];
const STRONG_KINDS = new Set(['private-key', 'aws-access-key', 'github-token', 'anthropic-key', 'openai-key', 'stripe-key', 'slack-token', 'google-api-key', 'nostr-secret']);

// A heading that announces recovery codes, or a list of passwords; the codes or values follow on its lines.
const CODES_HEAD = new RegExp('(?:recovery|backup|wiederherstellungs?|notfall|einmal|2fa|mfa|r[ée]cup[ée]ration|secours|sauvegarde)[ -]?(?:codes?|kódy)'
  + "|codes? (?:de|d['’]) ?(?:secours|r[ée]cup[ée]ration|sauvegarde)|recovery-codes|backup-codes", 'gi');
const CODE = /(?<![A-Za-z0-9-])(?:[A-Za-z0-9]{4,6}(?:-[A-Za-z0-9]{4,6}){1,3}|\d{4}[ -]\d{4}|\d{6,10}|[A-Z0-9]{4}-[A-Z0-9]{4})(?![A-Za-z0-9-])/g;
const COLUMN = /^\s*(?:password|passwort|kennwort|mot de passe|mdp|pw|pwd|pass|passphrase|secret|token|auth token|api key|key|pin|code|psk)\s*$/i;
const LIST_HEAD =/^.*\b(?:passwords|passw[oö]rter|mots de passe|zugangsdaten|logins|credentials|identifiants|acc[eè]s)\b.*$/gim;

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
  const shielded: [number, number][] = [];
  for (const re of PUBLIC) { re.lastIndex = 0; for (let m = re.exec(text); m; m = re.exec(text)) shielded.push([m.index, m.index + m[0].length]); }
  const inPublic = (s: number, e: number) => shielded.some(([a, b]) => s >= a && e <= b);
  const free = (s: number, e: number) => spans.every(x => e <= x.start || s >= x.end);
  const add = (kind: string, start: number, value: string) => {
    if (!value || !free(start, start + value.length)) return;
    if (STRONG_KINDS.has(kind) ? /EXAMPLE|\.\.\.|x{6,}|X{6,}|\*{3,}/.test(value) : kind !== 'private-key' && kind !== 'webhook' && isPlaceholder(value)) return;
    if (kind === 'webhook' && /XXXX|your-|<|\$\{/i.test(value)) return;
    if (kind === 'url-password' && /^(?:pass|password|passwd|pwd|secret|changeme|pw)$/i.test(value)) return;
    if (kind === 'password' && value.startsWith('-')) return; // a flag (--password-stdin), not a value
    if (!STRONG_KINDS.has(kind) && kind !== 'webhook' && inPublic(start, start + value.length)) return;
    spans.push({ kind, start, end: start + value.length });
  };
  for (const { kind, re, groups, ok } of RULES) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      let value = m[0], start = m.index;
      if (groups.length > 0) {
        const g = groups.find(i => m![i] !== undefined);
        if (g === undefined) continue;
        value = m[g] as string;
        start = m.index + m[0].lastIndexOf(value);
      }
      if (kind === 'password') { const t = /[.,;:?]+$/.exec(value); if (t && t[0] !== value) value = value.slice(0, -t[0].length); }
      if (ok && !ok(value, m)) continue;
      add(kind, start, value);
    }
  }
  // Prose: after a password word, the rest of its line (up to 120 characters); from the first link word ("is", "c'est",
  // "lautet", ":" ...) if there is one, the first of the next four tokens that looks like a password. A Google app
  // password (four groups of four letters) counts whole.
  PW_RE.lastIndex = 0;
  for (let m = PW_RE.exec(text); m; m = PW_RE.exec(text)) {
    const end = m.index + m[0].length, nl = text.indexOf('\n', end);
    const window = text.slice(end, Math.min(nl < 0 ? text.length : nl, end + 120));
    if (/^["']?[=:]/.test(window) && !/^:[ \t]/.test(window)) continue; // code-style key=value: the rules above
    if (/^[^"'«]*?[:=]?[ \t]*["'](?![^"'\n]*["'])/.test(window.slice(0, 60)) && /^[\s:=]*["']/.test(window)) continue; // unclosed quote
    const link = LINK_RE.exec(window);
    let at = link && link.index < 70 ? link.index + link[0].length : 0;
    const app = /^[\s:]*([a-z]{4} [a-z]{4} [a-z]{4} [a-z]{4})(?![a-z])/.exec(window.slice(at));
    if (app && /pass|pw|mdp/i.test(m[0])) { add('password', end + at + app[0].lastIndexOf(app[1] as string), app[1] as string); continue; }
    const pin = /^(?:pin|puk|code pin|geheimzahl)$/i.test(m[0]);
    const tokRe = /«[ \t]*([^»\n]{4,128}?)[ \t]*»|"([^"\n]{4,128})"|'([^'\n]{4,128})'|`([^`\n]{4,128})`|([^\s"'`«»,;()<>[\]]+)/g;
    tokRe.lastIndex = at;
    for (let k = 0, t = tokRe.exec(window); t && k < 4; t = tokRe.exec(window), k++) {
      let v = (t[1] ?? t[2] ?? t[3] ?? t[4] ?? t[5]) as string;
      const quoted = t[5] === undefined;
      if (!quoted) v = v.replace(/[.,:;?]+$/, '');
      if (v.length < 4) continue;
      if (pin ? /^[0-9]{4,10}$/.test(v) : proseSecret(v) && !/^(https?:|\/|[A-Za-z]:|\.\/|~\/)/.test(v) && !FILE.test(v)) {
        add('password', end + t.index + t[0].indexOf(v), v);
        break;
      }
    }
  }
  // Recovery codes: the code-shaped tokens after the heading, up to a blank line (at most 12 lines).
  CODES_HEAD.lastIndex = 0;
  for (let h = CODES_HEAD.exec(text); h; h = CODES_HEAD.exec(text)) {
    const from = h.index + h[0].length;
    let to = text.indexOf('\n\n', from); if (to < 0) to = text.length;
    let lines = 0, at = from;
    while (lines < 12) { const nl = text.indexOf('\n', at); if (nl < 0 || nl >= to) { at = to; break; } at = nl + 1; lines++; }
    const region = text.slice(from, Math.min(to, lines >= 12 ? at : to));
    CODE.lastIndex = 0;
    const found: [number, string][] = [];
    for (let c = CODE.exec(region); c; c = CODE.exec(region)) if (/[0-9]/.test(c[0]) && !/^(19|20)\d\d-\d\d(-\d\d)?$/.test(c[0])) found.push([from + c.index, c[0]]);
    const shape = (t: string) => t.replace(/[a-z]/g, 'a').replace(/[A-Z]/g, 'A').replace(/[0-9]/g, '9').replace(/[aA9]/g, 'x');
    const counts = new Map<string, number>();
    for (const [, t] of found) counts.set(shape(t), (counts.get(shape(t)) ?? 0) + 1);
    for (const [at2, t] of found) if ((counts.get(shape(t)) ?? 0) >= 2) add('recovery-code', at2, t);
  }
  // A list of passwords: "Service : value" lines under a heading that says so, up to a blank line.
  LIST_HEAD.lastIndex = 0;
  for (let h = LIST_HEAD.exec(text); h; h = LIST_HEAD.exec(text)) {
    let at = h.index + h[0].length + 1;
    for (let k = 0; k < 20 && at < text.length; k++) {
      const nl = text.indexOf('\n', at), line = text.slice(at, nl < 0 ? text.length : nl);
      if (!line.trim()) break;
      const m = /^[^:\n]{1,60}?[ \t]*[:=–-][ \t]+(?:mdp |pw |pwd |password |passwort )?(["'`«]?)([^\s"'`«»,;]{4,128})\1[ \t]*$/i.exec(line);
      if (m && strong(m[2] as string)) add('password', at + line.lastIndexOf(m[2] as string), m[2] as string);
      if (nl < 0) break;
      at = nl + 1;
    }
  }
  // Tables: every cell under a password, secret, token, PIN or key column.
  const lines = text.split('\n');
  let pos = 0, cols: number[] = [];
  for (const line of lines) {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.split('|').slice(1, -1);
      const isSep = cells.every(c => /^\s*:?-{2,}:?\s*$/.test(c));
      const named = cells.map((c, i) => COLUMN.test(c) ? i : -1).filter(i => i >= 0);
      if (named.length && !cols.length) cols = named;
      else if (!isSep && cols.length) {
        let off = pos + line.indexOf('|') + 1;
        cells.forEach((c, i) => {
          const v = c.trim();
          if (cols.includes(i) && v && !/^\(.*\)$/.test(v) && v.length >= 4) add('password', off + c.indexOf(v), v);
          off += c.length + 1;
        });
      }
    } else cols = [];
    pos += line.length + 1;
  }
  const tok = /[A-Za-z0-9+\/_-]+=*/g;
  for (let m = tok.exec(text); m !== null; m = tok.exec(text)) {
    const t = m[0];
    if (t.length >= 32 && /[0-9]/.test(t) && /[a-z]/.test(t) && /[A-Z]/.test(t) && /[A-Za-z0-9]{20}/.test(t)
        && !/^(sha(1|256|384|512)-|AAAA)/.test(t) && !/\/[a-z]+\/|^\/|\/$/.test(t) && entropy(t) >= 4.2)
      add('high-entropy', m.index, t);
  }
  spans.sort((a, b) => a.start - b.start);
  let out = '', at = 0;
  for (const s of spans) { out += text.slice(at, s.start) + marker(s.kind); at = s.end; }
  return { text: out + text.slice(at), found: spans };
}
