// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// OpenClaw sessions to memory items (pilot plan W1). OpenClaw (2026.11) keeps each agent's sessions in SQLite at
// <OPENCLAW_STATE_DIR or ~/.openclaw>/agents/<agentId>/agent/openclaw-agent.sqlite: `session_windows` (one row per
// history window of a conversation) and `transcript_events` (the append-only event stream per window, each event as
// JSON or zstd-compressed JSON). Windows moved to cold storage keep their events in `<agentId>/sessions/cold/*.jsonl.zst`
// (or in the archive row's blob), listed in `session_transcript_cold_archives` and its `_chunks` table.
// (docs: reference/database-schemas/layout, reference/session-management-compaction/schema and maintenance.)
//
// The database is opened read-only; the Gateway is its only writer. One item per window: user and assistant text in
// order. Left out: tool calls and tool results (so also Synalla's own tool outputs), thinking, extension events
// (custom, custom_message), a message a rewrite replaced (the newer copy names it in `supersedesEntryId`), subagent
// windows (parent_session_key or spawned_by set), the Gateway's model-run checks, and windows fed by a mail or webhook
// hook (external content, not the owner's conversation). The importer checks the columns it reads and throws
// OpenClawFormatChangedError naming the column if one is missing.

import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { itemChunks } from './chunk.ts';

const require = createRequire(import.meta.url);

export const SOURCE = 'openclaw';

export class OpenClawFormatChangedError extends Error {
  readonly column: string;
  constructor(column: string) {
    super(`OpenClaw agent database format changed: no column ${column}`);
    this.name = 'OpenClawFormatChangedError';
    this.column = column;
  }
}

interface Db {
  prepare(s: string): { all(...a: unknown[]): unknown[]; get(...a: unknown[]): unknown };
  pragma(s: string): unknown;
  close(): void;
}

export function openclawStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env['OPENCLAW_STATE_DIR'] || join(homedir(), '.openclaw');
}

/** Every agent's database under the state directory, as [agentId, path]. */
export function openclawAgentDbs(stateDir: string): [string, string][] {
  const agents = join(stateDir, 'agents');
  if (!existsSync(agents)) return [];
  return readdirSync(agents, { withFileTypes: true }).filter(d => d.isDirectory())
    .map(d => [d.name, join(agents, d.name, 'agent', 'openclaw-agent.sqlite')] as [string, string])
    .filter(([, p]) => existsSync(p)).sort();
}

const NEEDED = {
  session_windows: ['session_id', 'session_key', 'created_at'],
  transcript_events: ['session_id', 'seq', 'event_json', 'event_zstd'],
};

export interface OpenClawItem { id: string; date: string; source: string; title: string; text: string; chunks: string[]; mark: string }

interface Event { type?: string; id?: string; supersedesEntryId?: string; message?: { role?: string; content?: unknown } }

function decode(json: string | null, zstd: Buffer | null): Event | null {
  try { return JSON.parse(json ?? zstdDecompressSync(zstd as Buffer).toString('utf8')) as Event; } catch { return null; }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.filter(p => p && (p as { type?: string }).type === 'text' && typeof (p as { text?: unknown }).text === 'string')
    .map(p => (p as { text: string }).text).join('\n').trim();
}

/** The window's events, oldest first: cold archives (file or blob) then the rows still in SQLite. */
function windowEvents(db: Db, dbPath: string, sessionId: string, hasCold: boolean): Event[] {
  const out: { seq: number; e: Event }[] = [];
  if (hasCold) {
    const coldDir = dirname(dbPath).endsWith('agent') ? join(dirname(dirname(dbPath)), 'sessions', 'cold') : join(dirname(dbPath), 'cold');
    const parts = [
      ...db.prepare('SELECT archive_name, archive_blob FROM session_transcript_cold_archive_chunks WHERE session_id = ? ORDER BY chunk_index').all(sessionId),
    ] as { archive_name: string; archive_blob: Buffer | null }[];
    if (parts.length === 0) parts.push(...db.prepare('SELECT archive_name, archive_blob FROM session_transcript_cold_archives WHERE session_id = ? ORDER BY generation').all(sessionId) as typeof parts);
    for (const p of parts) {
      const raw = p.archive_blob ?? readFileSync(join(coldDir, p.archive_name));
      const text = p.archive_name.endsWith('.zst') || (raw[0] === 0x28 && raw[1] === 0xb5) ? zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { out.push({ seq: -1, e: JSON.parse(line) as Event }); } catch { /* a torn line is skipped */ }
      }
    }
  }
  for (const r of db.prepare('SELECT seq, event_json, event_zstd FROM transcript_events WHERE session_id = ? ORDER BY seq').all(sessionId) as
    { seq: number; event_json: string | null; event_zstd: Buffer | null }[]) {
    const e = decode(r.event_json, r.event_zstd);
    if (e) out.push({ seq: r.seq, e });
  }
  return out.map(x => x.e);
}

