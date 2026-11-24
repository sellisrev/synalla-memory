// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// Retrieval fusion for recall, as measured in the 23-24 Nov CPU spike (pilot plan W1): keyword (BM25) and vector
// results are merged by reciprocal rank fusion, and the top 25 passages go to the answering model, with no reranker.
// Pure: no I/O; the store runs the two searches and passes their ranked ids in.

export const RRF_K = 60;
export const DEFAULT_TOP = 25;
export const CANDIDATES = 50;

const STOP = new Set(('the and for are was were what when where which who whom whose why how does did has have had with this that from into '
  + 'about than then there their they them his her she him you your our not but can could would should will shall may might its it\'s '
  + 'est les des une que qui dans pour par sur avec mais plus').split(' '));

/** FTS5 query for a question: words of 3+ letters, stop words dropped, at most 20, OR-ed and quoted. */
export function ftsQuery(question: string): string {
  if (typeof question !== 'string') throw new TypeError('question must be a string');
  const words = (question.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []).filter(w => !STOP.has(w));
  const unique = [...new Set(words)].slice(0, 20);
  return unique.length > 0 ? unique.map(w => `"${w.replace(/"/g, '')}"`).join(' OR ') : '"the"';
}

/**
 * Reciprocal rank fusion: each list adds 1 / (k + rank) to an id (rank from 0). Returns ids by fused score,
 * highest first; ties keep the order in which ids were first seen (keyword list first). Lists may hold duplicates;
 * only an id's first position in a list counts.
 */
export function fuse(lists: readonly (readonly number[])[], top = DEFAULT_TOP, k = RRF_K): number[] {
  if (!Array.isArray(lists)) throw new TypeError('lists must be an array');
  if (!Number.isSafeInteger(top) || top < 1) throw new TypeError('top must be a positive integer');
  if (typeof k !== 'number' || !(k >= 0)) throw new TypeError('k must be a non-negative number');
  const score = new Map<number, number>();
  for (const list of lists) {
    if (!Array.isArray(list)) throw new TypeError('each list must be an array');
    const seen = new Set<number>();
    list.forEach((id, rank) => {
      if (!Number.isSafeInteger(id)) throw new TypeError('ids must be integers');
      if (seen.has(id)) return;
      seen.add(id);
      score.set(id, (score.get(id) ?? 0) + 1 / (k + rank));
    });
  }
  const order = [...score.keys()];
  return order.map((id, i) => ({ id, s: score.get(id) as number, i }))
    .sort((a, b) => b.s - a.s || a.i - b.i).slice(0, top).map(x => x.id);
}
