// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// The fact layer (pilot plan W1), as measured in memory_ab (arm B): a chat model reads each item (a short header and
// the first 8,000 characters) and returns up to 15 lasting facts as JSON; a fact is kept only if its quote appears in
// that text (case and spacing ignored). At recall the top 20 facts go to the answering model as one line each, with
// "current" or "superseded on <date>". Dropping facts cost about 16 points on the private test.
//
// Prompt, item text, schema, quote check and line format are copied from memory_ab/extract.py and answer.py, so the
// package reproduces the measured setting. Two wording changes, both needed for a public package: the owner's name is a
// parameter ("their" for "his"), and the example subject names are neutral stand-ins of the same shape for the private
// names the benchmark prompt used.

import type { Fact, FactInput, StoredItem } from './store.ts';
import { guardFetch, sameOrigin } from './egress.ts';

export const ITEM_CHARS = 8000;
export const MAX_FACTS = 15;

export function extractionPrompt(owner: string): string {
  return `You extract lasting facts about the owner of these records (${owner}) and the people, things and plans in their life, for their personal memory.

Keep facts that would still matter weeks later: family and people (names, ages, relations, birthdays), home and places, money (accounts, purchases, prices, salaries, investments, bills), health, work and projects (roles, employers, clients, decisions, status), preferences and dislikes, plans, bookings and appointments, things owned.
Skip marketing, newsletters, generic notifications and anything about strangers.

For each fact give:
- subject: who or what it is about, with a stable name ("${owner}", "Anna", "Acme job offer", "apartment Main Street").
- predicate: a short snake_case relation ("lives_in", "child_of", "bought", "price_paid", "works_on", "status", "prefers", "booked").
- object: the value, short.
- valid_from: ISO date (YYYY-MM-DD) from which it is true, or the record date if unknown.
- valid_to: ISO date when it stops being true if the record says so, else null.
- mentioned_at: the record date (YYYY-MM-DD).
- quote: an exact copy, character for character, of the shortest passage in the record (at most 200 characters) that shows the fact. Do not translate, fix or shorten inside the quote.

Return at most 15 facts, the most important first. Return {"facts": []} if there is nothing lasting.

RECORD
`;
}

export const FACTS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['facts'],
  properties: {
    facts: {
      type: 'array', maxItems: MAX_FACTS, items: {
        type: 'object', additionalProperties: false,
        required: ['subject', 'predicate', 'object', 'valid_from', 'valid_to', 'mentioned_at', 'quote'],
        properties: {
          subject: { type: 'string' }, predicate: { type: 'string' }, object: { type: 'string' },
          valid_from: { type: 'string' }, valid_to: { type: ['string', 'null'] },
          mentioned_at: { type: 'string' }, quote: { type: 'string' },
        },
      },
    },
  },
} as const;

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** The text the extraction model reads for one item. */
export function itemText(it: Pick<StoredItem, 'date' | 'source' | 'title' | 'text'>): string {
  return `Date: ${(it.date || '').slice(0, 10)}\nSource: ${it.source}\nTitle: ${it.title || ''}\n\n${(it.text || '').slice(0, ITEM_CHARS)}`;
}

/** Parse a model reply and keep the facts whose quote is in `text`. Throws on a reply that is not the JSON asked for. */
export function checkFacts(reply: string, text: string): { kept: FactInput[]; dropped: number } {
  let parsed: unknown;
  try { parsed = JSON.parse(reply); } catch { throw new Error('extraction reply is not JSON'); }
  const facts = (parsed as { facts?: unknown }).facts;
  if (!Array.isArray(facts)) throw new Error('extraction reply has no "facts" list');
  const hay = norm(text);
  const kept: FactInput[] = [];
  let dropped = 0;
  for (const f of facts.slice(0, MAX_FACTS) as Record<string, unknown>[]) {
    const ok = f && typeof f === 'object' && ['subject', 'predicate', 'object', 'mentioned_at', 'quote'].every(k => typeof f[k] === 'string')
      && (f['valid_from'] === null || f['valid_from'] === undefined || typeof f['valid_from'] === 'string')
      && (f['valid_to'] === null || f['valid_to'] === undefined || typeof f['valid_to'] === 'string');
    const quote = ok ? (f['quote'] as string) : '';
    if (!ok || !quote.trim() || !hay.includes(norm(quote))) { dropped++; continue; }
    kept.push({
      subject: f['subject'] as string, predicate: f['predicate'] as string, object: f['object'] as string,
      valid_from: (f['valid_from'] as string | null | undefined) || null, valid_to: (f['valid_to'] as string | null | undefined) || null,
      mentioned_at: f['mentioned_at'] as string, quote,
    });
  }
  return { kept, dropped };
}

