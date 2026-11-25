// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// Wants: the owner's needs, wants and problems that someone on their network could help with, found as records come
// in, so the agent can look for a match without being asked, and stop once the need is met.
//
// Each new record is read once (in date order) with the wants still open: the model lists new wants of the owner
// (not someone else's, not a what-if, not a task the agent finishes itself) with a topic from the published list, a
// confidence and a quote, and the open wants this record shows as met. A want or a closure counts only if its quote
// is in the record. Only wants at confidence 0.9 or more are shown or matched: the threshold the circle calibration
// measured (benchmark/circle: below it precision falls with almost no gain in recall).
//
// Matching follows circle/1 (synalla/src/entries.ts candidates()): same topic, not expired; tags only rank. A
// proposal also needs a shared place tag when the ask carries one, so an offer in another city is not proposed.

import type { StoredItem, Want, WantInput } from './store.ts';
import type { ChatModel } from './facts.ts';
import { itemWindows } from './facts.ts';

/** The published topic vocabulary of circle/1 asks and entries (what kind of help or thing someone could offer). */
export const TOPICS = Object.freeze([
  'babysitting', 'childcare', 'tutoring', 'language-exchange', 'moving-help', 'furniture', 'bike-repair', 'car-repair',
  'plumbing', 'electrician', 'home-cleaning', 'gardening', 'pet-sitting', 'dog-walking', 'vet-advice', 'physiotherapy',
  'doctor-recommendation', 'dentist', 'mental-health-support', 'fitness-partner', 'running-group', 'cooking-lessons',
  'catering', 'event-venue', 'photography', 'travel-advice', 'accommodation', 'car-sharing', 'airport-ride', 'tax-advice',
  'legal-advice', 'accounting', 'insurance', 'mortgage-advice', 'job-search', 'hiring', 'mentoring', 'cofounder-search',
  'funding', 'marketing', 'website', 'it-help', 'laptop-repair', 'phone-repair', 'sewing-alterations', 'music-lessons',
  'sports-equipment', 'camping-gear', 'baby-gear', 'school-choice', 'elder-care', 'translation', 'visa-help',
  'second-hand-goods', 'wine-export', 'restaurant-equipment', 'lifts', 'makerspace', 'camera-gear', 'tech-advice',
  'farm-equipment',
] as const);

export const WANT_THRESHOLD = 0.9;
const MAX_NEW = 5;

export const WANTS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['new', 'met'],
  properties: {
    new: {
      type: 'array', maxItems: MAX_NEW, items: {
        type: 'object', additionalProperties: false, required: ['what', 'topic', 'confidence', 'quote'],
        properties: { what: { type: 'string' }, topic: { type: 'string', enum: [...TOPICS] }, confidence: { type: 'number' }, quote: { type: 'string' } },
      },
    },
    met: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['id', 'quote'],
        properties: { id: { type: 'integer' }, quote: { type: 'string' } },
      },
    },
  },
} as const;

