// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// The readable export (pilot plan W1, Serge 23 Nov: an option, off by default). Plain Markdown that anyone with access
// to the folder can open without Synalla: one file per source and month, items oldest first. Secrets were already
// scrubbed at import. Turning it on means the provider, and anyone who gets into the account, can read it; the CLI
// says so before enabling it. `exportPlain` also serves `synalla-memory export --plain` to a local folder, so the
// owner is never locked in.

import type { Target } from './backup.ts';
import type { StoredItem } from './store.ts';

export const README = `# Your Synalla memory, readable copy

One Markdown file per source and month. This copy is NOT encrypted: anyone who can open this folder can read it.
It is rewritten on each export; the encrypted backup next to it is the one to restore from.
`;

const safe = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'other';

/** Group items into files: `<source>/<YYYY-MM>.md` (undated items go to `<source>/undated.md`). */
export function renderPlain(items: Iterable<StoredItem>): Map<string, string> {
  const files = new Map<string, string[]>();
  for (const it of items) {
    const month = /^\d{4}-\d{2}/.test(it.date) ? it.date.slice(0, 7) : 'undated';
    const name = `${safe(it.source)}/${month}.md`;
    const parts = files.get(name) ?? [`# ${it.source}, ${month}\n`];
    const title = (it.title || it.id).replace(/\s+/g, ' ').trim();
    parts.push(`## ${title}\n\n_${it.date || 'no date'} · ${it.id}_\n\n${it.text.trim()}\n`);
    files.set(name, parts);
  }
  return new Map([...files].map(([k, v]) => [k, v.join('\n')]));
}

/**
 * Write the readable copy under `synalla-memory/readable/` on `target`, and delete files from an earlier export
 * that no longer have content. Returns the file names written.
 */
/**
 * `reveal` puts kept values back in place of their stand-ins: only for a folder on the owner's own computer, asked for
 * explicitly (`export --plain <dir> --reveal`); never for a copy at a backup provider.
 */
export async function exportPlain(store: { items(): Iterable<StoredItem> }, target: Target, opts: { reveal?: (text: string) => string } = {}): Promise<string[]> {
  const root = 'synalla-memory/readable/';
  const files = renderPlain(store.items());
  if (opts.reveal) for (const [name, text] of files) files.set(name, opts.reveal(text));
  const written: string[] = [];
  await target.put(`${root}README.md`, Buffer.from(README, 'utf8'));
  for (const [name, text] of [...files].sort()) {
    await target.put(root + name, Buffer.from(text, 'utf8'));
    written.push(root + name);
  }
  // Files from the previous export that have no content now are deleted; the list of what was written is kept next
  // to them, so this works the same on every target.
  const index = `${root}files.json`;
  const prev = await target.get(index);
  let old: string[] = [];
  try { old = prev ? (JSON.parse(Buffer.from(prev).toString('utf8')) as string[]) : []; } catch { old = []; }
  const keep = new Set(written);
  for (const f of old) if (typeof f === 'string' && f.startsWith(root) && f.endsWith('.md') && !keep.has(f)) await target.delete(f);
  await target.put(index, Buffer.from(JSON.stringify(written), 'utf8'));
  return written;
}
