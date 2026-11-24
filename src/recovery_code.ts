// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// The backup key as a recovery code a person can store in a password manager or write on paper (decision 1): the 32
// bytes plus a 2-byte checksum in Crockford base32, grouped by 5. Reading forgives case, spaces and dashes, and the
// letters people confuse with digits (O for 0, I and L for 1). A mistyped code is refused by the checksum.

import { createHash } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function b32(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

const check = (key: Uint8Array) => createHash('sha256').update('synalla recovery code v1').update(key).digest().subarray(0, 2);

export function toRecoveryCode(key: Uint8Array): string {
  if (!(key instanceof Uint8Array) || key.length !== 32) throw new TypeError('key must be 32 bytes');
  const s = b32(Buffer.concat([Buffer.from(key), check(key)]));
  return s.match(/.{1,5}/g)!.join('-');
}

export function fromRecoveryCode(code: string): Uint8Array {
  if (typeof code !== 'string') throw new TypeError('code must be a string');
  const s = code.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== 55 || [...s].some(c => !ALPHABET.includes(c))) throw new Error('this is not a recovery code (55 letters and digits expected)');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const c of s) {
    value = ((value << 5) | ALPHABET.indexOf(c)) & 0xffff; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  const bytes = Buffer.from(out.slice(0, 34));
  const key = new Uint8Array(bytes.subarray(0, 32));
  if (!check(key).equals(bytes.subarray(32, 34))) throw new Error('the recovery code has a typo (checksum does not match)');
  return key;
}
