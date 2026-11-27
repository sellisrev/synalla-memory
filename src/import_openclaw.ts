// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// OpenClaw sessions to memory items (pilot plan W1). OpenClaw (2026.11) keeps each agent's sessions in SQLite at
// <state dir>/agents/<agentId>/agent/openclaw-agent.sqlite: `session_windows` (one row per history window) and
// `transcript_events` (each window's append-only event stream, as JSON or zstd-compressed JSON). A window moved to cold
// storage has no rows there; its events are in a zstd JSONL archive (`<agentId>/sessions/cold/<sha256>.jsonl.zst`, or
// the archive row's blob when `storage` is 'sqlite'), split in chunks from agent schema 37, whose lines are records
// {kind: 'header' | 'event' | ...}; an 'event' record holds {seq, event_json}. (OpenClaw docs: reference/database-schemas,
// reference/session-management-compaction; code: decodeSessionColdRecords, classifySessionEntry, resolveStateDir.)
//
// The transcript is a tree (`id`, `parentId`): a rewrite re-appends copies on a new branch, a rewind or version switch
// moves the active point with a `leaf` event, and compaction adds a summary without removing history. So the
// conversation is the path from the active leaf back to the root, and a `reset` event (/new, /reset, idle, daily) starts
// a new item on that path. Each item: user and assistant text in order. Left out: tool calls and results (so also
// Synalla's own tool outputs), thinking, extension events, dead branches, and sessions OpenClaw itself classes as not
// the owner's conversation: subagents (spawnedBy or ":subagent:"), dreaming narratives, cron and heartbeat runs, the
// Gateway's model-run checks, and windows fed by a mail or webhook hook. The database is opened read-only. The
// importer checks the columns it reads and throws OpenClawFormatChangedError naming the column if one is missing; a
// window that cannot be read is reported and retried on the next import, and the others are still read.

import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
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

const val = (s: string | undefined) => { const t = s?.trim(); return t && t !== 'undefined' && t !== 'null' ? t : undefined; };

/** OpenClaw's own rule (resolveStateDir): OPENCLAW_STATE_DIR (trimmed, ~ expanded), else <home>/.openclaw, or
 *  <home>/.openclaw-<profile> for OPENCLAW_PROFILE other than "default"; home is OPENCLAW_HOME, else HOME, else
 *  USERPROFILE, else the OS home. */
export function openclawStateDir(env: NodeJS.ProcessEnv = process.env, osHome: () => string = homedir): string {
  const raw = val(env['HOME']) ?? val(env['USERPROFILE']) ?? osHome();
  const tilde = (p: string) => p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? raw + p.slice(1) : p;
  const home = resolve(tilde(val(env['OPENCLAW_HOME']) ?? raw));
  const state = val(env['OPENCLAW_STATE_DIR']);
  if (state) return resolve(state.startsWith('~') ? home + state.slice(1) : state);
  const profile = val(env['OPENCLAW_PROFILE']);
  return join(home, profile && profile.toLowerCase() !== 'default' ? `.openclaw-${profile}` : '.openclaw');
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

interface Event {
  type?: string; id?: string; parentId?: string | null; targetId?: string | null; appendMode?: string; timestamp?: string;
  supersedesEntryId?: string; message?: { role?: string; content?: unknown };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.filter(p => p && (p as { type?: string }).type === 'text' && typeof (p as { text?: unknown }).text === 'string')
    .map(p => (p as { text: string }).text).join('\n').trim();
}

/** Skipped as OpenClaw's own corpus policy does: not the owner's conversation. */
export function isSideSession(key: string, w: { spawned_by?: string | null; hook?: string | null; entry?: string | null }): boolean {
  if (w.spawned_by || w.hook) return true;
  if (/(^|:)subagent:|(^|:)cron:|dreaming-narrative|:explicit:model-run-/i.test(key)) return true;
  if (w.entry) {
    try {
      const e = JSON.parse(w.entry) as { spawnedBy?: unknown; heartbeatIsolatedBaseSessionKey?: unknown };
      if (typeof e.spawnedBy === 'string' && e.spawnedBy.trim()) return true;
      if (typeof e.heartbeatIsolatedBaseSessionKey === 'string' && e.heartbeatIsolatedBaseSessionKey.trim()) return true;
    } catch { /* an unreadable entry is not a reason to skip */ }
  }
  return false;
}

function coldDir(dbPath: string): string {
  return basename(dirname(dbPath)) === 'agent' ? join(dirname(dirname(dbPath)), 'sessions', 'cold') : join(dirname(dbPath), 'cold');
}

/** The window's events in seq order: from its cold archive (chunks or one file, file or blob) and from SQLite. */
function windowEvents(db: Db, dbPath: string, sessionId: string, cold: { table: boolean; chunks: boolean }): Event[] {
  const out: { seq: number; e: Event }[] = [];
  if (cold.table) {
    const parent = db.prepare('SELECT archive_name, storage, archive_blob FROM session_transcript_cold_archives WHERE session_id = ?').get(sessionId) as
      { archive_name: string; storage: string | null; archive_blob: Buffer | null } | undefined;
    if (parent) {
      const chunks = cold.chunks ? db.prepare('SELECT archive_name, archive_blob FROM session_transcript_cold_archive_chunks WHERE session_id = ? ORDER BY chunk_index').all(sessionId) as
        { archive_name: string; archive_blob: Buffer | null }[] : [];
      for (const part of chunks.length ? chunks : [parent]) {
        const bytes = parent.storage === 'sqlite' ? part.archive_blob : readFileSync(join(coldDir(dbPath), part.archive_name));
        if (!bytes) throw new Error(`cold archive ${part.archive_name} has no stored copy`);
        const text = zstdDecompressSync(bytes, { maxOutputLength: 1 << 30 }).toString('utf8');
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          const r = JSON.parse(line) as { kind?: string; row?: { seq?: number; event_json?: string } };
          if (r.kind === 'event' && typeof r.row?.event_json === 'string') out.push({ seq: Number(r.row.seq), e: JSON.parse(r.row.event_json) as Event });
        }
      }
    }
  }
  for (const r of db.prepare('SELECT seq, event_json, event_zstd FROM transcript_events WHERE session_id = ? ORDER BY seq').all(sessionId) as
    { seq: number; event_json: string | null; event_zstd: Buffer | null }[]) {
    out.push({ seq: r.seq, e: JSON.parse(r.event_json ?? zstdDecompressSync(r.event_zstd as Buffer).toString('utf8')) as Event });
  }
  return out.sort((a, b) => a.seq - b.seq).map(x => x.e);
}

