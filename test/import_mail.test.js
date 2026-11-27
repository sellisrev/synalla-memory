// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMbox, readNotes, decodeHeader, htmlToText, cleanBody } from '../src/import_mail.ts';

const CRLF = s => s.replace(/\n/g, '\r\n');

// A Gmail Takeout-like mbox: separators with dates, CRLF line ends, mixed encodings.
function mbox() {
  const m1 = CRLF(`X-GM-THRID: 1849
X-Gmail-Labels: Inbox,Important
From: =?UTF-8?Q?In=C3=A8s_M=C3=BCller?= <ines@example.org>
To: serge@example.net
Subject: =?UTF-8?B?w4l0w6kgw6AgV2llbg==?= =?UTF-8?Q?_=E2=80=93_keys?=
Date: Thu, 13 Nov 2026 10:00:00 +0100 (CET)
Message-ID: <m1@example.org>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="outer"

--outer
Content-Type: multipart/alternative; boundary=inner

--inner
Content-Type: text/plain; charset="utf-8"
Content-Transfer-Encoding: quoted-printable

The keys for the Ottakring flat are with Frau Gr=C3=BCnwald, door 4.=20
See you on Saturday.

On Wed, 12 Nov 2026 at 09:00, Serge <serge@example.net> wrote:
> When can I get the keys?

--=20
In=C3=A8s
--inner
Content-Type: text/html; charset="utf-8"

<p>HTML copy that must not be used</p>
--inner--
--outer
Content-Type: application/pdf; name="lease.pdf"
Content-Disposition: attachment; filename="lease.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjQK
--outer--
`);
  const htmlLatin1 = Buffer.from("<html><head><style>p{color:red;}</style></head><body><p>Votre rendez-vous chez l'opticien est confirmé &amp; payé.</p><br>Mardi 9h</body></html>", 'latin1').toString('base64');
  const m2 = CRLF(`X-Gmail-Labels: Inbox
From: "Optique Centrale" <rdv@optique.example>
Subject: Rendez-vous
Date: not a date
Message-ID: <m2@optique.example>
Content-Type: text/html; charset=iso-8859-1
Content-Transfer-Encoding: base64

${htmlLatin1}
`);
  const spam = CRLF(`X-Gmail-Labels: Spam
From: x@spam.example
Subject: You won
Date: Fri, 14 Nov 2026 10:00:00 +0000
Message-ID: <s@spam.example>

Click here
`);
  const promo = n => CRLF(`X-Gmail-Labels: "Category Promotions",Inbox
From: Shop <news@shop.example>
Subject: Sale ${n}
Date: Sat, ${15 + n} Nov 2026 10:00:00 +0000
Message-ID: <p${n}@shop.example>
Content-Type: text/plain

Big sale number ${n}
`);
  const fromLine = CRLF(`From: anna@example.org
Subject: Poem
Date: Sun, 16 Nov 2026 08:00:00 +0000
Message-ID: <poem@example.org>

First line
>From the hills, a line that starts with From
`);
  return [
    'From 1849@xxx Thu Nov 13 09:00:00 +0000 2026\r\n' + m1,
    'From 1850@xxx Tue Nov 11 08:30:00 +0000 2026\r\n' + m2,
    'From 1851@xxx Fri Nov 14 10:00:00 +0000 2026\r\n' + spam,
    'From 1852@xxx Sat Nov 15 10:00:00 +0000 2026\r\n' + promo(1),
    'From 1853@xxx Sun Nov 16 10:00:00 +0000 2026\r\n' + promo(2),
    'From 1854@xxx Sun Nov 16 08:00:00 +0000 2026\r\n' + fromLine,
  ].join('\r\n');
}

