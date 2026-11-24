// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// Embeddings. The store and the MCP server only see the `Embedder` interface. This file gives the route through a
// local OpenAI-compatible endpoint (llama-server, llama-swap, Ollama, LM Studio); the in-process route
// (node-llama-cpp) implements the same interface. Questions get the instruction prefix the benchmark used
// (Qwen3-Embedding); stored passages get none.

export const QUERY_INSTRUCT = "Instruct: Given a question about a person's life, retrieve passages from their emails, notes and documents that answer it\nQuery: ";

export interface Embedder {
  readonly dim: number;
  /** One vector per text. `kind` 'query' adds the question instruction. */
  embed(texts: readonly string[], kind: 'query' | 'passage'): Promise<Float32Array[]>;
}

export interface HttpEmbedderOptions {
  /** Base URL, e.g. http://127.0.0.1:5941 */
  url: string;
  model?: string;
  dim: number;
  /** Texts per request. */
  batch?: number;
  fetch?: typeof fetch;
}

export function httpEmbedder({ url, model = 'embed', dim, batch = 32, fetch: f = fetch }: HttpEmbedderOptions): Embedder {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new TypeError('url must be http or https');
  if (!Number.isSafeInteger(dim) || dim < 1) throw new TypeError('dim must be a positive integer');
  const endpoint = new URL('v1/embeddings', u.href.endsWith('/') ? u.href : u.href + '/');
  return {
    dim,
    async embed(texts, kind) {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += batch) {
        const input = texts.slice(i, i + batch).map(t => (kind === 'query' ? QUERY_INSTRUCT + t : t));
        const r = await f(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input, model }) });
        if (!r.ok) throw new Error(`embedding endpoint answered ${r.status}`);
        const body = (await r.json()) as { data?: { index?: number; embedding?: unknown }[] };
        const data = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        if (data.length !== input.length) throw new Error(`embedding endpoint returned ${data.length} vectors for ${input.length} texts`);
        for (const d of data) {
          if (!Array.isArray(d.embedding) || d.embedding.length !== dim) throw new Error(`embedding endpoint returned a vector that is not ${dim} numbers`);
          out.push(Float32Array.from(d.embedding as number[]));
        }
      }
      return out;
    },
  };
}
