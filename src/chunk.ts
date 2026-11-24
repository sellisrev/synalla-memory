// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// Chunking as in the measured benchmark harness (memory_ab/build_index.py): pieces of at most 1,600 characters with
// 200 characters of overlap, cut at a blank line, a line end or a sentence end in the second half of the window, each
// prefixed with a one-line header "[date] source | title" so a passage carries its context into search and prompt.

export const CHUNK = 1600;
export const OVERLAP = 200;

/** Python's str.rfind(sub, start, end): last index of `sub` lying wholly inside [start, end), or -1. */
function rfind(text: string, sub: string, start: number, end: number): number {
  const i = text.lastIndexOf(sub, end - sub.length);
  return i >= start && i + sub.length <= end ? i : -1;
}

/** Python's str.strip() for the whitespace that occurs in text. */
function strip(s: string): string { return s.replace(/^[\s\u0085]+|[\s\u0085]+$/g, ''); }

export function chunkText(text: string, size = CHUNK): string[] {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (!Number.isSafeInteger(size) || size < 2) throw new TypeError('size must be an integer >= 2');
  text = strip(text);
  if (text.length <= size) return text ? [text] : [];
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const lo = start + Math.floor(size / 2);
      const cut = Math.max(rfind(text, '\n\n', lo, end), rfind(text, '\n', lo, end), rfind(text, '. ', lo, end));
      if (cut > start) end = cut + 1;
    }
    out.push(strip(text.slice(start, end)));
    if (end >= text.length) break;
    start = Math.max(end - OVERLAP, start + 1);
  }
  return out.filter(c => c);
}

export function header(date: string, source: string, title: string): string {
  return `[${(date || '').slice(0, 10)}] ${source || ''} | ${(title || '').slice(0, 150)}`;
}

/** Header-prefixed chunks for one item, as stored and embedded. */
export function itemChunks(item: { date: string; source: string; title?: string; text: string }): string[] {
  const h = header(item.date, item.source, item.title ?? '');
  return chunkText(item.text).map(c => `${h}\n${c}`);
}