/**
 * Read windows changed since `seen` (window id to a change mark) from one agent database. Returns their items and
 * updates `seen`; the caller stores the items (replacing earlier copies) and persists `seen`.
 */
export function readOpenClawDb(dbPath: string, agentId: string, seen: Map<string, string>): OpenClawItem[] {
  if (!existsSync(dbPath)) return [];
  const Database = require('better-sqlite3-multiple-ciphers') as new (p: string, o: object) => Db;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    const cols = (t: string) => new Set((db.pragma(`table_info(${t})`) as { name: string }[]).map(c => c.name));
    const wc = cols('session_windows'), ec = cols('transcript_events');
    for (const c of NEEDED.session_windows) if (!wc.has(c)) throw new OpenClawFormatChangedError(`session_windows.${c}`);
    for (const c of NEEDED.transcript_events) if (!ec.has(c)) throw new OpenClawFormatChangedError(`transcript_events.${c}`);
    const hasCold = cols('session_transcript_cold_archives').has('archive_name');
    const opt = (c: string, as = c) => wc.has(c) ? `w.${c} AS ${as}` : `NULL AS ${as}`;
    const coldMark = hasCold ? `|| ':' || coalesce((SELECT group_concat(archive_sha256) FROM session_transcript_cold_archives a WHERE a.session_id = w.session_id), '')` : '';
    const windows = db.prepare(`SELECT w.session_id, w.session_key, w.created_at, ${opt('started_at')}, ${opt('display_name')},
        ${opt('parent_session_key')}, ${opt('spawned_by')}, ${opt('hook_external_content_source', 'hook')},
        ((SELECT count(*) || ':' || coalesce(max(seq), -1) FROM transcript_events t WHERE t.session_id = w.session_id) ${coldMark}) AS mark
      FROM session_windows w ORDER BY w.created_at, w.session_id`).all() as
      { session_id: string; session_key: string; created_at: number; started_at: number | null; display_name: string | null;
        parent_session_key: string | null; spawned_by: string | null; hook: string | null; mark: string }[];
    const out: OpenClawItem[] = [], marks = new Map<string, string>();
    for (const w of windows) {
      const key = `${agentId}:${w.session_id}`;
      if (seen.get(key) === w.mark) continue;
      marks.set(key, w.mark);
      if (w.parent_session_key || w.spawned_by || w.hook || /:subagent:|:explicit:model-run-/.test(w.session_key)) continue;
      const events = windowEvents(db, dbPath, w.session_id, hasCold);
      const replaced = new Set(events.map(e => e.supersedesEntryId).filter((x): x is string => typeof x === 'string'));
      const turns: string[] = [];
      for (const e of events) {
        if (e.type !== 'message' || (e.id && replaced.has(e.id))) continue;
        const role = e.message?.role;
        if (role !== 'user' && role !== 'assistant') continue;
        const text = textOf(e.message?.content);
        if (text) turns.push(`${role === 'user' ? 'User' : 'Assistant'}: ${text}`);
      }
      if (turns.length === 0) continue;
      const firstUser = turns.find(t => t.startsWith('User: '))?.slice(6).split('\n')[0] ?? '';
      const ms = w.started_at ?? w.created_at;
      const date = Number.isFinite(ms) ? new Date(ms).toISOString() : '';
      const item = { id: `${SOURCE}:${key}`, date, source: SOURCE, title: (w.display_name || firstUser).slice(0, 150), text: turns.join('\n\n') };
      out.push({ ...item, chunks: itemChunks(item), mark: w.mark });
    }
    for (const [k, m] of marks) seen.set(k, m); // only once the whole database was read, so a failure retries next run
    return out;
  } finally { db.close(); }
}

/** All agents under the state directory; a failing agent database is reported and the others are still read. */
export function readOpenClaw(stateDir: string, seen: Map<string, string>): { items: OpenClawItem[]; failed: { agent: string; error: string }[] } {
  const items: OpenClawItem[] = [], failed: { agent: string; error: string }[] = [];
  for (const [agent, p] of openclawAgentDbs(stateDir)) {
    try { items.push(...readOpenClawDb(p, agent, seen)); } catch (e) { failed.push({ agent, error: (e as Error).message }); }
  }
  return { items, failed };
}
