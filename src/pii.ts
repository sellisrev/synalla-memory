// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// Money and ID numbers in imported text (the owner's choice of what gets a stand-in, 27 Nov 2026): IBANs, payment
// card numbers, social security numbers, tax IDs and passport numbers. Names, phone numbers, e-mail and street
// addresses stay readable. Round 2 (benchmark/pii/README.md, after set 1):
// - found by shape alone, where a checksum or the shape is precise: IBAN (mod 97, any case), card number (Luhn and a
//   card prefix, with a card word or a card grouping), French NIR (its key), Italian codice fiscale, Belgian national
//   number (its dotted form);
// - otherwise a naming word ("Steuer-ID", "BSN", "NI number", "pasaporte"...) followed within a few words by a
//   number-shaped value. Short acronyms count only in capitals, so the German "nie" or "ein" never trigger.

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
const CARD_GROUPS = /^(?:\d{4}([ -])\d{4}\1\d{4}\1\d{1,7}|3[47]\d{2}([ -])\d{6}\2\d{5})$/;
function nirOk(s: string): boolean { // French social security number: 13 characters (Corsica 2A/2B) + 2-digit key
  const body = s.slice(0, 13).toUpperCase().replace('2A', '19').replace('2B', '18'), key = Number(s.slice(13));
  return /^\d{13}$/.test(body) && 97 - Number(BigInt(body) % 97n) === key;
}

const CARD_WORD = /\b(?:card|carte|karte|kreditkarte|creditcard|credit card|debit card|tarjeta|carta|visa|master ?card|amex|american express|cc|cb|kartennummer|num[ée]ro de carte|n[úu]mero de tarjeta|numero (?:di|della) carta)\b/i;

