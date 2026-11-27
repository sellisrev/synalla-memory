// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// Money and ID numbers in imported text (the owner's choice of what gets a stand-in, 27 Nov 2026): IBANs, payment
// card numbers, social security numbers, tax IDs and passport numbers. Names, phone numbers, e-mail and street
// addresses stay readable. Each rule is precise first: a checksum where the number has one (IBAN mod 97, card Luhn,
// French NIR key, Austrian SV check digit), otherwise a naming word close before it.

export type PiiKind = 'iban' | 'card-number' | 'social-security-number' | 'tax-id' | 'passport-number';
export interface PiiSpan { kind: PiiKind; start: number; end: number }

function ibanOk(s: string): boolean {
  if (s.length < 15 || s.length > 34) return false;
  const r = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
  let m = 0;
  for (const d of r) m = (m * 10 + Number(d)) % 97;
  return m === 1;
}
function luhn(d: string): boolean {
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let x = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) { x *= 2; if (x > 9) x -= 9; }
    sum += x;
  }
  return sum % 10 === 0;
}
// Payment providers' published test cards (Stripe, Adyen, Braintree docs): documentation, not anyone's money.
const TEST_CARDS = new Set(['4242424242424242', '4111111111111111', '5555555555554444', '2223003122003222', '5200828282828210',
  '5105105105105100', '378282246310005', '371449635398431', '6011111111111117', '3056930009020004', '36227206271667', '4012888888881881']);
const isTestCard = (d: string) => TEST_CARDS.has(d) || /^4000000000\d{6}$/.test(d) || /^4000(?:0025|0566|0027|0035)\d{8}$/.test(d);
const CARD_IIN = /^(?:4|5[1-5]|2(?:2[2-9]|[3-6]|7[01]|720)|3[47]|6(?:011|5|4[4-9])|3(?:0[0-5]|[68]))/;
function nirOk(s: string): boolean { // French social security number: 13 digits (Corsica 2A/2B) + 2-digit key
  const body = s.slice(0, 13).replace('2A', '19').replace('2B', '18'), key = Number(s.slice(13));
  return /^\d{13}$/.test(body) && 97 - Number(BigInt(body) % 97n) === key;
}
function svnrOk(s: string): boolean { // Austrian SV-Nummer: 4th digit checks the other nine
  const w = [3, 7, 9, 0, 5, 8, 4, 2, 1, 6];
  const sum = w.reduce((a, x, i) => a + x * Number(s[i]), 0) % 11;
  return sum !== 10 && sum === Number(s[3]);
}

// A naming word before the number, within this many characters (same line).
const NEAR = 40;
const before = (text: string, at: number, re: RegExp) => re.test(text.slice(Math.max(0, at - NEAR), at).split('\n').pop() ?? '');
const CARD_WORD = /\b(?:card|carte|karte|kreditkarte|visa|master ?card|amex|american express|cc|cb|kartennummer|num[ée]ro de carte)\b/i;
const SSN_WORD = /\b(?:ssn|social security|s[ée]curit[ée] sociale|s[ée]cu|nir|insee|national insurance|ni (?:number|no)|nino|sozialversicherung\w*|sv-?(?:nummer|nr)|svnr|versicherungsnummer|e-card)\b/i;
const TAX_WORD = /\b(?:tax (?:id|number|no|identification)|tin|steuer-?id|steuer-?identifikationsnummer|identifikationsnummer|idnr|steuernummer|st\.?-?nr|num[ée]ro fiscal|num[ée]ro d'identification fiscale|nif|spi)\b/i;
const PASS_WORD = /\b(?:passport|reisepass|passeport|pass-?nr|passnummer|ausweis-?nr|personalausweis|id card no)\b/i;

/** Money and ID number spans in `text`, sorted, not overlapping. */
export function findPii(text: string): PiiSpan[] {
  const out: PiiSpan[] = [];
  const add = (kind: PiiKind, start: number, end: number) => {
    if (!out.some(s => start < s.end && end > s.start)) out.push({ kind, start, end });
  };
  for (const m of text.matchAll(/(?<![A-Z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?(?![A-Z0-9])/g)) {
    let v = m[0];
    // a trailing word after the last group is not part of the number: shorten until the checksum holds
    while (v.length >= 15 && !ibanOk(v.replace(/ /g, ''))) { const cut = v.lastIndexOf(' '); if (cut < 0) break; v = v.slice(0, cut); }
    if (ibanOk(v.replace(/ /g, ''))) add('iban', m.index, m.index + v.length);
  }
  for (const m of text.matchAll(/(?<![\d.,-])\d(?:[ -]?\d){12,18}(?![\d.,]\d|\d)/g)) {
    const d = m[0].replace(/[ -]/g, '');
    if (d.length < 13 || d.length > 19 || !luhn(d) || !CARD_IIN.test(d) || /^(\d)\1+$/.test(d) || isTestCard(d)) continue;
    if (/^\d{4}([ -])\d{4}\1\d{4}\1\d{1,7}$/.test(m[0]) || before(text, m.index, CARD_WORD)) add('card-number', m.index, m.index + m[0].length);
  }
  for (const m of text.matchAll(/(?<![\dA-Z])[12] ?\d{2} ?\d{2} ?(?:\d{2}|2[AB]) ?\d{3} ?\d{3} ?\d{2}(?![\d])/g)) {
    if (nirOk(m[0].replace(/ /g, ''))) add('social-security-number', m.index, m.index + m[0].length);
  }
  for (const m of text.matchAll(/(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g)) if (before(text, m.index, SSN_WORD)) add('social-security-number', m.index, m.index + m[0].length);
  for (const m of text.matchAll(/(?<![A-Z0-9])[A-CEGHJ-PR-TW-Z]{2} ?\d{2} ?\d{2} ?\d{2} ?[A-D](?![A-Z0-9])/g)) {
    if (before(text, m.index, SSN_WORD)) add('social-security-number', m.index, m.index + m[0].length);
  }
  for (const m of text.matchAll(/(?<!\d)\d{4} ?\d{6}(?!\d)/g)) {
    const d = m[0].replace(/ /g, '');
    if (svnrOk(d) && before(text, m.index, SSN_WORD)) add('social-security-number', m.index, m.index + m[0].length);
  }
  for (const m of text.matchAll(/(?<![\w/])(?=[A-Z0-9 /.-]*\d)[A-Z0-9][A-Z0-9 /.-]{6,18}[A-Z0-9](?![\w/])/g)) {
    const digits = m[0].replace(/\D/g, '').length;
    if (digits >= 8 && before(text, m.index, TAX_WORD)) add('tax-id', m.index, m.index + m[0].length);
  }
  for (const m of text.matchAll(/(?<![\w])(?=[A-Z0-9]*\d)[A-Z0-9]{6,9}(?![\w])/g)) {
    if (before(text, m.index, PASS_WORD)) add('passport-number', m.index, m.index + m[0].length);
  }
  return out.sort((a, b) => a.start - b.start);
}