test('mbox: one item per message, readable body only, encodings decoded, spam dropped, bulk sampled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synalla-mail-'));
  try {
    const p = join(dir, 'All mail.mbox');
    writeFileSync(p, mbox());
    const stats = { seen: 0, kept: 0, spamTrash: 0, badDate: 0, bulkHeadersOnly: 0, empty: 0, errors: 0 };
    const items = [...readMbox(p, stats)];
    assert.deepEqual(stats, { seen: 6, kept: 5, spamTrash: 1, badDate: 0, bulkHeadersOnly: 1, empty: 0, errors: 0 });
    const [m1, m2, p1, p2, poem] = items;
    assert.equal(m1.title, 'Été à Wien – keys');
    assert.equal(m1.date, '2026-11-13T09:00:00.000Z');
    assert.equal(m1.text, 'The keys for the Ottakring flat are with Frau Grünwald, door 4.\nSee you on Saturday.');
    assert.match(m1.id, /^mail:[0-9a-f]{16}$/);
    assert.match(m1.chunks[0], /^\[2026-11-13\] mail \| Été à Wien – keys\nThe keys/);
    assert.equal(m2.date, '2026-11-11T08:30:00.000Z', 'an unreadable Date header falls back to the separator line');
    assert.equal(m2.text, "Votre rendez-vous chez l'opticien est confirmé & payé.\nMardi 9h");
    assert.equal([p1.text, p2.text].join('|'), 'Big sale number 1|', 'promotions: a body for the first per sender and month only');
    assert.equal(p2.title, 'Sale 2');
    assert.equal(poem.text, 'First line\nFrom the hills, a line that starts with From');
    const again = [...readMbox(p, { ...stats })];
    assert.deepEqual(again.map(i => i.id), items.map(i => i.id), 'ids are stable across imports');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('header words, HTML and body cleaning', () => {
  assert.equal(decodeHeader('=?iso-8859-1?Q?Caf=E9?= =?iso-8859-1?Q?_cr=E8me?='), 'Café crème');
  assert.equal(decodeHeader('plain subject'), 'plain subject');
  assert.equal(decodeHeader(Buffer.from('Grüße', 'utf8').toString('latin1')), 'Grüße', 'raw 8-bit UTF-8 headers');
  assert.equal(htmlToText('<div>a&nbsp;b &#233; &#x263A; &Eacute;&zwnj;</div><script>x()</script>').trim(), 'a b é ☺ É‌');
  assert.equal(htmlToText('<!--[if mso]><p>Outlook copy</p><![endif]--><img alt="a > b" src="x">Hi').trim(), 'Hi', 'comments and quoted > in attributes');
  assert.equal(cleanBody('Hello\n\n\n\nLe 3 nov. 2026, Paul a écrit :\n> old'), 'Hello');
  assert.equal(cleanBody('Hi\nAm 3. Nov. 2026 schrieb Paul <p@x.at>:\nold'), 'Hi');
  assert.equal(cleanBody('From: someone at the top is kept\nbody'), 'From: someone at the top is kept\nbody');
});

test('notes: text files in a folder, one item each, dated by their change; hidden folders skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synalla-notes-'));
  try {
    mkdirSync(join(dir, 'garden')); mkdirSync(join(dir, '.obsidian')); mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'garden', 'plan.md'), '﻿# Vegetable plan\n\nTomatoes along the south wall.');
    writeFileSync(join(dir, 'todo.txt'), 'call the plumber');
    writeFileSync(join(dir, 'empty.md'), '  ');
    writeFileSync(join(dir, 'photo.jpg'), 'binary');
    writeFileSync(join(dir, '.obsidian', 'conf.md'), '# config');
    writeFileSync(join(dir, 'node_modules', 'x.md'), '# dep');
    utimesSync(join(dir, 'todo.txt'), new Date('2026-10-01T12:00:00Z'), new Date('2026-10-01T12:00:00Z'));
    const items = readNotes(dir);
    assert.deepEqual(items.map(i => [i.id, i.title, i.source]), [['notes:garden/plan.md', 'Vegetable plan', 'notes'], ['notes:todo.txt', 'todo', 'notes']]);
    assert.equal(items[1].date, '2026-10-01T12:00:00.000Z');
    assert.equal(items[0].text, '# Vegetable plan\n\nTomatoes along the south wall.');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
