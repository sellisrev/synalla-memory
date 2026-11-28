// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPii } from '../src/pii.ts';

const found = t => findPii(t).map(s => [s.kind, t.slice(s.start, s.end)]);

test('IBANs with a valid checksum, with or without spaces; a wrong checksum is left alone', () => {
  assert.deepEqual(found('Please pay to DE89 3704 0044 0532 0130 00 by Friday.'), [['iban', 'DE89 3704 0044 0532 0130 00']]);
  assert.deepEqual(found('IBAN: AT611904300234573201'), [['iban', 'AT611904300234573201']]);
  assert.deepEqual(found('FR14 2004 1010 0505 0001 3M02 606 Merci'), [['iban', 'FR14 2004 1010 0505 0001 3M02 606']]);
  assert.deepEqual(found('Ref DE89 3704 0044 0532 0130 01'), []);
});

test('card numbers: Luhn and a card prefix, plus a card word or the usual grouping', () => {
  assert.deepEqual(found('My Visa is 4539 1488 0343 6467, expiry 04/29'), [['card-number', '4539 1488 0343 6467']]);
  assert.deepEqual(found('Stripe test card 4242 4242 4242 4242, declines: 4000 0000 0000 0002'), []);
  assert.deepEqual(found('card number: 5500000000000004'), [['card-number', '5500000000000004']]);
  assert.deepEqual(found('Order 4539148803436467 shipped'), []); // no card word, no grouping
  assert.deepEqual(found('Tracking 1234 5678 9012 3456'), []); // fails Luhn
});

function nirKey(body) { return String(97 - Number(BigInt(body) % 97n)).padStart(2, '0'); }
function svnr(serial3, birth6) { // check digit for an Austrian SV number
  const w = [3, 7, 9, 5, 8, 4, 2, 1, 6], d = (serial3 + birth6).split('').map(Number);
  const s = w.reduce((a, x, i) => a + x * d[i], 0) % 11;
  return s === 10 ? null : serial3 + s + birth6;
}

test('social security numbers: French NIR by its key; US, UK and Austrian ones with a naming word', () => {
  const nir = '1850578006084' + nirKey('1850578006084');
  assert.deepEqual(found(`Mon numéro ${nir} est sur la carte Vitale`), [['social-security-number', nir]]);
  assert.deepEqual(found('1850578006084' + '00'), nirKey('1850578006084') === '00' ? [['social-security-number', '185057800608400']] : []);
  assert.deepEqual(found('SSN 123-45-6789 on file'), [['social-security-number', '123-45-6789']]);
  assert.deepEqual(found('Call 123-45-6789'), []);
  assert.deepEqual(found('National Insurance number: AB 12 34 56 C'), [['social-security-number', 'AB 12 34 56 C']]);
  let sv = null; for (let s = 100; !sv; s++) sv = svnr(String(s), '010180');
  assert.deepEqual(found(`SV-Nummer ${sv}`), [['social-security-number', sv]]);
  assert.deepEqual(found(`Kundennummer ${sv}`), []);
});

test('tax IDs and passport numbers only after a naming word', () => {
  assert.deepEqual(found('Steuer-ID: 12 345 678 901'), [['tax-id', '12 345 678 901']]);
  assert.deepEqual(found('Numéro fiscal 1234567890123'), [['tax-id', '1234567890123']]);
  assert.deepEqual(found('Invoice 12 345 678 901'), []);
  assert.deepEqual(found('Passport no. C01X00T47, expires 2031'), [['passport-number', 'C01X00T47']]);
  assert.deepEqual(found('Booking C01X00T47'), []);
});

test('ordinary numbers stay readable', () => {
  for (const t of ['Call me on +43 660 7351 284', 'Parcel 1Z84 is waiting', 'Meeting on 2026-11-27 at 10:30', 'Order #7710 delayed',
    'Room 2.14 at Praxis Mur', 'EUR 1,140 from January', 'version 3.8.0 (build 20261118.4)', 'Ticket #55102']) assert.deepEqual(found(t), [], t);
});

test('round 2 (after blind set 1): lowercase IBANs, cards with an expiry after them, and the number families set 1 showed', () => {
  assert.deepEqual(found('iban: gb29 nwbk 6016 1331 9268 19'), [['iban', 'gb29 nwbk 6016 1331 9268 19']]);
  assert.deepEqual(found('backup mastercard 5425 2334 3010 9903 11/27, cvv 041'), [['card-number', '5425 2334 3010 9903']]);
  assert.deepEqual(found('Amex 3742 454554 00126 exp 05/29'), [['card-number', '3742 454554 00126']]);
  assert.deepEqual(found('mijn BSN is 111222333'), [['social-security-number', '111222333']]);
  assert.deepEqual(found('rijksregisternummer 85.07.30-033.28'), [['social-security-number', '85.07.30-033.28']]);
  assert.deepEqual(found('steht auf dem Ausweis: 65170839J007'), [['social-security-number', '65170839J007']]);
  assert.deepEqual(found('Sozialversicherungsnummer 65 170839 J 003'), [['social-security-number', '65 170839 J 003']]);
  assert.deepEqual(found('NUSS: 28/12345678/40'), [['social-security-number', '28/12345678/40']]);
  assert.deepEqual(found("my SSN for the credit check lol. it's 078-05-1120"), [['social-security-number', '078-05-1120']]);
  assert.deepEqual(found('Il mio codice fiscale è RSSMRA85T10A562S'), [['tax-id', 'RSSMRA85T10A562S']]);
  assert.deepEqual(found('mi NIE para el contrato es X1234567L'), [['tax-id', 'X1234567L']]);
  assert.deepEqual(found('vom Finanzamt habe ich jetzt die 143/512/60874'), [['tax-id', '143/512/60874']]);
  assert.deepEqual(found('Steuer-ID 65929970489, geboren am 12.03.1991'), [['tax-id', '65929970489']]);
  assert.deepEqual(found('passport (exp 03/2031): 548213976'), [['passport-number', '548213976']]);
  assert.deepEqual(found('Kinderreisepass abgelaufen, neuer Pass C01X00T47'), [['passport-number', 'C01X00T47']]);
});

test('round 2: company VAT numbers, council tax references and numbers under other labels stay readable', () => {
  for (const t of ['USt-IdNr. DE123456789', 'Cliente: Panadería Ortega S.L. (NIF-IVA ESB86451239)', 'council tax ref 4400 2211 9',
    'Bitte geben Sie NIE an, um TANs abzufragen. Vorgangsnummer 2026-11-AX-90214', 'Ihr TIN wird nie per Mail verschickt.',
    'Boarding pass 4471823 for gate B12', 'the SSN field on the order 88213-447 stays empty']) assert.deepEqual(found(t), [], t);
});
