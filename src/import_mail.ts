// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// Mail (mbox) and notes to memory items (pilot plan W1), as in the measured private test (memory_ab/ingest_mbox.py):
// one item per message, the readable body only. Plain text, else the HTML converted to text; quoted replies, signatures
// and leaked style rules removed. Attachments are left out. Gmail's Spam and Trash are dropped; Promotions, Social and
// Forums keep a body only for the first message per sender and month. The item's id comes from the Message-ID, so a
// second import of the same mailbox replaces nothing that did not change. The file is streamed, never read whole.
//
// MIME is parsed here (no dependency): folded headers, RFC 2047 encoded words, nested multiparts, base64 and
// quoted-printable, any charset Node's TextDecoder knows (UTF-8 otherwise). Secrets are scrubbed by the store.

import { createHash } from 'node:crypto';
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { itemChunks } from './chunk.ts';

export interface MailItem { id: string; date: string; source: string; title: string; text: string; chunks: string[] }

const MAX_TEXT = 200000;
const BULK = new Set(['Category Promotions', 'Category Social', 'Category Forums']);
const DROP = new Set(['Spam', 'Trash']);
const QUOTE_HEAD = /^(On .{5,200} wrote:|Le .{5,200} a écrit\s?:|Am .{5,200} schrieb .{0,80}:|-{2,}\s*Original Message\s*-{2,}|-{2,}\s*Message d.origine\s*-{2,}|From: .+)$/i;
const CSS_BLOCK = /[^\n{}]{0,300}\{[^{}]*;[^{}]*\}/g;

// ---- bytes and charsets (a message is held as a latin1 string: one char per byte) ----

function decodeBytes(bin: string, charset: string): string {
  const bytes = Buffer.from(bin, 'latin1');
  const cs = (charset || 'utf-8').toLowerCase().trim();
  try { return new TextDecoder(cs === 'us-ascii' || cs === 'ascii' ? 'utf-8' : cs).decode(bytes); }
  catch { return new TextDecoder('utf-8').decode(bytes); }
}

/** Raw header bytes: UTF-8 when valid (8-bit headers in the wild), else Windows-1252. */
function rawHeader(bin: string): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(bin, 'latin1')); }
  catch { return new TextDecoder('windows-1252').decode(Buffer.from(bin, 'latin1')); }
}