/** One fact as the answering model sees it (memory_ab/answer.py). */
export function factLine(f: Pick<Fact, 'subject' | 'predicate' | 'object' | 'valid_from' | 'valid_to' | 'superseded_on' | 'mentioned_at' | 'quote'>): string {
  const end = f.valid_to ?? f.superseded_on;
  const state = end ? `superseded on ${end}` : 'current';
  return `- ${f.subject} | ${f.predicate} | ${f.object} (valid from ${f.valid_from || '?'}, ${state}; mentioned ${f.mentioned_at}; quote: "${f.quote.slice(0, 200)}")`;
}

/** An OpenAI-compatible chat endpoint used for extraction. */
export interface ChatModel {
  complete(prompt: string): Promise<string>;
}

export interface HttpChatOptions {
  /** Base URL, e.g. http://127.0.0.1:9090 */
  url: string;
  model: string;
  /** Sent as a bearer token (a cloud key; the CLI asks for consent before using one). */
  apiKey?: string;
  fetch?: typeof fetch;
}

/** Extraction through an OpenAI-compatible chat endpoint, with the JSON schema as structured output (as measured). */
export function httpChatModel({ url, model, apiKey, fetch: base }: HttpChatOptions): ChatModel {
  const u = new URL(url.endsWith('/') ? url : url + '/');
  const f = guardFetch('extract', sameOrigin(u), base ? { base } : {});
  const endpoint = new URL('v1/chat/completions', u);
  return {
    async complete(prompt) {
      const r = await f(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({
          model, messages: [{ role: 'user', content: prompt }], max_tokens: 6000, temperature: 0.1,
          chat_template_kwargs: { enable_thinking: false },
          response_format: { type: 'json_schema', json_schema: { name: 'facts', schema: FACTS_SCHEMA, strict: true } },
        }),
      });
      if (!r.ok) throw new Error(`chat endpoint answered ${r.status}`);
      const body = (await r.json()) as { choices?: { message?: { content?: string } }[] };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('chat endpoint returned no message');
      return content;
    },
  };
}

/** Extract facts for up to `limit` pending items. A failed item is recorded with its error and not retried. */
export async function extractPending(
  store: { pendingExtraction(limit: number): StoredItem[]; setFacts(item: string, facts: readonly FactInput[], at?: Date, error?: string | null): number[] },
  model: ChatModel, owner: string, opts: { limit?: number; now?: () => Date; onItem?: (id: string, kept: number, dropped: number, error?: string) => void } = {},
): Promise<{ items: number; facts: number; failed: number }> {
  const now = opts.now ?? (() => new Date());
  let items = 0, facts = 0, failed = 0;
  for (const it of store.pendingExtraction(opts.limit ?? 50)) {
    const text = itemText(it);
    try {
      const { kept, dropped } = checkFacts(await model.complete(extractionPrompt(owner) + text), text);
      store.setFacts(it.id, kept, now());
      items++; facts += kept.length;
      opts.onItem?.(it.id, kept.length, dropped);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      store.setFacts(it.id, [], now(), msg.slice(0, 300));
      failed++;
      opts.onItem?.(it.id, 0, 0, msg);
    }
  }
  return { items, facts, failed };
}
