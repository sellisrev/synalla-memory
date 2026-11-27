// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// Typed stand-ins (the owner's design, 27 Nov 2026). A hidden value becomes a stand-in that says what it is and stays
// the same wherever the value occurs: "pay ⟦IBAN 2⟧", "the Wi-Fi key is ⟦password 1⟧". An agent in the cloud reasons
// with the stand-ins; the real values are put back only on this machine (store.reveal, the local reveal page).
// What gets one: secrets (scrub.ts, and the check model's second pass) and money and ID numbers (pii.ts). Values are
// kept in the encrypted store, except keys that are certainly keys (a provider's key format, a private key block):
// those are dropped as before, and their stand-in reveals as "not kept".

import { scrub } from './scrub.ts';
import { findPii } from './pii.ts';

/** What the stand-in calls each kind of hidden value. */
export const LABELS: Readonly<Record<string, string>> = Object.freeze({
  'private-key': 'private key', 'url-password': 'password', jwt: 'access token', 'aws-access-key': 'AWS key',
  'github-token': 'GitHub token', 'anthropic-key': 'Anthropic API key', 'openai-key': 'OpenAI API key', 'stripe-key': 'Stripe key',
  'slack-token': 'Slack token', 'google-api-key': 'Google API key', 'prefixed-token': 'access token', 'nostr-secret': 'Nostr key',
  'auth-header': 'access token', assignment: 'secret', 'high-entropy': 'secret', webhook: 'webhook URL', 'recovery-code': 'recovery code',
  password: 'password', model: 'secret', iban: 'IBAN', 'card-number': 'card number', 'social-security-number': 'social security number',
  'tax-id': 'tax ID', 'passport-number': 'passport number',
});

// For a value the rules or the model found by its look alone ("assignment", "high-entropy", "model"), the stand-in
// names what the words just before it call it, so the agent still knows what kind of thing it is.
const GENERIC = new Set(['assignment', 'high-entropy', 'model']);
const NAMED: [RegExp, string][] = [
  [/wi-?fi|wlan|wpa|psk/i, 'Wi-Fi password'], [/\bpin\b/i, 'PIN'], [/recovery|backup code|wiederherstellung|r[ée]cup[ée]ration|secours/i, 'recovery code'],
  [/(?:door|gate|alarm|safe|lock|entry|building)[ -]?code|digicode|t[üu]rcode/i, 'door code'], [/client[ _-]?secret/i, 'client secret'], [/api[ _-]?key|apikey/i, 'API key'], [/(?:access|auth|bearer|session|refresh|bot)?[ _-]?token/i, 'access token'],
  [/passphrase|password|passwort|kennwort|mot de passe|mdp|\bpw\b|\bpwd\b|passcode/i, 'password'],
  [/private[ _-]?key|signing key|secret[ _-]?key/i, 'secret key'], [/cookie|session/i, 'session cookie'], [/seed|totp|2fa|otp/i, 'one-time code seed'],
];
function labelFor(kind: string, text: string, start: number): string {
  if (!GENERIC.has(kind)) return LABELS[kind] ?? 'secret';
  const before = (text.slice(Math.max(0, start - 60), start).split('\n').pop() ?? '');
  let best: [number, string] | null = null;
  for (const [re, label] of NAMED) {
    const all = [...before.matchAll(new RegExp(re.source, 'gi'))], last = all[all.length - 1];
    if (last && (!best || last.index > best[0])) best = [last.index, label];
  }
  return best ? best[1] : 'secret';
}

/** Kinds whose value is never kept: a key in its provider's format, or a private key block. */
export const DROPPED: ReadonlySet<string> = new Set(['private-key', 'aws-access-key', 'github-token', 'anthropic-key', 'openai-key',
  'stripe-key', 'slack-token', 'google-api-key', 'nostr-secret']);

/** A stand-in as it appears in stored text: ⟦label n⟧. */
export const STAND_IN = /⟦([^⟦⟧\n]{1,40}?) (\d{1,6})⟧/g;
export const standIn = (label: string, n: number) => `⟦${label} ${n}⟧`;

/** Where stand-ins come from and go back to: the store's encrypted table. */
export interface Vault {
  /** The stand-in for this value (the same each time); a new one only when `allocate`, else null if unknown. */
  standInFor(value: string, label: string, keep: boolean, allocate: boolean): string | null;
  /** The kept value of a stand-in; null when it was dropped; undefined when there is no such stand-in. */
  valueOf(standIn: string): string | null | undefined;
}

interface Span { kind: string; start: number; end: number }

/** The values to hide in `text`: the scrubber's secrets, money and ID numbers, and every occurrence of `extra`. */
export function hiddenSpans(text: string, extra: readonly string[] = []): Span[] {
  const all: Span[] = [...scrub(text).found, ...findPii(text)];
  for (const v of extra) {
    if (v.length < 4) continue;
    for (let at = text.indexOf(v); at >= 0; at = text.indexOf(v, at + v.length)) all.push({ kind: 'model', start: at, end: at + v.length });
  }
  all.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Span[] = [];
  for (const s of all) {
    const inStandIn = [...text.matchAll(STAND_IN)].some(m => s.start < m.index + m[0].length && s.end > m.index);
    if (!inStandIn && !out.some(o => s.start < o.end && s.end > o.start)) out.push(s);
  }
  return out;
}

/**
 * `text` with each hidden value replaced by its stand-in. With `allocate` false nothing new is made, and the result is
 * null if a value has no stand-in yet (used to tell whether a re-import is unchanged).
 */
export function pseudonymize(text: string, vault: Vault, extra: readonly string[] = [], allocate = true): string | null {
  let out = '', at = 0;
  for (const s of hiddenSpans(text, extra)) {
    const label = labelFor(s.kind, text, s.start);
    const t = vault.standInFor(text.slice(s.start, s.end), label, !DROPPED.has(s.kind), allocate);
    if (t === null) return null;
    out += text.slice(at, s.start) + t;
    at = s.end;
  }
  return out + text.slice(at);
}

/** `text` with stand-ins replaced by their kept values (only ever shown on this machine). */
export function reveal(text: string, vault: Pick<Vault, 'valueOf'>): string {
  return text.replace(STAND_IN, m => {
    const v = vault.valueOf(m);
    return v === undefined ? m : v === null ? `${m} (not kept: keys in a provider's format are never stored)` : v;
  });
}