/** The conversation as the person sees it: the path from the active leaf to the root, split at each reset. Events with
 *  no tree links (transcripts from before the tree) are read in order, without the copies a rewrite replaced. */
export function activeSegments(events: Event[]): { resetId: string | null; events: Event[] }[] {
  const nodes = new Map<string, Event>();
  let leaf: string | null = null, side = false, linked = false;
  for (const e of events) {
    if (e.type === 'leaf') { // moves the active point; an entry appended to it continues from its target
      if (e.id) nodes.set(e.id, { type: 'leaf', id: e.id, parentId: e.targetId ?? null });
      leaf = e.targetId ?? null; side = e.appendMode === 'side';
      continue;
    }
    if (e.type === 'session' || !e.id) continue;
    nodes.set(e.id, e);
    if ('parentId' in e) linked = true;
    if (!side) leaf = e.id;
  }
  let path: Event[];
  if (linked) {
    path = [];
    const seen = new Set<string>();
    for (let id = leaf; id && nodes.has(id) && !seen.has(id); id = nodes.get(id)!.parentId ?? null) { seen.add(id); path.push(nodes.get(id)!); }
    path.reverse();
  } else {
    const replaced = new Set(events.map(e => e.supersedesEntryId).filter((x): x is string => typeof x === 'string'));
    path = events.filter(e => e.type !== 'session' && !(e.id && replaced.has(e.id)));
  }
  const segs: { resetId: string | null; events: Event[] }[] = [{ resetId: null, events: [] }];
  for (const e of path) {
    if (e.type === 'reset') segs.push({ resetId: e.id ?? String(segs.length), events: [] });
    else segs[segs.length - 1]!.events.push(e);
  }
  return segs;
}

/**
 * Read windows changed since `seen` (window id to a change mark) from one agent database. Returns their items, the
 * windows that could not be read, and updates `seen` for the windows read; the caller stores the items (replacing
 * earlier copies) and persists `seen`.
 */
