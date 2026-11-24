// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// The encrypted memory store (pilot plan W1). One SQLite file, encrypted with SQLCipher (better-sqlite3-multiple-
// ciphers, cipher set explicitly), holding items, their chunks, an FTS5 index for keyword search (BM25) and one
// embedding vector per chunk (float32 in the file), and the facts extracted from items with their own keyword and
// vector index. Vector search is brute force over an int8 copy held in RAM (about 1 KB per vector at 1024 dimensions,
// so 200k chunks fit in about 200 MB), which is the measured CPU default's scale.
//
// Every text is scrubbed of secrets before it is written (scrub.ts), so the store, any extraction model and any
// backup never see them. The key is 32 random bytes held by the caller (the OS keychain in the CLI); a wrong key
// fails at open.

import { createRequire } from 'node:module';
import { scrub } from './scrub.ts';
import { ftsQuery, fuse, CANDIDATES, DEFAULT_TOP } from './fusion.ts';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3-multiple-ciphers') as new (path: string, opts?: object) => Db;

interface Stmt {
  run(...a: unknown[]): { lastInsertRowid: number | bigint; changes: number }; get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[];
  iterate(...a: unknown[]): Iterable<unknown>;
}
interface Db {
  pragma(s: string, o?: { simple?: boolean }): unknown;
  exec(s: string): void;
  prepare(s: string): Stmt;
  transaction<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R;
  close(): void;
}

export const SCHEMA_VERSION = 1;
/** Candidates taken from the int8 cache before exact rescoring. */
export const RESCORE = 200;

