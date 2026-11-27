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
