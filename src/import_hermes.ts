// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// Hermes Agent sessions (Nous Research) to memory items (pilot plan W1). Hermes keeps every session in SQLite at
// <HERMES_HOME>/state.db (default ~/.hermes, on Windows %LOCALAPPDATA%/hermes), tables `sessions` and `messages`
// (schema per hermes-agent.nousresearch.com/docs/developer-guide/session-storage, schema version 31).
//
// The database is opened read-only; Hermes' gateway is its only writer. One item per session: user and assistant
// text in order. Left out: tool calls and tool results (so also Synalla's own tool outputs), reasoning, archived rows
// of compacted sessions (`active = 0`; the live rows hold the retained context), and subagent sessions. The importer
// checks the columns it reads and throws FormatChangedError naming the column if one is missing.

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { itemChunks } from './chunk.ts';

const require = createRequire(import.meta.url);

export const SOURCE = 'hermes';

export class HermesFormatChangedError extends Error {
  readonly column: string;
  constructor(column: string) {
    super(`Hermes state.db format changed: no column ${column}`);
    this.name = 'HermesFormatChangedError';
    this.column = column;
  }
}

interface Db {
  prepare(s: string): { all(...a: unknown[]): unknown[]; get(...a: unknown[]): unknown };
  pragma(s: string): unknown;
  close(): void;
}

export function hermesDbPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env['HERMES_HOME']) return join(env['HERMES_HOME'], 'state.db');
  if (platform === 'win32') return join(env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), 'hermes', 'state.db');
  return join(homedir(), '.hermes', 'state.db');
}

const NEEDED = {
  sessions: ['id', 'source', 'started_at', 'title'],
  messages: ['id', 'session_id', 'role', 'content', 'timestamp'],
};

export interface HermesItem { id: string; date: string; source: string; title: string; text: string; chunks: string[]; mark: string }

/**
 * Read sessions changed since `seen` (session id to a change mark). Returns their items and updates `seen`; the caller
 * stores the items (replacing earlier copies) and persists `seen`.
 */
export function readHermes(dbPath: string, seen: Map<string, string>): HermesItem[] {
  if (!existsSync(dbPath)) return [];
  const Database = require('better-sqlite3-multiple-ciphers') as new (p: string, o: object) => Db;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    const cols = (t: string) => new Set((db.pragma(`table_info(${t})`) as { name: string }[]).map(c => c.name));
    const sc = cols('sessions'), mc = cols('messages');
    for (const c of NEEDED.sessions) if (!sc.has(c)) throw new HermesFormatChangedError(`sessions.${c}`);
    for (const c of NEEDED.messages) if (!mc.has(c)) throw new HermesFormatChangedError(`messages.${c}`);
    const live = mc.has('active') ? 'AND (m.active IS NULL OR m.active = 1)' : '';
    const noToolResult = mc.has('tool_call_id') ? 'AND m.tool_call_id IS NULL' : '';
    const sessions = db.prepare(`SELECT s.id, s.source, s.started_at, s.title,
        (SELECT count(*) || ':' || coalesce(max(m.id), 0) FROM messages m WHERE m.session_id = s.id) AS mark
      FROM sessions s WHERE s.source != 'subagent' ORDER BY s.started_at`).all() as
      { id: string; source: string; started_at: number; title: string | null; mark: string }[];
    const msgs = db.prepare(`SELECT m.role, m.content FROM messages m WHERE m.session_id = ?
      AND m.role IN ('user', 'assistant') ${live} ${noToolResult} ORDER BY m.timestamp, m.id`);
    const out: HermesItem[] = [];
    for (const s of sessions) {
      if (seen.get(s.id) === s.mark) continue;
      const turns = (msgs.all(s.id) as { role: string; content: string | null }[])
        .map(m => ({ role: m.role, text: (m.content ?? '').trim() })).filter(m => m.text)
        .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`);
      seen.set(s.id, s.mark);
      if (turns.length === 0) continue;
      const firstUser = turns.find(t => t.startsWith('User: '))?.slice(6).split('\n')[0] ?? '';
      const date = Number.isFinite(s.started_at) ? new Date(s.started_at * 1000).toISOString() : '';
      const item = { id: `${SOURCE}:${s.id}`, date, source: `${SOURCE}`, title: (s.title || firstUser).slice(0, 150), text: turns.join('\n\n') };
      out.push({ ...item, chunks: itemChunks(item), mark: s.mark });
    }
    return out;
  } finally { db.close(); }
}
