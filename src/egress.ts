// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// The outgoing check (pilot plan W1, measured in W8): every network call the package makes goes through one guarded
// fetch, and each kind of call may reach only the hosts it needs.
//   - model-download: the pinned release and model URLs, following redirects only to GitHub's and Hugging Face's own
//     hosts, each hop checked;
//   - embed / extract: only the endpoint the owner configured (by default the local sidecar or a local server);
//   - backup: only the owner's backup place.
// No other call follows a redirect. Every call is counted by kind and host, so a test or the status command can show
// exactly where the package sent anything. A test fails the build if source code calls fetch outside this file.

export type EgressKind = 'model-download' | 'embed' | 'extract' | 'check' | 'backup';
export type Allow = (url: URL) => boolean;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
export const isLoopback = (u: URL): boolean => LOOPBACK.has(u.hostname);

/** Allow only this URL's host (and port), with its scheme. */
export function sameOrigin(url: string | URL): Allow {
  const o = new URL(url);
  return u => u.protocol === o.protocol && u.host === o.host;
}

/** Allow https hosts equal to, or under, one of these domains. */
export function domains(...ds: string[]): Allow {
  return u => u.protocol === 'https:' && ds.some(d => u.hostname === d || u.hostname.endsWith('.' + d));
}

/** Pinned model files and their download redirects. */
export const MODEL_HOSTS = domains('github.com', 'githubusercontent.com', 'huggingface.co', 'hf.co');

const log = new Map<string, number>();
/** Calls made so far, as "kind host" -> count. */
export function egressLog(): Record<string, number> { return Object.fromEntries([...log].sort()); }
export function resetEgressLog(): void { log.clear(); }

export class EgressRefused extends Error {
  readonly kind: EgressKind;
  readonly url: string;
  constructor(kind: EgressKind, url: string) {
    super(`outgoing check: a ${kind} call may not reach ${new URL(url).host}`);
    this.name = 'EgressRefused';
    this.kind = kind;
    this.url = url;
  }
}

/**
 * A fetch that only reaches allowed URLs. With `followRedirects` (model downloads only), up to 5 redirects are
 * followed by hand and each target is checked; otherwise a redirect is returned to the caller, never followed.
 */
export function guardFetch(kind: EgressKind, allow: Allow, opts: { followRedirects?: boolean; base?: typeof fetch } = {}): typeof fetch {
  const base = opts.base ?? globalThis.fetch;
  const guarded = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    for (let hop = 0; ; hop++) {
      if (!allow(url)) throw new EgressRefused(kind, url.href);
      log.set(`${kind} ${url.host}`, (log.get(`${kind} ${url.host}`) ?? 0) + 1);
      const r = await base(url, { ...init, redirect: 'manual' });
      const loc = r.headers?.get?.('location');
      if (!opts.followRedirects || r.status < 300 || r.status > 399 || !loc) return r;
      if (hop >= 5) throw new Error('too many redirects');
      url = new URL(loc, url);
    }
  };
  return guarded as typeof fetch;
}
