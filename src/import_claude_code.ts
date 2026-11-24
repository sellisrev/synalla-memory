// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// Claude Code sessions (`~/.claude/projects/<project>/<session>.jsonl`) to memory items (pilot plan W1).
//
// One item per session: what the person wrote and what the assistant answered, in order. Left out:
//   - tool calls and tool results (file dumps, command output; this also drops every result of Synalla's own tools,
//     so the memory never re-ingests recall results or other members' entries), thinking, images;
//   - subagent turns (isSidechain), meta and replayed records (isMeta, isCompactSummary, isVisibleInTranscriptOnly);
//   - machine-written wrappers inside user text (system reminders, task notifications, slash-command echoes).
// The importer checks the fields it reads, not a version string. If a user or assistant record lacks them it throws
// a FormatChangedError naming the field, so a format change fails loudly; the caller keeps what was imported before.
// Secrets are scrubbed by the store on write.

import { itemChunks } from './chunk.ts';

export const SOURCE = 'claude-code';

export class FormatChangedError extends Error {
  readonly field: string;
  readonly line: number;
  constructor(field: string, line: number) {
    super(`Claude Code transcript format changed: line ${line} has no usable "${field}"`);
    this.name = 'FormatChangedError';
    this.field = field;
    this.line = line;
  }
}

const WRAPPERS = ['system-reminder', 'task-notification', 'local-command-caveat', 'local-command-stdout',
  'local-command-stderr', 'command-name', 'command-message', 'command-args', 'persisted-output'];
const WRAPPER_RE = new RegExp(`<(${WRAPPERS.join('|')})\\b[^>]*>[\\s\\S]*?</\\1>`, 'g');

export function cleanUserText(text: string): string {
  return text.replace(WRAPPER_RE, '').replace(/^\[Image[^\]\n]*\]\s*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

export interface SessionItem { id: string; date: string; source: string; title: string; text: string; turns: number }

interface Rec { type?: unknown; message?: unknown; timestamp?: unknown; sessionId?: unknown; aiTitle?: unknown;
  isSidechain?: unknown; isMeta?: unknown; isCompactSummary?: unknown; isVisibleInTranscriptOnly?: unknown; toolUseResult?: unknown }

function textOf(content: unknown, line: number): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) throw new FormatChangedError('message.content', line);
  const out: string[] = [];
  for (const p of content) {
    if (!p || typeof p !== 'object' || typeof (p as { type?: unknown }).type !== 'string') throw new FormatChangedError('message.content[].type', line);
    const part = p as { type: string; text?: unknown };
    if (part.type !== 'text') continue;
    if (typeof part.text !== 'string') throw new FormatChangedError('message.content[].text', line);
    out.push(part.text);
  }
  return out;
}

/** Parse one session file's text. Returns null if it holds no conversation worth keeping. */
export function parseSession(jsonl: string): SessionItem | null {
  if (typeof jsonl !== 'string') throw new TypeError('jsonl must be a string');
  const turns: string[] = [];
  let sessionId = '', date = '', aiTitle = '', firstUser = '';
  jsonl.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    if (!raw.trim()) return;
    let r: Rec;
    try { r = JSON.parse(raw) as Rec; } catch { return; } // a torn last line while Claude Code is writing
    if (!r || typeof r !== 'object') return;
    if (r.type === 'ai-title' && typeof r.aiTitle === 'string') { aiTitle = r.aiTitle; return; }
    if (r.type !== 'user' && r.type !== 'assistant') return;
    if (typeof r.sessionId !== 'string' || r.sessionId === '') throw new FormatChangedError('sessionId', line);
    if (typeof r.timestamp !== 'string' || Number.isNaN(Date.parse(r.timestamp))) throw new FormatChangedError('timestamp', line);
    const msg = r.message as { content?: unknown } | undefined;
    if (!msg || typeof msg !== 'object') throw new FormatChangedError('message', line);
    sessionId ||= r.sessionId;
    if (r.isSidechain === true || r.isMeta === true || r.isCompactSummary === true || r.isVisibleInTranscriptOnly === true
      || r.toolUseResult !== undefined) return;
    const parts = textOf(msg.content, line);
    const text = (r.type === 'user' ? parts.map(cleanUserText) : parts.map(s => s.trim())).filter(Boolean).join('\n\n');
    if (!text) return;
    date ||= r.timestamp;
    if (r.type === 'user' && !firstUser) firstUser = text;
    turns.push(`${r.type === 'user' ? 'User' : 'Assistant'}: ${text}`);
  });
  if (turns.length === 0) return null;
  const title = (aiTitle || firstUser.split('\n')[0] || '').slice(0, 150);
  return { id: `${SOURCE}:${sessionId}`, date, source: SOURCE, title, text: turns.join('\n\n'), turns: turns.length };
}

/** The item as the store takes it: header-prefixed chunks. */
export function toStoreItem(s: SessionItem): { id: string; date: string; source: string; title: string; chunks: string[] } {
  return { id: s.id, date: s.date, source: s.source, title: s.title, chunks: itemChunks(s) };
}

export interface ImportResult { imported: string[]; skipped: number; failed: { file: string; error: string }[] }

/**
 * Import every session file under `projectsDir` (default `~/.claude/projects`) changed since `seen` (path to mtime
 * in ms), replacing the earlier copy of a session. Updates `seen` for the files that imported. A file whose format
 * changed is reported in `failed` and keeps its earlier copy.
 */
export async function importClaudeCode(
  store: { addItem(i: { id: string; date: string; source: string; title: string; chunks: string[] }): number[] },
  seen: Map<string, number>,
  projectsDir?: string,
): Promise<ImportResult> {
  const { readdir, readFile, stat } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { homedir } = await import('node:os');
  const root = projectsDir ?? join(homedir(), '.claude', 'projects');
  const res: ImportResult = { imported: [], skipped: 0, failed: [] };
  let projects: string[];
  try { projects = await readdir(root); } catch { return res; }
  for (const p of projects.sort()) {
    let files: string[];
    try { files = (await readdir(join(root, p))).filter(f => f.endsWith('.jsonl')).sort(); } catch { continue; }
    for (const f of files) {
      const path = join(root, p, f);
      const mtime = (await stat(path)).mtimeMs;
      if (seen.get(path) === mtime) { res.skipped++; continue; }
      try {
        const s = parseSession(await readFile(path, 'utf8'));
        if (s) { store.addItem(toStoreItem(s)); res.imported.push(s.id); }
        seen.set(path, mtime);
      } catch (e) {
        res.failed.push({ file: path, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return res;
}