export interface Item {
  id: string; date: string; source: string; title?: string; chunks: readonly string[];
  /** The whole text, for the readable export (chunks overlap and carry headers). */
  text?: string;
}
export interface StoredItem { id: string; date: string; source: string; title: string; text: string }
export interface Chunk { cid: number; item: string; n: number; date: string; source: string; text: string }
/** A fact as the extraction model gives it (memory_ab/extract.py SCHEMA). */
export interface FactInput {
  subject: string; predicate: string; object: string;
  valid_from: string | null; valid_to: string | null; mentioned_at: string; quote: string;
}
export interface Fact {
  fid: number; item: string; subject: string; predicate: string; object: string; valid_from: string | null;
  /** The end date the record itself gave. */
  valid_to: string | null;
  /** Set when a later fact for the same subject and predicate has another value. */
  superseded_on: string | null;
  mentioned_at: string; quote: string;
}
export interface StoreOptions {
  /** 32-byte key. */
  key: Uint8Array;
  /** Embedding size (Qwen3-Embedding-0.6B: 1024). */
  dim: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY, date TEXT NOT NULL, source TEXT NOT NULL, title TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS chunks(cid INTEGER PRIMARY KEY, item TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  n INTEGER NOT NULL, date TEXT NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL, vec BLOB);
CREATE INDEX IF NOT EXISTS chunks_item ON chunks(item);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(text, content='chunks', content_rowid='cid',
  tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO fts(rowid, text) VALUES (new.cid, new.text); END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO fts(fts, rowid, text) VALUES ('delete', old.cid, old.text); END;
CREATE TABLE IF NOT EXISTS facts(fid INTEGER PRIMARY KEY, item TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL, valid_from TEXT, valid_to TEXT,
  superseded_on TEXT, mentioned_at TEXT NOT NULL, quote TEXT NOT NULL, item_date TEXT NOT NULL, gkey TEXT NOT NULL, vec BLOB);
CREATE INDEX IF NOT EXISTS facts_item ON facts(item);
CREATE INDEX IF NOT EXISTS facts_gkey ON facts(gkey);
CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(body, tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, body) VALUES (new.fid, new.subject || ' | ' || new.predicate || ' | ' || new.object || ' ' || new.quote); END;
CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
  DELETE FROM facts_fts WHERE rowid = old.fid; END;
CREATE TABLE IF NOT EXISTS extracted(item TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE, at TEXT NOT NULL,
  facts INTEGER NOT NULL, error TEXT);
`;

/** Normalise to unit length, then quantise to int8 (round(x * 127)). Dot products of these rank like cosine. */
export function quantize(v: Float32Array): Int8Array {
  let n = 0;
  for (const x of v) n += x * x;
  const s = n > 0 ? 127 / Math.sqrt(n) : 0;
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round((v[i] as number) * s)));
  return q;
}

const norm = (x: string) => x.replace(/\s+/g, ' ').trim().toLowerCase();
const f32 = (b: Buffer) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

/** int8 RAM cache over one table's float32 vectors, with exact rescoring from the file. */
class VectorIndex {
  #ids: number[] = [];
  #mat = new Int8Array(0);
  #pos = new Map<number, number>();
  private readonly db: Db;
  private readonly table: string;
  private readonly idCol: string;
  private readonly dim: number;
  constructor(db: Db, table: string, idCol: string, dim: number) { this.db = db; this.table = table; this.idCol = idCol; this.dim = dim; }

  get size(): number { return this.#ids.length; }

  load(): void {
    const rows = this.db.prepare(`SELECT ${this.idCol} AS id, vec FROM ${this.table} WHERE vec IS NOT NULL ORDER BY ${this.idCol}`).all() as { id: number; vec: Buffer }[];
    this.#ids = rows.map(r => r.id);
    this.#mat = new Int8Array(rows.length * this.dim);
    this.#pos = new Map();
    rows.forEach((r, i) => { this.#mat.set(quantize(f32(r.vec)), i * this.dim); this.#pos.set(r.id, i); });
  }

  drop(ids: Iterable<number>): void {
    const drop = new Set([...ids].filter(id => this.#pos.has(id)));
    if (drop.size === 0) return;
    const keep = this.#ids.map((id, i) => [id, i] as const).filter(([id]) => !drop.has(id));
    const mat = new Int8Array(keep.length * this.dim);
    keep.forEach(([, i], j) => mat.set(this.#mat.subarray(i * this.dim, (i + 1) * this.dim), j * this.dim));
    this.#ids = keep.map(([id]) => id);
    this.#mat = mat;
    this.#pos = new Map(this.#ids.map((id, j) => [id, j]));
  }

  set(vectors: readonly { id: number; vec: Float32Array }[], what: string): void {
    for (const { vec } of vectors) {
      if (!(vec instanceof Float32Array) || vec.length !== this.dim) throw new TypeError(`vectors must be Float32Array(${this.dim})`);
    }
    const upd = this.db.prepare(`UPDATE ${this.table} SET vec = ? WHERE ${this.idCol} = ?`);
    this.db.transaction(() => {
      for (const { id, vec } of vectors) {
        if (upd.run(Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), id).changes !== 1) throw new RangeError(`no ${what} ${id}`);
      }
    })();
    const add = [...new Set(vectors.map(v => v.id))].filter(id => !this.#pos.has(id));
    if (add.length > 0) {
      const mat = new Int8Array((this.#ids.length + add.length) * this.dim);
      mat.set(this.#mat);
      this.#mat = mat;
      for (const id of add) { this.#pos.set(id, this.#ids.length); this.#ids.push(id); }
    }
    for (const { id, vec } of vectors) this.#mat.set(quantize(vec), (this.#pos.get(id) as number) * this.dim);
  }

  search(query: Float32Array, k: number): number[] {
    if (!(query instanceof Float32Array) || query.length !== this.dim) throw new TypeError(`query must be Float32Array(${this.dim})`);
    const q = quantize(query), d = this.dim, n = this.#ids.length;
    const scores = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      const off = i * d;
      for (let j = 0; j < d; j++) s += (this.#mat[off + j] as number) * (q[j] as number);
      scores[i] = s;
    }
    const order = Array.from({ length: n }, (_, i) => i);
    order.sort((a, b) => (scores[b] as number) - (scores[a] as number) || (this.#ids[a] as number) - (this.#ids[b] as number));
    const cand = order.slice(0, Math.max(RESCORE, 4 * k)).map(i => this.#ids[i] as number);
    if (cand.length === 0) return [];
    const rows = this.db.prepare(`SELECT ${this.idCol} AS id, vec FROM ${this.table} WHERE ${this.idCol} IN (${cand.map(() => '?').join(',')})`).all(...cand) as { id: number; vec: Buffer }[];
    let qn = 0;
    for (const x of query) qn += x * x;
    qn = Math.sqrt(qn) || 1;
    const exact = rows.map(r => {
      const f = f32(r.vec);
      let dot = 0, nn = 0;
      for (let j = 0; j < d; j++) { dot += (f[j] as number) * (query[j] as number); nn += (f[j] as number) ** 2; }
      return { id: r.id, s: nn > 0 ? dot / (Math.sqrt(nn) * qn) : 0 };
    });
    exact.sort((a, b) => b.s - a.s || a.id - b.id);
    return exact.slice(0, k).map(x => x.id);
  }
}

export class MemoryStore {
  readonly dim: number;
  readonly path: string;
  #db: Db;
  #chunkVecs: VectorIndex;
  #factVecs: VectorIndex;

  private constructor(db: Db, dim: number, path: string) {
    this.#db = db; this.dim = dim; this.path = path;
    this.#chunkVecs = new VectorIndex(db, 'chunks', 'cid', dim);
    this.#factVecs = new VectorIndex(db, 'facts', 'fid', dim);
  }

  /** Open or create the store at `path` (':memory:' for tests). Throws if the key is wrong. */
  static open(path: string, { key, dim }: StoreOptions): MemoryStore {
    if (!(key instanceof Uint8Array) || key.length !== 32) throw new TypeError('key must be 32 bytes');
    if (!Number.isSafeInteger(dim) || dim < 1) throw new TypeError('dim must be a positive integer');
    const db = new Database(path);
    try {
      if (path !== ':memory:') { // an in-memory database never reaches disk, and SQLCipher refuses a key for it
        db.pragma(`cipher='sqlcipher'`);
        db.pragma('legacy=4');
        db.pragma(`key="x'${Buffer.from(key).toString('hex')}'"`);
      }
      db.prepare('SELECT count(*) FROM sqlite_master').get(); // fails here on a wrong key
      db.pragma('journal_mode=WAL');
      db.pragma('foreign_keys=ON');
      db.exec(SCHEMA);
      const row = db.prepare(`SELECT v FROM meta WHERE k='dim'`).get() as { v: string } | undefined;
      if (row && Number(row.v) !== dim) throw new RangeError(`store was built with dim ${row.v}, not ${dim}`);
      if (!row) {
        db.prepare(`INSERT INTO meta(k, v) VALUES ('dim', ?), ('schema', ?)`).run(String(dim), String(SCHEMA_VERSION));
      }
    } catch (e) {
      db.close();
      if (e instanceof Error && /not a database|file is (encrypted|not a database)/i.test(e.message)) {
        throw new Error('cannot open the memory store: wrong key or not a Synalla store', { cause: e });
      }
      throw e;
    }
    const store = new MemoryStore(db, dim, path);
    store.#chunkVecs.load();
    store.#factVecs.load();
    return store;
  }

  /** Add (or replace) an item with its chunks, scrubbed. Returns the new chunk ids, in order. */
  addItem(item: Item): number[] {
    if (!item || typeof item.id !== 'string' || item.id === '') throw new TypeError('item id must be a non-empty string');
    if (!Array.isArray(item.chunks) || item.chunks.some(c => typeof c !== 'string')) throw new TypeError('chunks must be strings');
    if (item.text !== undefined && typeof item.text !== 'string') throw new TypeError('text must be a string');
    const date = String(item.date ?? ''), source = String(item.source ?? '');
    const run = this.#db.transaction(() => {
      this.#removeItem(item.id);
      this.#db.prepare('INSERT INTO items(id, date, source, title, text) VALUES (?, ?, ?, ?, ?)')
        .run(item.id, date, source, scrub(item.title ?? '').text, scrub(item.text ?? '').text);
      const ins = this.#db.prepare('INSERT INTO chunks(item, n, date, source, text) VALUES (?, ?, ?, ?, ?)');
      return item.chunks.map((text, n) => Number(ins.run(item.id, n, date, source, scrub(text).text).lastInsertRowid));
    });
    return run();
  }

  #removeItem(id: string): number {
    const cids = (this.#db.prepare('SELECT cid FROM chunks WHERE item = ?').all(id) as { cid: number }[]).map(r => r.cid);
    const fids = this.#db.prepare('SELECT fid, gkey FROM facts WHERE item = ?').all(id) as { fid: number; gkey: string }[];
    this.#db.prepare('DELETE FROM chunks WHERE item = ?').run(id);
    this.#db.prepare('DELETE FROM facts WHERE item = ?').run(id);
    const n = this.#db.prepare('DELETE FROM items WHERE id = ?').run(id).changes;
    this.#chunkVecs.drop(cids);
    this.#factVecs.drop(fids.map(f => f.fid));
    this.#resupersede(new Set(fids.map(f => f.gkey)));
    return n;
  }

  /** Delete an item and its chunks. Returns whether it existed. */
  deleteItem(id: string): boolean {
    return this.#db.transaction(() => this.#removeItem(id))() > 0;
  }

  /** Store embeddings for chunks (float32 in the file, int8 in the RAM cache). */
  setVectors(vectors: readonly { cid: number; vec: Float32Array }[]): void {
    this.#chunkVecs.set(vectors.map(v => ({ id: v.cid, vec: v.vec })), 'chunk');
  }

  /** Chunk ids for the question by BM25, best first. */
  keywordSearch(question: string, k = CANDIDATES): number[] {
    const rows = this.#db.prepare('SELECT rowid FROM fts WHERE fts MATCH ? ORDER BY bm25(fts) LIMIT ?').all(ftsQuery(question), k) as { rowid: number }[];
    return rows.map(r => r.rowid);
  }

  /**
   * Chunk ids nearest to the query vector by cosine, best first; ties by lower id. The int8 cache picks
   * max(200, 4k) candidates, which are then rescored exactly from the float32 vectors in the file. On the private
   * index (18,736 chunks, 150 questions) this returned exactly the float32 top 50 every time; the int8 cache alone
   * kept 95.6% of it on average (82% at worst).
   */
  vectorSearch(query: Float32Array, k = CANDIDATES): number[] {
    return this.#chunkVecs.search(query, k);
  }

  /** The measured CPU default: keyword and vector candidates fused by reciprocal rank, top 25. */
  search(question: string, query: Float32Array, top = DEFAULT_TOP): number[] {
    return fuse([this.keywordSearch(question), this.vectorSearch(query)], top);
  }

  /** The chunks for these ids, in the order given; unknown ids are skipped. */
  chunks(cids: readonly number[]): Chunk[] {
    if (cids.length === 0) return [];
    const rows = this.#db.prepare(`SELECT cid, item, n, date, source, text FROM chunks WHERE cid IN (${cids.map(() => '?').join(',')})`).all(...cids) as Chunk[];
    const by = new Map(rows.map(r => [r.cid, r]));
    return cids.flatMap(c => (by.has(c) ? [by.get(c) as Chunk] : []));
  }

  /** Every item, oldest first (for the readable export). */
  *items(): Generator<StoredItem> {
    yield* this.#db.prepare('SELECT id, date, source, title, text FROM items ORDER BY date, id').iterate() as Iterable<StoredItem>;
  }

  /** Chunks that still need an embedding. */
  missingVectors(limit = 256): { cid: number; text: string }[] {
    return this.#db.prepare('SELECT cid, text FROM chunks WHERE vec IS NULL ORDER BY cid LIMIT ?').all(limit) as { cid: number; text: string }[];
  }

  stats(): { items: number; chunks: number; vectors: number; facts: number; factVectors: number } {
    const one = (sql: string) => (this.#db.prepare(sql).get() as { n: number }).n;
    return { items: one('SELECT count(*) n FROM items'), chunks: one('SELECT count(*) n FROM chunks'), vectors: this.#chunkVecs.size,
      facts: one('SELECT count(*) n FROM facts'), factVectors: this.#factVecs.size };
  }

  // ---- facts (pilot plan W1: the fact layer; measured as arm B in memory_ab) ----

  /**
   * Replace the facts of an item with these (already checked against the item's text by the extractor), scrubbed,
   * and record the item as extracted. Then recompute, for every subject and predicate touched, which facts a later
   * value superseded: sorted by (valid_from or mentioned_at or the item's date, mentioned_at), each fact whose value
   * differs from the next one's, and which has no end date of its own, ends where the next one starts.
   */
  setFacts(item: string, facts: readonly FactInput[], at: Date = new Date(), error: string | null = null): number[] {
    const it = this.#db.prepare('SELECT date FROM items WHERE id = ?').get(item) as { date: string } | undefined;
    if (!it) throw new RangeError(`no item ${item}`);
    for (const f of facts) {
      if (!f || typeof f.subject !== 'string' || typeof f.predicate !== 'string' || typeof f.object !== 'string'
        || typeof f.quote !== 'string' || typeof f.mentioned_at !== 'string'
        || (f.valid_from !== null && typeof f.valid_from !== 'string') || (f.valid_to !== null && typeof f.valid_to !== 'string')) {
        throw new TypeError('bad fact shape');
      }
    }
    return this.#db.transaction(() => {
      const old = this.#db.prepare('SELECT fid, gkey FROM facts WHERE item = ?').all(item) as { fid: number; gkey: string }[];
      this.#db.prepare('DELETE FROM facts WHERE item = ?').run(item);
      this.#factVecs.drop(old.map(o => o.fid));
      const ins = this.#db.prepare(`INSERT INTO facts(item, subject, predicate, object, valid_from, valid_to, mentioned_at, quote, item_date, gkey)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const keys = new Set(old.map(o => o.gkey));
      const fids = facts.map(f => {
        const subject = scrub(f.subject).text, predicate = scrub(f.predicate).text;
        const gkey = norm(subject) + '\u0000' + norm(predicate);
        keys.add(gkey);
        return Number(ins.run(item, subject, predicate, scrub(f.object).text, f.valid_from || null, f.valid_to || null,
          f.mentioned_at, scrub(f.quote).text, (it.date || '').slice(0, 10), gkey).lastInsertRowid);
      });
      this.#db.prepare('INSERT OR REPLACE INTO extracted(item, at, facts, error) VALUES (?, ?, ?, ?)').run(item, at.toISOString(), fids.length, error);
      this.#resupersede(keys);
      return fids;
    })();
  }

  #resupersede(keys: Set<string>): void {
    const sel = this.#db.prepare('SELECT fid, object, valid_from, valid_to, mentioned_at, item_date FROM facts WHERE gkey = ? ORDER BY fid');
    const upd = this.#db.prepare('UPDATE facts SET superseded_on = ? WHERE fid = ?');
    for (const k of keys) {
      const rows = sel.all(k) as { fid: number; object: string; valid_from: string | null; valid_to: string | null; mentioned_at: string; item_date: string }[];
      const key = (r: typeof rows[number]) => [r.valid_from || r.mentioned_at || r.item_date || '', r.mentioned_at || ''] as const;
      const sorted = rows.map((r, i) => ({ r, i })).sort((a, b) => {
        const [a1, a2] = key(a.r), [b1, b2] = key(b.r);
        return a1 < b1 ? -1 : a1 > b1 ? 1 : a2 < b2 ? -1 : a2 > b2 ? 1 : a.i - b.i;
      }).map(x => x.r);
      const sup = new Map<number, string | null>(rows.map(r => [r.fid, null]));
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1] as typeof rows[number], cur = sorted[i] as typeof rows[number];
        if (norm(prev.object) !== norm(cur.object) && !prev.valid_to && sup.get(prev.fid) === null) sup.set(prev.fid, cur.valid_from || cur.mentioned_at);
      }
      for (const [fid, v] of sup) upd.run(v, fid);
    }
  }

  /** Items whose facts were not extracted yet (oldest first). */
  pendingExtraction(limit = 50): StoredItem[] {
    return this.#db.prepare(`SELECT id, date, source, title, text FROM items WHERE id NOT IN (SELECT item FROM extracted)
      ORDER BY date, id LIMIT ?`).all(limit) as StoredItem[];
  }

  setFactVectors(vectors: readonly { fid: number; vec: Float32Array }[]): void {
    this.#factVecs.set(vectors.map(v => ({ id: v.fid, vec: v.vec })), 'fact');
  }

  /** Facts that still need an embedding, with the text that is embedded ("subject | predicate | object"). */
  missingFactVectors(limit = 256): { fid: number; text: string }[] {
    return this.#db.prepare(`SELECT fid, subject || ' | ' || predicate || ' | ' || object AS text FROM facts WHERE vec IS NULL
      ORDER BY fid LIMIT ?`).all(limit) as { fid: number; text: string }[];
  }

  /** The measured fact retrieval: keyword and vector candidates (50 each) fused, top 20. */
  searchFacts(question: string, query: Float32Array | null, top = 20): number[] {
    const kw = (this.#db.prepare('SELECT rowid FROM facts_fts WHERE facts_fts MATCH ? ORDER BY bm25(facts_fts) LIMIT ?')
      .all(ftsQuery(question), CANDIDATES) as { rowid: number }[]).map(r => r.rowid);
    return fuse(query ? [kw, this.#factVecs.search(query, CANDIDATES)] : [kw], top);
  }

  facts(fids: readonly number[]): Fact[] {
    if (fids.length === 0) return [];
    const rows = this.#db.prepare(`SELECT fid, item, subject, predicate, object, valid_from, valid_to, superseded_on, mentioned_at, quote
      FROM facts WHERE fid IN (${fids.map(() => '?').join(',')})`).all(...fids) as Fact[];
    const by = new Map(rows.map(r => [r.fid, r]));
    return fids.flatMap(f => (by.has(f) ? [by.get(f) as Fact] : []));
  }

  /** Every fact about a subject (case and spacing ignored), oldest first. */
  factsAbout(subject: string): Fact[] {
    const ids = (this.#db.prepare(`SELECT fid FROM facts WHERE gkey >= ? AND gkey < ? ORDER BY coalesce(valid_from, mentioned_at), fid`)
      .all(norm(subject) + '\u0000', norm(subject) + '\u0001') as { fid: number }[]).map(r => r.fid);
    return this.facts(ids);
  }

  /** Facts mentioned, starting, ending or superseded on or after `since` (YYYY-MM-DD), newest first. */
  changedSince(since: string, limit = 100): Fact[] {
    const ids = (this.#db.prepare(`SELECT fid FROM facts WHERE mentioned_at >= @since OR valid_from >= @since OR valid_to >= @since
      OR superseded_on >= @since ORDER BY max(mentioned_at, coalesce(valid_from, ''), coalesce(superseded_on, '')) DESC, fid DESC
      LIMIT @limit`).all({ since, limit }) as { fid: number }[]).map(r => r.fid);
    return this.facts(ids);
  }

  /**
   * Copy the store file, still encrypted with the store key, to `dest` as a consistent snapshot: the write-ahead log
   * is folded into the file, then the file is copied while this connection holds the write lock, so no other writer
   * can change it. Pages that did not change keep their exact bytes, which lets backups skip them. One process owns
   * the store (the daemon or the CLI), so the fold normally succeeds; if another connection keeps the log busy this
   * throws and the caller retries later.
   */
  snapshotTo(dest: string): void {
    if (this.path === ':memory:') throw new Error('an in-memory store has no file to snapshot');
    const fs = require('node:fs') as typeof import('node:fs');
    const [ck] = this.#db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number; log: number }[];
    if (!ck || ck.busy !== 0) throw new Error('store is busy; snapshot not taken');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const wal = `${this.path}-wal`;
      if (fs.existsSync(wal) && fs.statSync(wal).size > 0) throw new Error('store changed during snapshot; not taken');
      fs.copyFileSync(this.path, dest);
    } finally {
      this.#db.exec('COMMIT');
    }
  }

  close(): void { this.#db.close(); }
}
