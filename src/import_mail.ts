// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// Mail (mbox) and notes to memory items (pilot plan W1), as in the measured private test (memory_ab/ingest_mbox.py):
// one item per message, the readable body only. Plain text, else the HTML converted to text; quoted replies, signatures
// and leaked style rules removed. Attachments are left out; a forwarded message (message/rfc822) is read like the
// reference does. Gmail's Spam and Trash are dropped; Promotions, Social and Forums keep a body only for the first
// message per sender and month. The item's id comes from the Message-ID, so a second import of the same mailbox
// replaces nothing that did not change. The file is streamed, never read whole; a single file without "From " lines
// (an .eml) is one message.
//
// MIME is parsed here (no dependency): folded headers, RFC 2047 encoded words (a character split across two words
// included), RFC 2231 file names, nested multiparts (an unclosed one keeps its last part), base64 and quoted-printable,
// any charset Node's TextDecoder knows (UTF-8 otherwise). Every scan is linear in the input, so hostile mail cannot
// stall an import. Secrets are scrubbed by the store.

import { createHash } from 'node:crypto';
import { closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { itemChunks } from './chunk.ts';

export interface MailItem { id: string; date: string; source: string; title: string; text: string; chunks: string[]; /** Sent by the owner (Gmail label). */ sent?: boolean }

const MAX_TEXT = 200000;
/** Of a larger message only this much is read (the body text is cut at MAX_TEXT anyway). */
const MAX_MESSAGE = 64 << 20;
const BULK = new Set(['Category Promotions', 'Category Social', 'Category Forums']);
const DROP = new Set(['Spam', 'Trash']);
const QUOTE_HEAD = /^(On .{5,200} wrote:|Le .{5,200} a écrit\s?:|Am .{5,200} schrieb .{0,80}:|-{2,}\s*Original Message\s*-{2,}|-{2,}\s*Message d.origine\s*-{2,}|From: .+)$/i;

/** Lone surrogates become U+FFFD, as SQLite stores them, so a stored text compares equal to the next import's. */
export function wellFormed(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

// ---- bytes and charsets (a message is held as a latin1 string: one char per byte) ----

function decodeBytes(bin: string, charset: string): string {
  const bytes = Buffer.from(bin, 'latin1');
  const cs = (charset || 'utf-8').toLowerCase().trim();
  try { return new TextDecoder(cs === 'us-ascii' || cs === 'ascii' ? 'utf-8' : cs).decode(bytes); }
  catch { return new TextDecoder('utf-8').decode(bytes); }
}

/** Raw bytes that should be text: UTF-8 when valid, else Windows-1252 (8-bit headers, old notes). */
function utf8Or1252(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('windows-1252').decode(bytes); }
}

function qp(bin: string, header = false): string {
  if (header) bin = bin.replace(/_/g, ' ');
  return bin.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

function b64(s: string): string { return Buffer.from(s.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('latin1'); }

/** RFC 2047: =?charset?B|Q?text?=. Adjacent encoded words lose the space between them, and their bytes are joined
 *  before decoding when they share a charset, so a character split across two words survives. */
export function decodeHeader(v: string): string {
  const s = utf8Or1252(Buffer.from(v, 'latin1'));
  const re = /=\?([^?*]+)(?:\*[^?]*)?\?([BbQq])\?([^?]*)\?=/g;
  let out = '', last = 0, run: { cs: string; bytes: string } | null = null;
  for (let m: RegExpExecArray | null; (m = re.exec(s)); last = re.lastIndex) {
    const between = s.slice(last, m.index), cs = m[1]!.toLowerCase();
    const bytes = m[2]!.toUpperCase() === 'B' ? b64(m[3]!) : qp(m[3]!, true);
    const adjacent = run !== null && /^\s*$/.test(between);
    if (adjacent && run!.cs === cs) { run!.bytes += bytes; continue; }
    if (run) out += decodeBytes(run.bytes, run.cs);
    if (!adjacent) out += between;
    run = { cs, bytes };
  }
  if (run) out += decodeBytes(run.bytes, run.cs);
  return out + s.slice(last);
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

function transferDecoded(p: Part): string {
  const enc = (p.headers.get('content-transfer-encoding') ?? '').toLowerCase().trim();
  return enc === 'base64' ? b64(p.body) : enc === 'quoted-printable' ? qp(p.body) : p.body;
}

function partText(p: Part): string { return decodeBytes(transferDecoded(p), param(p.headers.get('content-type'), 'charset')); }

/** A part with a file name (name=, filename=, or RFC 2231 name*= / filename*0*=) or marked as an attachment. */
function isAttachment(p: Part): boolean {
  const disp = (p.headers.get('content-disposition') ?? '').toLowerCase();
  const ct = (p.headers.get('content-type') ?? '').replace(/charset\s*=\s*("[^"]*"|[^;]*)/i, '');
  return disp.startsWith('attachment') || /(?:^|;)\s*(?:file)?name\*?(?:\d+\*?)?\s*=/i.test(disp + ';' + ct);
}

function collect(p: Part, plain: string[], html: string[], depth = 0): void {
  if (depth > 20) return;
  const ct = contentType(p);
  if (ct.startsWith('multipart/')) {
    const boundary = param(p.headers.get('content-type'), 'boundary');
    if (!boundary) return;
    const esc = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^--${esc}(--)?[ \\t]*\\r?$`, 'gm');
    const marks: { at: number; end: number; close: boolean }[] = [];
    for (let m: RegExpExecArray | null; (m = re.exec(p.body));) {
      marks.push({ at: m.index, end: m.index + m[0].length, close: !!m[1] });
      if (m[1]) break;
    }
    for (let k = 0; k < marks.length && !marks[k]!.close; k++) { // a missing close delimiter keeps the last part
      const stop = k + 1 < marks.length ? marks[k + 1]!.at : p.body.length;
      collect(parsePart(p.body.slice(marks[k]!.end, stop).replace(/^\r?\n/, '')), plain, html, depth + 1);
    }
    return;
  }
  if (ct === 'message/rfc822') { collect(parsePart(transferDecoded(p)), plain, html, depth + 1); return; }
  if (isAttachment(p)) return;
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
const CP1252 = new TextDecoder('windows-1252');

/** A numeric character reference as browsers and Python read it: 0x80-0x9F as Windows-1252, invalid ones as U+FFFD. */
function charRef(n: number): string {
  if (n >= 0x80 && n <= 0x9f) return CP1252.decode(Uint8Array.of(n));
  return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '\uFFFD';
}

function entities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]{1,8}|#\d{1,9}|[a-zA-Z][a-zA-Z0-9]{0,9});/g, (m, e: string) => e[0] === '#'
    ? charRef(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    : ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m);
}

const BLOCK = new Set(['br', 'p', 'div', 'tr', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table']);
const SKIP = new Set(['script', 'style', 'head']);
const TAG_LIMIT = 4000;

/** HTML to text in one linear pass: tags dropped (a new line for block starts, a space between table cells), comments,
 *  scripts, styles and the head dropped, entities decoded. A "<" that does not start a tag ending within 4,000
 *  characters is text. An unclosed script or style hides the rest, as in the reference; an unclosed head ends at <body>. */
export function htmlToText(h: string): string {
  const low = h.toLowerCase();
  let out = '', i = 0;
  while (i < h.length) {
    const lt = h.indexOf('<', i);
    if (lt < 0) { out += h.slice(i); break; }
    out += h.slice(i, lt);
    if (h.startsWith('<!--', lt)) { const e = h.indexOf('-->', lt + 4); i = e < 0 ? h.length : e + 3; continue; }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)|^<[!?]/.exec(h.slice(lt, lt + 64));
    if (!m) { out += '<'; i = lt + 1; continue; }
    let k = lt + 1, q = '';
    const lim = Math.min(h.length, lt + TAG_LIMIT);
    for (; k < lim; k++) {
      const c = h[k];
      if (q) { if (c === q) q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '>') break;
    }
    if (k >= lim) { out += '<'; i = lt + 1; continue; }
    i = k + 1;
    const closing = m[1] === '/', name = (m[2] ?? '').toLowerCase();
    if (!closing && SKIP.has(name)) {
      let stop = low.indexOf('</' + name, i);
      const atBody = name === 'head' ? low.indexOf('<body', i) : -1;
      if (atBody >= 0 && (stop < 0 || atBody < stop)) { i = atBody; continue; }
      if (stop < 0) { i = h.length; continue; }
      const gt = h.indexOf('>', stop);
      i = gt < 0 ? h.length : gt + 1;
      continue;
    }
    if (!closing && BLOCK.has(name)) out += '\n';
    else if (!closing && (name === 'td' || name === 'th')) out += ' ';
  }
  return entities(out);
}

/** Style rules leaking from badly built plain-text parts ("selector { a: b; c: d }", up to 300 characters of selector on
 *  the line, no nested braces), removed in one linear pass. */
function stripCss(t: string): string {
  let out = '', from = 0, open = -1, semi = false;
  for (let k = 0; k < t.length; k++) {
    const c = t[k];
    if (c === '{') { open = k; semi = false; }
    else if (c === ';' && open >= 0) semi = true;
    else if (c === '}') {
      if (open >= 0 && semi && k - open <= 2000) {
        let s = open;
        const floor = Math.max(from, open - 300);
        while (s > floor && t[s - 1] !== '\n' && t[s - 1] !== '{' && t[s - 1] !== '}') s--;
        out += t.slice(from, s);
        from = k + 1;
      }
      open = -1;
    }
  }
  return out + t.slice(from);
}

export function cleanBody(t: string): string {
  const out: string[] = [];
  for (const ln of stripCss(t).replace(/\r\n?/g, '\n').split('\n')) {
    const s = ln.trim();
    if (s === '--') break; // signature
    if (QUOTE_HEAD.test(s) && out.length > 0) break; // a quoted reply chain starts
    if (s.startsWith('>')) continue;
    out.push(ln.trimEnd());
  }
  return out.join('\n').replace(/[ \t\u00a0]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

/** X-Gmail-Labels: comma-separated, a label with a comma in quotes; split in one pass. */
function labels(v: string | undefined): string[] {
  const out: string[] = [];
  let cur = '', q = false;
  for (const c of v ?? '') {
    if (c === '"') q = !q;
    else if (c === ',' && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}

// Zone names Date.parse does not know (it knows GMT, UT, Z and the North American ones).
const ZONES: Record<string, string> = { CET: '+0100', CEST: '+0200', MEZ: '+0100', MESZ: '+0200', WET: '+0000', WEST: '+0100',
  EET: '+0200', EEST: '+0300', BST: '+0100', MSK: '+0300', JST: '+0900', KST: '+0900', HKT: '+0800', SGT: '+0800',
  AEST: '+1000', AEDT: '+1100', NZST: '+1200', NZDT: '+1300' };

/** An RFC 5322 date: a four-digit year and a time are required; no zone means UTC (as the reference, never local time). */
export function parseMailDate(v: string | undefined): Date | null {
  let s = (v ?? '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/\b\d{4}\b/.test(s) || !/\b\d{1,2}:\d{2}/.test(s)) return null;
  s = s.replace(/\b([A-Z]{3,4})\b(?=\s*$)/, z => ZONES[z] ?? z);
  if (!/[+-]\d{4}\b|\b(?:GMT|UTC?|Z|[ECMP][SD]T)\s*$/.test(s)) s += ' +0000';
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** The date on an mbox separator: "From x Thu Nov 13 09:00:00 +0000 2026" (Gmail) or "From - Thu Nov 13 09:00:00 2026". */
function sepDate(sep: string): Date | null {
  const m = /([A-Z][a-z]{2}) ([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}:\d{2}:\d{2})(?: ([+-]\d{4}))? (\d{4})/.exec(sep);
  if (!m) return null;
  const t = Date.parse(`${m[1]}, ${m[3]} ${m[2]} ${m[6]} ${m[4]} ${m[5] ?? '+0000'}`);
  return Number.isFinite(t) ? new Date(t) : null;
}

function senderOf(from: string): string {
  const m = /<([^>]+)>/.exec(from) ?? /([^\s<>,;"]+@[^\s<>,;"]+)/.exec(from);
  return (m?.[1] ?? from).toLowerCase().trim();
}

export interface MailStats {
  seen: number; kept: number; spamTrash: number; badDate: number; bulkHeadersOnly: number; empty: number; errors: number;
  duplicates?: number; truncated?: number;
}

/** One message (a latin1 string of its bytes) to an item, or a reason it is left out. */
export function mailItem(bin: string, sep: string, sampled: Set<string>): MailItem | 'spam_trash' | 'bad_date' | 'empty' {
  const top = parsePart(bin.replace(/^>(>*From )/gm, '$1'));
  const lab = labels(top.headers.get('x-gmail-labels'));
  if (lab.some(l => DROP.has(l))) return 'spam_trash';
  const date = parseMailDate(top.headers.get('date')) ?? sepDate(sep);
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
    const raw = plain.length ? plain.join('\n\n') : htmlToText(html.join('\n'));
    text = wellFormed(cleanBody(raw.slice(0, 4 * MAX_TEXT)).slice(0, MAX_TEXT));
  }
  const title = wellFormed(decodeHeader(top.headers.get('subject') ?? '').trim());
  if (!text && !title) return 'empty';
  const mid = (top.headers.get('message-id') ?? '').trim() || createHash('sha256').update(bin.slice(0, 4096), 'latin1').digest('hex');
  const item = { id: 'mail:' + createHash('sha256').update(mid).digest('hex').slice(0, 16), date: date.toISOString(), source: 'mail', title, text };
  return { ...item, chunks: itemChunks(item), ...(lab.includes('Sent') ? { sent: true } : {}) };
}

/** Each message of an mbox file with its "From " separator line, streamed in 1 MB reads. A separator is a line starting
 *  "From " at the top of the file or after a blank line (mboxo/mboxrd); a file that does not start with one is read as a
 *  single message. Of a message over 64 MB only the first 64 MB are kept (`truncated`). */
export function* mboxMessages(path: string): Generator<{ sep: string; bin: string; truncated: boolean }> {
  const fd = openSync(path, 'r'), buf = Buffer.alloc(1 << 20);
  let rest = '', sep = '', lines: string[] = [], size = 0, truncated = false, started = false, prevBlank = true;
  const line = function* (l: string): Generator<{ sep: string; bin: string; truncated: boolean }> {
    if (!started && !l.startsWith('From ')) { started = true; sep = ''; } // an .eml, or text before the first separator
    if (l.startsWith('From ') && prevBlank) {
      if (started && (lines.length || sep)) yield { sep, bin: lines.join('\n'), truncated };
      sep = l.replace(/\r$/, ''); lines = []; size = 0; truncated = false; started = true; prevBlank = false;
      return;
    }
    if (size + l.length + 1 > MAX_MESSAGE) truncated = true;
    else { lines.push(l); size += l.length + 1; }
    prevBlank = l === '' || l === '\r';
  };
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      const parts = (rest + buf.toString('latin1', 0, n)).split('\n');
      rest = n === 0 ? '' : parts.pop()!;
      if (rest.length > MAX_MESSAGE) { yield* line(rest.slice(0, MAX_MESSAGE)); rest = ''; } // a line of 64 MB: cut
      if (n === 0 && parts.length && parts[parts.length - 1] === '') parts.pop();
      for (const l of parts) yield* line(l);
      if (n === 0) { if (started && (lines.length || sep)) yield { sep, bin: lines.join('\n'), truncated }; return; }
    }
  } finally { closeSync(fd); }
}

/** Every message of an mbox file as items, with counts; a message that cannot be read is counted, not fatal. Two
 *  messages with the same Message-ID: an identical copy is skipped, a different one gets an id of its own. */
export function* readMbox(path: string, stats: MailStats): Generator<MailItem> {
  const sampled = new Set<string>(), ids = new Map<string, string>();
  for (const { sep, bin, truncated } of mboxMessages(path)) {
    stats.seen++;
    if (truncated) stats.truncated = (stats.truncated ?? 0) + 1;
    try {
      let r = mailItem(bin, sep, sampled);
      if (r === 'spam_trash') { stats.spamTrash++; continue; }
      if (r === 'bad_date') { stats.badDate++; continue; }
      if (r === 'empty') { stats.empty++; continue; }
      const sig = createHash('sha256').update(r.date + '\n' + r.title + '\n' + r.text).digest('hex');
      const before = ids.get(r.id);
      if (before === sig) { stats.duplicates = (stats.duplicates ?? 0) + 1; continue; }
      if (before !== undefined) {
        const item = { ...r, id: `${r.id}-${sig.slice(0, 8)}` };
        r = { ...item, chunks: itemChunks(item) };
      }
      ids.set(r.id, sig);
      if (!r.text) stats.bulkHeadersOnly++;
      stats.kept++;
      yield r;
    } catch { stats.errors++; }
  }
}

// ---- notes ----

const NOTE_EXT = new Set(['.md', '.markdown', '.txt', '.org']);
const MAX_NOTE = 1 << 20;

/** Text notes under a folder (Markdown, plain text, Org), one item each, dated by their last change. Hidden folders,
 *  node_modules, files over 1 MB and anything unreadable are skipped (counted in `stats.skipped`). The id names the
 *  folder (by its real path) and the file inside it, so two folders never overwrite each other's notes. */
export function readNotes(dir: string, stats: { skipped: number } = { skipped: 0 }): MailItem[] {
  const root = realpathSync(dir);
  const tag = createHash('sha256').update(root).digest('hex').slice(0, 8);
  const out: MailItem[] = [];
  const walk = (d: string, depth: number) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
    catch { stats.skipped++; return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) { if (depth < 32) walk(p, depth + 1); continue; } // symlinked folders are not followed
      if (!e.isFile() || !NOTE_EXT.has(extname(e.name).toLowerCase())) continue;
      try {
        const st = statSync(p);
        if (st.size > MAX_NOTE) { stats.skipped++; continue; }
        const text = wellFormed(utf8Or1252(readFileSync(p)).replace(/^\uFEFF/, '').trim());
        if (!text) continue;
        const rel = relative(root, p).split('\\').join('/');
        const heading = /^#{1,6}\s+(.+)$/m.exec(text)?.[1]?.trim();
        const item = { id: `notes:${tag}:${rel}`, date: st.mtime.toISOString(), source: 'notes', title: (heading || basename(p, extname(p))).slice(0, 150), text };
        out.push({ ...item, chunks: itemChunks(item) });
      } catch { stats.skipped++; }
    }
  };
  walk(root, 0);
  return out;
}