export function wantsPrompt(owner: string, open: readonly Pick<Want, 'wid' | 'what'>[]): string {
  return `You read one record from the personal memory of ${owner}, to find what ${owner} needs that someone they know
could help with: something to borrow or buy second-hand, a person or professional to recommend, someone to do a task
or cover for them, an introduction, advice from someone who has done it.

1. "new": needs, wants or problems of ${owner} in this record that are still unmet. Only ${owner}'s own (not a family
   member's, friend's or client's), only real ones (not a what-if or a plan only considered), not a task the assistant
   finishes in the record, not one already listed as open below. For each: what, as a short phrase; topic, the closest
   from the list; confidence from 0 to 1 that this is a real, unmet need of ${owner}; quote, an exact copy of the
   shortest passage that shows it.
2. "met": open needs below that this record shows as solved or no longer needed, with the quote that shows it.

Open needs:
${open.length ? open.map(w => `- id ${w.wid}: ${w.what}`).join('\n') : '- (none)'}

Topics: ${TOPICS.join(', ')}.

Return {"new": [], "met": []} if there is nothing.

RECORD
`;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Parse a reply; keep wants and closures whose quote is in `text` and whose topic and ids are valid. */
export function checkWants(reply: string, text: string, openIds: ReadonlySet<number>): { opened: WantInput[]; met: { wid: number; quote: string }[]; dropped: number } {
  let parsed: unknown;
  try { parsed = JSON.parse(reply); } catch { throw new Error('wants reply is not JSON'); }
  const p = parsed as { new?: unknown; met?: unknown };
  if (!Array.isArray(p.new) || !Array.isArray(p.met)) throw new Error('wants reply has no "new" and "met" lists');
  const hay = norm(text);
  const has = (q: unknown) => typeof q === 'string' && q.trim() !== '' && hay.includes(norm(q));
  let dropped = 0;
  const opened: WantInput[] = [];
  for (const w of p.new.slice(0, MAX_NEW) as Record<string, unknown>[]) {
    const ok = w && typeof w.what === 'string' && w.what.trim() !== '' && (TOPICS as readonly unknown[]).includes(w.topic)
      && typeof w.confidence === 'number' && w.confidence >= 0 && w.confidence <= 1 && has(w.quote);
    if (!ok) { dropped++; continue; }
    opened.push({ what: w.what as string, topic: w.topic as string, confidence: w.confidence as number, quote: w.quote as string });
  }
  const met: { wid: number; quote: string }[] = [];
  for (const m of p.met as Record<string, unknown>[]) {
    if (m && Number.isInteger(m.id) && openIds.has(m.id as number) && has(m.quote)) met.push({ wid: m.id as number, quote: m.quote as string });
    else dropped++;
  }
  return { opened, met, dropped };
}

export interface WantStore {
  pendingWantScan(limit: number, opts?: { agentSessions?: boolean }): StoredItem[];
  openWants(): Want[];
  recordWants(item: string, opened: readonly WantInput[], closed: readonly { wid: number; quote: string }[], at?: Date, error?: string | null): number[];
}

/**
 * Read up to `limit` new items for wants, oldest first, each window with the wants open at that point. An item whose
 * every window failed is recorded with the error and not retried.
 */
export async function scanWants(store: WantStore, model: ChatModel, owner: string,
  opts: { limit?: number; agentSessions?: boolean; maxWindows?: number; now?: () => Date; onItem?: (id: string, opened: number, met: number, error?: string) => void } = {},
): Promise<{ items: number; opened: number; met: number; failed: number }> {
  const now = opts.now ?? (() => new Date());
  let items = 0, openedN = 0, metN = 0, failed = 0;
  for (const it of store.pendingWantScan(opts.limit ?? 50, { agentSessions: opts.agentSessions ?? false })) {
    const windows = itemWindows(it, opts.maxWindows ?? 10);
    const opened: WantInput[] = [];
    const met = new Map<number, string>();
    let errors = 0, lastError = '';
    for (const text of windows) {
      const open = store.openWants().filter(w => !met.has(w.wid));
      try {
        const r = checkWants(await model.complete(wantsPrompt(owner, [...open, ...opened.map((w, i) => ({ wid: -1 - i, what: w.what }))]) + text),
          text, new Set(open.map(w => w.wid)));
        for (const w of r.opened) if (!opened.some(o => o.topic === w.topic && norm(o.what) === norm(w.what))) opened.push(w);
        for (const m of r.met) met.set(m.wid, m.quote);
      } catch (e) {
        errors++;
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
    if (errors === windows.length) {
      store.recordWants(it.id, [], [], now(), lastError.slice(0, 300));
      failed++;
      opts.onItem?.(it.id, 0, 0, lastError);
      continue;
    }
    store.recordWants(it.id, opened, [...met].map(([wid, quote]) => ({ wid, quote })), now(),
      errors ? `${errors} of ${windows.length} windows failed: ${lastError}`.slice(0, 300) : null);
    items++; openedN += opened.length; metN += met.size;
    opts.onItem?.(it.id, opened.length, met.size);
  }
  return { items, opened: openedN, met: metN, failed };
}

/** A circle/1 entry as received from the network. */
export interface NetworkEntry { id: string; type: string; topic: string; tags: string[]; text: string; expires: number }

/**
 * Entries that could meet the owner's open wants (confidence at the threshold or above): same topic, not expired,
 * sharing a place tag when `place` is given; ranked by shared tags, then id. `now` in seconds.
 */
export function matchWants(wants: readonly Want[], entries: readonly NetworkEntry[], now: number, opts: { place?: string[]; threshold?: number } = {}):
  { wid: number; entries: NetworkEntry[] }[] {
  const th = opts.threshold ?? WANT_THRESHOLD;
  const place = new Set(opts.place ?? []);
  return wants.filter(w => w.closed_at === null && w.confidence >= th).map(w => ({
    wid: w.wid,
    entries: entries
      .filter(e => e.topic === w.topic && e.expires > now && (place.size === 0 || e.tags.some(t => place.has(t))))
      .map(e => ({ e, shared: e.tags.filter(t => place.has(t)).length }))
      .sort((x, y) => y.shared - x.shared || (x.e.id < y.e.id ? -1 : x.e.id > y.e.id ? 1 : 0))
      .map(x => x.e),
  })).filter(m => m.entries.length > 0);
}