// Naming words, each in a case-insensitive part and a capitals-only part (acronyms).
const KIND_WORDS: [PiiKind, RegExp, RegExp][] = [
  ['social-security-number',
    /\b(?:social security|social sec|ss number|s[ée]curit[ée] sociale|num[ée]ro de s[ée]cu|national insurance|n[º°o]\.? national|rijksregister\w*|sozialversicherung\w*|sv-?(?:nummer|nr)\.?|versicherungsnummer|seguridad social|previdenza|e-card|burgerservicenummer|ahv-?(?:nummer|nr)?)/i,
    /\b(?:SSN|SSNs|NIR|INSEE|NINO|NI|BSN|SV|SVNR|NUSS|NAF|AHV)\b/],
  ['tax-id',
    /\b(?:tax (?:id|number|no|ref\w*|identification\w*)|steuer-?id\w*|steuer-?identifikationsnummer|identifikationsnummer|steuernummer|st\.?-?nr\.?|num[ée]ro fiscal|num[ée]ro d'identification fiscale|codice fiscale|n[úu]mero de identificaci[óo]n fiscal)/i,
    /\b(?:TIN|EIN|ITIN|UTR|NIF|NIE|DNI|CF|SPI|IdNr|TFN)\b/],
  ['passport-number',
    /\b(?:passport|reisepass|kinderreisepass|passeport|pasaporte|passaporto|paspoort|pass-?nr\.?|passnummer|ausweis-?nr\.?|personalausweis|id card no)/i,
    /\b(?:Pass)\b(?! (?:auf|mal|bitte))/],
];
// Company numbers are public (VAT IDs, company tax numbers), and a council tax reference is an account number.
const PUBLIC_IDS = /\b(?:USt|VAT|IVA|TVA|BTW|UID|MwSt|council tax)\b[^\n]{0,25}$/i;
// A company's legal footer (register court, register number, managing director) holds its public tax numbers.
const COMPANY_FOOTER = /\b(?:HRB|HRA|Amtsgericht|Registergericht|Handelsregister|Gesch[äa]ftsf[üu]hr\w*|Sitz der Gesellschaft|Registered in|Company (?:No|number)|RCS|SIRE[NT]|VAT ID|USt-IdNr)\b/i;
const companyTax = (text: string, start: number) => COMPANY_FOOTER.test(text.slice(Math.max(0, start - 120), start));
// Another label between the naming word and a value means the value is that label's (an order or case number).
const OTHER_LABEL = /(?:order|invoice|rechnung|booking|buchung|ticket|conf\w*|tracking|aktenzeichen|kunden\w*|vorgang\w*|dossier|r[ée]f[ée]rence|pedido|factura|contract|vertrag|form\b)/i;
// A value after a naming word: an ID-shaped run (capitals, digits, and single spaces, dots, slashes or dashes between).
const VALUE = /(?:[A-Z]{1,3}[ -]?)?\d(?:[ ./-]?[0-9A-Z]){4,22}/y;
const FILLER = /^[^\n\d]{0,45}?(?=(?:[A-Z]{1,3}[ -]?)?\d)/;

/** Money and ID number spans in `text`, sorted, not overlapping. */
export function findPii(text: string): PiiSpan[] {
  const out: PiiSpan[] = [];
  const add = (kind: PiiKind, start: number, end: number) => {
    while (end > start && /[ ./-]/.test(text[end - 1] as string)) end--;
    if (kind === 'tax-id' && companyTax(text, start)) return;
    if (end > start && !out.some(s => start < s.end && end > s.start)) out.push({ kind, start, end });
  };
  for (const m of text.matchAll(/(?<![A-Za-z0-9])[A-Za-z]{2}\d{2}(?: ?[A-Za-z0-9]{4}){2,7}(?: ?[A-Za-z0-9]{1,4})?(?![A-Za-z0-9])/g)) {
    let v = m[0];
    // a trailing word after the last group is not part of the number: shorten until the checksum holds
    while (v.length >= 15 && !ibanOk(v.replace(/ /g, '').toUpperCase())) { const cut = v.lastIndexOf(' '); if (cut < 0) break; v = v.slice(0, cut); }
    if (ibanOk(v.replace(/ /g, '').toUpperCase())) add('iban', m.index, m.index + v.length);
  }
  for (const m of text.matchAll(/(?<![\d.,-])\d(?:[ -]?\d){12,18}(?![\d.,]\d|\d)/g)) {
    let v = m[0];
    const ok = (x: string) => {
      const d = x.replace(/[ -]/g, '');
      return d.length >= 13 && d.length <= 19 && luhn(d) && CARD_IIN.test(d) && !/^(\d)\1+$/.test(d) && !isTestCard(d);
    };
    // digits after the number (an expiry, a CVC) are not part of it: drop trailing groups until the checksum holds
    while (!ok(v) && /[ -]/.test(v)) v = v.slice(0, v.search(/[ -][^ -]*$/));
    if (!ok(v)) continue;
    const line = text.slice(Math.max(0, m.index - 60), m.index).split('\n').pop() ?? '';
    if (CARD_GROUPS.test(v) || CARD_WORD.test(line)) add('card-number', m.index, m.index + v.length);
  }
  for (const m of text.matchAll(/(?<![\dA-Z])[12] ?\d{2} ?\d{2} ?(?:\d{2}|2[AB]) ?\d{3} ?\d{3} ?\d{2}(?![\d])/g)) {
    if (nirOk(m[0].replace(/ /g, ''))) add('social-security-number', m.index, m.index + m[0].length);
  }
  for (const m of text.matchAll(/(?<![A-Z0-9])[A-Z]{6}\d{2}[A-EHLMPRST]\d{2}[A-Z]\d{3}[A-Z](?![A-Z0-9])/g)) add('tax-id', m.index, m.index + m[0].length);
  for (const m of text.matchAll(/(?<![\d.])\d{2}\.\d{2}\.\d{2}-\d{3}\.\d{2}(?![\d.])/g)) add('social-security-number', m.index, m.index + m[0].length);
  // German social security number (area, birth date, initial, serial) and German Steuernummer (office/district/number)
  for (const m of text.matchAll(/(?<![A-Za-z0-9])\d{2} ?[0-3]\d[01]\d\d{2} ?[A-Z] ?\d{3}(?![A-Za-z0-9])/g)) add('social-security-number', m.index, m.index + m[0].length);
  for (const m of text.matchAll(/(?<![\d/])\d{2,3}\/\d{3,4}\/\d{4,5}(?![\d/])/g)) add('tax-id', m.index, m.index + m[0].length);
  // A naming word, then within a few words (same line) the first ID-shaped value.
  for (const [kind, words, acronyms] of KIND_WORDS) {
    // The value comes within a few words of the naming word or acronym, with no other label in between.
    for (const [re, reach] of [[new RegExp(words.source, 'gi'), 45], [new RegExp(acronyms.source, 'g'), 45]] as const) {
      for (const w of text.matchAll(re)) {
        const lineStart = text.lastIndexOf('\n', w.index) + 1;
        if (PUBLIC_IDS.test(text.slice(Math.max(lineStart, w.index - 30), w.index + w[0].length + 5))) continue;
        const after = w.index + w[0].length, nl = text.indexOf('\n', after);
        const limit = Math.min(nl >= 0 ? nl : text.length, after + reach + 30);
        // the first value that qualifies; a date or a short form number before it is passed over
        for (let at = after; at < limit;) {
          const gap = FILLER.exec(text.slice(at, limit));
          if (!gap || at + gap[0].length - after > reach || OTHER_LABEL.test(gap[0])) break;
          VALUE.lastIndex = at + gap[0].length;
          const v = VALUE.exec(text);
          if (!v) break;
          const digits = v[0].replace(/\D/g, '').length, clean = !(text[v.index - 1] && /[A-Za-z0-9]/.test(text[v.index - 1] as string));
          const isDate = /^\d{1,2}[./]\d{1,2}[./]\d{2,4}$|^\d{1,2}[./]\d{2,4}$|^\d{4}-\d{2}(?:-\d{2})?$/.test(v[0]);
          if (clean && !isDate && digits >= (kind === 'passport-number' ? 3 : 6)) { add(kind, v.index, v.index + v[0].length); break; }
          at = v.index + v[0].length;
        }
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
