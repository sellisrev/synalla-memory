// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// The local reveal page (the owner's design, 27 Nov 2026). An agent in the cloud only ever sees stand-ins like
// ⟦IBAN 2⟧. When the owner needs the real values, the agent hands its answer to the memory server (`show_to_owner`)
// and gives the owner a link. The link points to this machine (127.0.0.1) and holds only a random code; the page puts
// the values back when it is opened, in the owner's browser, so they never pass through the agent's session, its logs
// or its provider.
// Hardening: loopback only, the Host header must be this address (no DNS rebinding), GET only, 128-bit codes that
// expire after an hour, no caching, no scripts, no outside resources, no referrer, no framing.

import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';

export interface RevealPage {
  /** A link that shows `text` with its stand-ins replaced, valid for an hour. */
  publish(text: string, title?: string): Promise<string>;
  close(): void;
}

const TTL_MS = 60 * 60 * 1000;
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>
:root{--bg:#fbfaf7;--fg:#1d1c1a;--muted:#6b6862;--mark:#fff1c2;--line:#e5e1d8}
@media (prefers-color-scheme:dark){:root{--bg:#191917;--fg:#ecebe6;--muted:#a19e96;--mark:#4a3f12;--line:#33322e}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px}
h1{font-size:18px;margin:0 0 4px}p.note{color:var(--muted);font-size:14px;margin:0 0 24px}
pre{white-space:pre-wrap;word-wrap:break-word;font:inherit;border-top:1px solid var(--line);padding-top:16px}
mark{background:var(--mark);color:inherit;border-radius:3px;padding:0 2px}
</style></head><body><main>${body}</main></body></html>`;
}

/**
 * Start the page on a free loopback port. `reveal` turns stand-ins into values (store.reveal) and is called only when
 * the page is opened; `standIns` lists the stand-ins in a text, to highlight them.
 */
export async function startRevealPage(reveal: (text: string) => string, opts: { now?: () => number } = {}): Promise<RevealPage> {
  const now = opts.now ?? Date.now;
  const pages = new Map<string, { text: string; title: string; until: number }>();
  let host = '';
  const server: Server = createServer((req, res) => {
    const head = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" };
    const code = /^\/r\/([0-9a-f]{32})$/.exec(req.url ?? '')?.[1];
    const p = code ? pages.get(code) : undefined;
    if (req.headers.host !== host || req.method !== 'GET' || !p || p.until < now()) {
      if (p && p.until < now() && code) pages.delete(code);
      res.writeHead(404, { ...head, 'content-type': 'text/plain; charset=utf-8' }).end('Not found, or the link has expired. Ask your agent for a new one.');
      return;
    }
    // Values are put back here, in this response only; highlight each one so the owner sees what was hidden.
    const marked = p.text.split(/(⟦[^⟦⟧\n]{1,40}? \d{1,6}⟧)/).map((part, i) => {
      if (i % 2 === 0) return esc(part);
      const v = reveal(part);
      return v === part ? esc(part) : `<mark title="${esc(part)}">${esc(v)}</mark>`;
    }).join('');
    res.writeHead(200, { ...head, 'content-type': 'text/html; charset=utf-8' }).end(page(p.title,
      `<h1>${esc(p.title)}</h1><p class="note">Shown only on this computer: the highlighted values come from your memory and were never sent to the agent.</p><pre>${marked}</pre>`));
  });
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', () => ok()); });
  host = `127.0.0.1:${(server.address() as { port: number }).port}`;
  server.unref();
  return {
    async publish(text, title = 'From your memory') {
      for (const [k, v] of pages) if (v.until < now()) pages.delete(k);
      const code = randomBytes(16).toString('hex');
      pages.set(code, { text, title, until: now() + TTL_MS });
      return `http://${host}/r/${code}`;
    },
    close() { server.close(); pages.clear(); },
  };
}