function qp(bin: string, header = false): string {
  if (header) bin = bin.replace(/_/g, ' ');
  return bin.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

function b64(s: string): string { return Buffer.from(s.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('latin1'); }

/** RFC 2047: =?charset?B|Q?text?=, adjacent encoded words joined without the space between them. */
export function decodeHeader(v: string): string {
  const s = rawHeader(v).replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1');
  return s.replace(/=\?([^?*]+)(?:\*[^?]*)?\?([BbQq])\?([^?]*)\?=/g, (_, cs: string, enc: string, t: string) =>
    decodeBytes(enc.toUpperCase() === 'B' ? b64(t) : qp(t, true), cs));
}

// ---- MIME ----

interface Part { headers: Map<string, string>; body: string }

function parsePart(bin: string): Part {
  const m = /\r?\n\r?\n/.exec(bin);
  const head = m ? bin.slice(0, m.index) : bin, body = m ? bin.slice(m.index + m[0].length) : '';
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    if (!headers.has(k)) headers.set(k, line.slice(i + 1).trim());
  }
  return { headers, body };
}

function param(v: string | undefined, name: string): string {
  const m = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(v ?? '');
  return m ? (m[1] ?? m[2] ?? '') : '';
}

function contentType(p: Part): string { return (p.headers.get('content-type') ?? 'text/plain').split(';')[0]!.trim().toLowerCase(); }

function partText(p: Part): string {
  const enc = (p.headers.get('content-transfer-encoding') ?? '').toLowerCase().trim();
  const bin = enc === 'base64' ? b64(p.body) : enc === 'quoted-printable' ? qp(p.body) : p.body;
  return decodeBytes(bin, param(p.headers.get('content-type'), 'charset'));
}

function collect(p: Part, plain: string[], html: string[], depth = 0): void {
  const ct = contentType(p);
  if (ct.startsWith('multipart/') && depth < 20) {
    const boundary = param(p.headers.get('content-type'), 'boundary');
    if (!boundary) return;
    const esc = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pieces = p.body.split(new RegExp(`^--${esc}(?:--)?[ \\t]*\\r?$`, 'm'));
    for (const piece of pieces.slice(1, -1)) collect(parsePart(piece.replace(/^\r?\n/, '')), plain, html, depth + 1);
    return;
  }
  const disp = (p.headers.get('content-disposition') ?? '').toLowerCase();
  if (disp.startsWith('attachment') || /filename\s*=|name\s*=/.test(disp + ';' + (p.headers.get('content-type') ?? '').replace(/charset=[^;]*/i, ''))) return;
  if (ct === 'text/plain') plain.push(partText(p));
  else if (ct === 'text/html') html.push(partText(p));
}

// The 252 HTML 4 named entities (Python's html.entities.name2codepoint, as the measured ingester decoded them),
// name:hex code point, case-sensitive; plus &apos;.
const ENTITY_TABLE =
  'AElig:c6 Aacute:c1 Acirc:c2 Agrave:c0 Alpha:391 Aring:c5 Atilde:c3 Auml:c4 Beta:392 Ccedil:c7 Chi:3a7 ' +
  'Dagger:2021 Delta:394 ETH:d0 Eacute:c9 Ecirc:ca Egrave:c8 Epsilon:395 Eta:397 Euml:cb Gamma:393 Iacute:cd ' +
  'Icirc:ce Igrave:cc Iota:399 Iuml:cf Kappa:39a Lambda:39b Mu:39c Ntilde:d1 Nu:39d OElig:152 Oacute:d3 ' +
  'Ocirc:d4 Ograve:d2 Omega:3a9 Omicron:39f Oslash:d8 Otilde:d5 Ouml:d6 Phi:3a6 Pi:3a0 Prime:2033 Psi:3a8 ' +
  'Rho:3a1 Scaron:160 Sigma:3a3 THORN:de Tau:3a4 Theta:398 Uacute:da Ucirc:db Ugrave:d9 Upsilon:3a5 Uuml:dc ' +
  'Xi:39e Yacute:dd Yuml:178 Zeta:396 aacute:e1 acirc:e2 acute:b4 aelig:e6 agrave:e0 alefsym:2135 alpha:3b1 ' +
  'amp:26 and:2227 ang:2220 aring:e5 asymp:2248 atilde:e3 auml:e4 bdquo:201e beta:3b2 brvbar:a6 bull:2022 ' +
  'cap:2229 ccedil:e7 cedil:b8 cent:a2 chi:3c7 circ:2c6 clubs:2663 cong:2245 copy:a9 crarr:21b5 cup:222a ' +
  'curren:a4 dArr:21d3 dagger:2020 darr:2193 deg:b0 delta:3b4 diams:2666 divide:f7 eacute:e9 ecirc:ea egrave:e8 ' +
  'empty:2205 emsp:2003 ensp:2002 epsilon:3b5 equiv:2261 eta:3b7 eth:f0 euml:eb euro:20ac exist:2203 fnof:192 ' +
  'forall:2200 frac12:bd frac14:bc frac34:be frasl:2044 gamma:3b3 ge:2265 gt:3e hArr:21d4 harr:2194 hearts:2665 ' +
  'hellip:2026 iacute:ed icirc:ee iexcl:a1 igrave:ec image:2111 infin:221e int:222b iota:3b9 iquest:bf ' +
  'isin:2208 iuml:ef kappa:3ba lArr:21d0 lambda:3bb lang:2329 laquo:ab larr:2190 lceil:2308 ldquo:201c le:2264 ' +
  'lfloor:230a lowast:2217 loz:25ca lrm:200e lsaquo:2039 lsquo:2018 lt:3c macr:af mdash:2014 micro:b5 middot:b7 ' +
  'minus:2212 mu:3bc nabla:2207 nbsp:a0 ndash:2013 ne:2260 ni:220b not:ac notin:2209 nsub:2284 ntilde:f1 nu:3bd ' +
  'oacute:f3 ocirc:f4 oelig:153 ograve:f2 oline:203e omega:3c9 omicron:3bf oplus:2295 or:2228 ordf:aa ordm:ba ' +
  'oslash:f8 otilde:f5 otimes:2297 ouml:f6 para:b6 part:2202 permil:2030 perp:22a5 phi:3c6 pi:3c0 piv:3d6 ' +
  'plusmn:b1 pound:a3 prime:2032 prod:220f prop:221d psi:3c8 quot:22 rArr:21d2 radic:221a rang:232a raquo:bb ' +
  'rarr:2192 rceil:2309 rdquo:201d real:211c reg:ae rfloor:230b rho:3c1 rlm:200f rsaquo:203a rsquo:2019 ' +
  'sbquo:201a scaron:161 sdot:22c5 sect:a7 shy:ad sigma:3c3 sigmaf:3c2 sim:223c spades:2660 sub:2282 sube:2286 ' +
  'sum:2211 sup:2283 sup1:b9 sup2:b2 sup3:b3 supe:2287 szlig:df tau:3c4 there4:2234 theta:3b8 thetasym:3d1 ' +
  'thinsp:2009 thorn:fe tilde:2dc times:d7 trade:2122 uArr:21d1 uacute:fa uarr:2191 ucirc:fb ugrave:f9 uml:a8 ' +
  'upsih:3d2 upsilon:3c5 uuml:fc weierp:2118 xi:3be yacute:fd yen:a5 yuml:ff zeta:3b6 zwj:200d zwnj:200c apos:27';
const ENTITIES: Record<string, string> = Object.fromEntries(ENTITY_TABLE.split(' ')
  .map(e => e.split(':') as [string, string]).map(([k, v]) => [k, String.fromCodePoint(parseInt(v, 16))]));

export function htmlToText(h: string): string {
  return h.replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(br|p|div|tr|li|h[1-6]|table)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, '\n')
    .replace(/<[a-zA-Z!/?](?:[^>"']|"[^"]*"|'[^']*')*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => e[0] === '#'
      ? String.fromCodePoint(parseInt(e[1] === 'x' || e[1] === 'X' ? e.slice(2) : e.slice(1), e[1] === 'x' || e[1] === 'X' ? 16 : 10))
      : ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m);
}

export function cleanBody(t: string): string {
  const out: string[] = [];
  for (const ln of t.replace(CSS_BLOCK, '').replace(/\r\n?/g, '\n').split('\n')) {
    const s = ln.trim();
    if (s === '--') break; // signature
    if (QUOTE_HEAD.test(s) && out.length > 0) break; // a quoted reply chain starts
    if (s.startsWith('>')) continue;
    out.push(ln.trimEnd());
  }
  return out.join('\n').replace(/[ \t\u00a0]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

function labels(v: string | undefined): string[] {
  return (v ?? '').split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(x => x.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

function parseDate(v: string | undefined, sep: string): Date | null {
  const t = Date.parse((v ?? '').replace(/\([^)]*\)/g, '').trim());
  if (Number.isFinite(t)) return new Date(t);
  const m = /([A-Z][a-z]{2}) ([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4}) (\d{4})/.exec(sep);
  if (!m) return null;
  const s = Date.parse(`${m[1]}, ${m[3]} ${m[2]} ${m[6]} ${m[4]} ${m[5]}`);
  return Number.isFinite(s) ? new Date(s) : null;
}

function senderOf(from: string): string {
  const m = /<([^>]+)>/.exec(from) ?? /([^\s<>,;"]+@[^\s<>,;"]+)/.exec(from);
  return (m?.[1] ?? from).toLowerCase().trim();
}

export interface MailStats { seen: number; kept: number; spamTrash: number; badDate: number; bulkHeadersOnly: number; empty: number; errors: number }

/** One message (a latin1 string of its bytes) to an item, or a reason it is left out. */
export function mailItem(bin: string, sep: string, sampled: Set<string>): MailItem | 'spam_trash' | 'bad_date' | 'empty' {
  const top = parsePart(bin.replace(/^>(>*From )/gm, '$1'));
  const lab = labels(top.headers.get('x-gmail-labels'));
  if (lab.some(l => DROP.has(l))) return 'spam_trash';
  const date = parseDate(top.headers.get('date'), sep);
  if (!date) return 'bad_date';
  const from = decodeHeader(top.headers.get('from') ?? '');
  const bulk = lab.some(l => BULK.has(l));
  const key = `${senderOf(from)} ${date.toISOString().slice(0, 7)}`;
  const withBody = !bulk || !sampled.has(key);
  if (bulk) sampled.add(key);
  let text = '';
  if (withBody) {
    const plain: string[] = [], html: string[] = [];
    collect(top, plain, html);
    text = cleanBody(plain.length ? plain.join('\n\n') : htmlToText(html.join('\n'))).slice(0, MAX_TEXT);
  }
  const title = decodeHeader(top.headers.get('subject') ?? '').trim();
  if (!text && !title) return 'empty';
  const mid = (top.headers.get('message-id') ?? '').trim() || createHash('sha256').update(bin.slice(0, 4096), 'latin1').digest('hex');
  const item = { id: 'mail:' + createHash('sha256').update(mid).digest('hex').slice(0, 16), date: date.toISOString(), source: 'mail', title, text };
  return { ...item, chunks: itemChunks(item) };
}

/** Each message of an mbox file with its "From " separator line, streamed in 1 MB reads. */
export function* mboxMessages(path: string): Generator<{ sep: string; bin: string }> {
  // A separator is a line starting "From " at the top of the file or after a blank line (mboxo/mboxrd).
  const fd = openSync(path, 'r'), buf = Buffer.alloc(1 << 20);
  let rest = '', sep = '', lines: string[] = [], started = false, prevBlank = true;
  const isSep = (line: string) => line.startsWith('From ') && prevBlank;
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      const data = rest + buf.toString('latin1', 0, n);
      const parts = data.split('\n');
      rest = n === 0 ? '' : parts.pop()!;
      if (n === 0 && parts.length && parts[parts.length - 1] === '') parts.pop();
      for (const line of parts) {
        if (isSep(line)) {
          if (started) yield { sep, bin: lines.join('\n') };
          sep = line.replace(/\r$/, ''); lines = []; started = true; prevBlank = false;
          continue;
        }
        if (started) lines.push(line);
        prevBlank = line === '' || line === '\r';
      }
      if (n === 0) { if (started) yield { sep, bin: lines.join('\n') }; return; }
    }
  } finally { closeSync(fd); }
}

/** Every message of an mbox file as items, with counts; a message that cannot be read is counted, not fatal. */
export function* readMbox(path: string, stats: MailStats): Generator<MailItem> {
  const sampled = new Set<string>();
  for (const { sep, bin } of mboxMessages(path)) {
    stats.seen++;
    try {
      const r = mailItem(bin, sep, sampled);
      if (r === 'spam_trash') stats.spamTrash++;
      else if (r === 'bad_date') stats.badDate++;
      else if (r === 'empty') stats.empty++;
      else { if (!r.text) stats.bulkHeadersOnly++; stats.kept++; yield r; }
    } catch { stats.errors++; }
  }
}

// ---- notes ----

const NOTE_EXT = new Set(['.md', '.markdown', '.txt', '.org']);
const MAX_NOTE = 1 << 20;

/** Text notes under a folder (Markdown, plain text, Org), one item each, dated by their last change. Hidden folders and
 *  node_modules are skipped, and files over 1 MB. */
export function readNotes(dir: string): MailItem[] {
  const out: MailItem[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile() || !NOTE_EXT.has(extname(e.name).toLowerCase())) continue;
      const st = statSync(p);
      if (st.size > MAX_NOTE) continue;
      const text = readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim();
      if (!text) continue;
      const rel = relative(dir, p).split('\\').join('/');
      const heading = /^#{1,6}\s+(.+)$/m.exec(text)?.[1]?.trim();
      const item = { id: 'notes:' + rel, date: st.mtime.toISOString(), source: 'notes', title: (heading || basename(p, extname(p))).slice(0, 150), text };
      out.push({ ...item, chunks: itemChunks(item) });
    }
  };
  walk(dir);
  return out;
}