export function readOpenClawDb(dbPath: string, agentId: string, seen: Map<string, string>): { items: OpenClawItem[]; failed: { window: string; error: string }[] } {
  if (!existsSync(dbPath)) return { items: [], failed: [] };
  const Database = require('better-sqlite3-multiple-ciphers') as new (p: string, o: object) => Db;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    const cols = (t: string) => new Set((db.pragma(`table_info(${t})`) as { name: string }[]).map(c => c.name));
    const wc = cols('session_windows'), ec = cols('transcript_events');
    for (const c of NEEDED.session_windows) if (!wc.has(c)) throw new OpenClawFormatChangedError(`session_windows.${c}`);
    for (const c of NEEDED.transcript_events) if (!ec.has(c)) throw new OpenClawFormatChangedError(`transcript_events.${c}`);
    const cold = { table: cols('session_transcript_cold_archives').has('archive_name'), chunks: cols('session_transcript_cold_archive_chunks').has('archive_name') };
    const nodes = cols('session_nodes').has('entry_json'), marks = cols('transcript_rewrite_watermarks').has('generation');
    const opt = (c: string, as = c) => wc.has(c) ? `w.${c} AS ${as}` : `NULL AS ${as}`;
    const windows = db.prepare(`SELECT w.session_id, w.session_key, w.created_at, ${opt('started_at')}, ${opt('display_name')},
        ${opt('spawned_by')}, ${opt('hook_external_content_source', 'hook')},
        ${nodes ? '(SELECT n.entry_json FROM session_nodes n WHERE n.session_key = w.session_key)' : 'NULL'} AS entry,
        ((SELECT count(*) || ':' || coalesce(max(seq), -1) FROM transcript_events t WHERE t.session_id = w.session_id)
          || ':' || coalesce(${wc.has('transcript_updated_at') ? 'w.transcript_updated_at' : 'NULL'}, '')
          || ':' || coalesce(${marks ? '(SELECT generation FROM transcript_rewrite_watermarks m WHERE m.session_id = w.session_id)' : 'NULL'}, '')
          || ':' || coalesce(${cold.table ? '(SELECT archive_sha256 FROM session_transcript_cold_archives a WHERE a.session_id = w.session_id)' : 'NULL'}, '')) AS mark
      FROM session_windows w ORDER BY w.created_at, w.session_id`).all() as
      { session_id: string; session_key: string; created_at: number; started_at: number | null; display_name: string | null;
        spawned_by: string | null; hook: string | null; entry: string | null; mark: string }[];
    const items: OpenClawItem[] = [], failed: { window: string; error: string }[] = [];
    for (const w of windows) {
      const key = `${agentId}:${w.session_id}`;
      if (seen.get(key) === w.mark) continue;
      if (isSideSession(w.session_key, w)) { seen.set(key, w.mark); continue; }
      try {
        const segs = activeSegments(windowEvents(db, dbPath, w.session_id, cold));
        const out: OpenClawItem[] = [];
        segs.forEach((s, n) => {
          const turns: string[] = [];
          for (const e of s.events) {
            const role = e.type === 'message' ? e.message?.role : undefined;
            if (role !== 'user' && role !== 'assistant') continue;
            const text = textOf(e.message?.content);
            if (text) turns.push(`${role === 'user' ? 'User' : 'Assistant'}: ${text}`);
          }
          if (turns.length === 0) return;
          const firstUser = turns.find(t => t.startsWith('User: '))?.slice(6).split('\n')[0] ?? '';
          const firstAt = Date.parse(s.events.find(e => e.timestamp)?.timestamp ?? '');
          const ms = n === 0 ? (w.started_at ?? w.created_at) : firstAt;
          const date = Number.isFinite(ms) ? new Date(ms).toISOString() : '';
          const title = ((n === 0 && w.display_name) || firstUser).slice(0, 150);
          const item = { id: `${SOURCE}:${key}${s.resetId ? ':' + s.resetId : ''}`, date, source: SOURCE, title, text: turns.join('\n\n') };
          out.push({ ...item, chunks: itemChunks(item), mark: w.mark });
        });
        items.push(...out);
        seen.set(key, w.mark);
      } catch (e) { failed.push({ window: w.session_id, error: (e as Error).message }); } // not marked: retried next time
    }
    return { items, failed };
  } finally { db.close(); }
}

/** All agents under the state directory; a failing agent database or window is reported and the others are still read. */
export function readOpenClaw(stateDir: string, seen: Map<string, string>): { items: OpenClawItem[]; failed: { agent: string; error: string }[] } {
  const items: OpenClawItem[] = [], failed: { agent: string; error: string }[] = [];
  for (const [agent, p] of openclawAgentDbs(stateDir)) {
    try {
      const r = readOpenClawDb(p, agent, seen);
      items.push(...r.items);
      for (const f of r.failed) failed.push({ agent, error: `window ${f.window}: ${f.error}` });
    } catch (e) { failed.push({ agent, error: (e as Error).message }); }
  }
  return { items, failed };
}
