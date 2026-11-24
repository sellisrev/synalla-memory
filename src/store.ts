// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// The encrypted memory store (pilot plan W1). One SQLite file, encrypted with SQLCipher (better-sqlite3-multiple-
// ciphers, cipher set explicitly), holding items, their chunks, an FTS5 index for keyword search (BM25) and one
// embedding vector per chunk (float32 in the file). Vector search is brute force over an int8 copy held in RAM (about 1 KB per chunk at
// 1024 dimensions, so 200k chunks fit in about 200 MB), which is the measured CPU default's scale.
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

export class MemoryStore {
  readonly dim: number;
  readonly path: string;
  #db: Db;
  #ids: number[] = [];
  #mat: Int8Array = new Int8Array(0);
  #pos = new Map<number, number>();

  private constructor(db: Db, dim: number, path: string) { this.#db = db; this.dim = dim; this.path = path; }

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
    store.#loadVectors();
    return store;
  }

  #loadVectors(): void {
    const rows = this.#db.prepare('SELECT cid, vec FROM chunks WHERE vec IS NOT NULL ORDER BY cid').all() as { cid: number; vec: Buffer }[];
    this.#ids = rows.map(r => r.cid);
    this.#mat = new Int8Array(rows.length * this.dim);
    this.#pos.clear();
    rows.forEach((r, i) => {
      const f = new Float32Array(r.vec.buffer.slice(r.vec.byteOffset, r.vec.byteOffset + r.vec.byteLength));
      this.#mat.set(quantize(f), i * this.dim);
      this.#pos.set(r.cid, i);
    });
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
    this.#db.prepare('DELETE FROM chunks WHERE item = ?').run(id);
    const n = this.#db.prepare('DELETE FROM items WHERE id = ?').run(id).changes;
    if (cids.some(c => this.#pos.has(c))) this.#dropFromCache(new Set(cids));
    return n;
  }

  #dropFromCache(drop: Set<number>): void {
    const keep = this.#ids.map((cid, i) => [cid, i] as const).filter(([cid]) => !drop.has(cid));
    const mat = new Int8Array(keep.length * this.dim);
    keep.forEach(([, i], j) => mat.set(this.#mat.subarray(i * this.dim, (i + 1) * this.dim), j * this.dim));
    this.#ids = keep.map(([cid]) => cid);
    this.#mat = mat;
    this.#pos = new Map(this.#ids.map((cid, j) => [cid, j]));
  }

  /** Delete an item and its chunks. Returns whether it existed. */
  deleteItem(id: string): boolean {
    return this.#db.transaction(() => this.#removeItem(id))() > 0;
  }

  /** Store embeddings for chunks (float32 in the file; the RAM cache is rebuilt as int8). */
  setVectors(vectors: readonly { cid: number; vec: Float32Array }[]): void {
    for (const { vec } of vectors) {
      if (!(vec instanceof Float32Array) || vec.length !== this.dim) throw new TypeError(`vectors must be Float32Array(${this.dim})`);
    }
    const upd = this.#db.prepare('UPDATE chunks SET vec = ? WHERE cid = ?');
    this.#db.transaction(() => {
      for (const { cid, vec } of vectors) {
        if (upd.run(Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), cid).changes !== 1) throw new RangeError(`no chunk ${cid}`);
      }
    })();
    const add = [...new Set(vectors.map(v => v.cid))].filter(cid => !this.#pos.has(cid));
    if (add.length > 0) {
      const mat = new Int8Array((this.#ids.length + add.length) * this.dim);
      mat.set(this.#mat);
      this.#mat = mat;
      for (const cid of add) { this.#pos.set(cid, this.#ids.length); this.#ids.push(cid); }
    }
    for (const { cid, vec } of vectors) this.#mat.set(quantize(vec), (this.#pos.get(cid) as number) * this.dim);
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
    const rows = this.#db.prepare(`SELECT cid, vec FROM chunks WHERE cid IN (${cand.map(() => '?').join(',')})`).all(...cand) as { cid: number; vec: Buffer }[];
    let qn = 0;
    for (const x of query) qn += x * x;
    qn = Math.sqrt(qn) || 1;
    const exact = rows.map(r => {
      const f = new Float32Array(r.vec.buffer.slice(r.vec.byteOffset, r.vec.byteOffset + r.vec.byteLength));
      let dot = 0, nn = 0;
      for (let j = 0; j < d; j++) { dot += (f[j] as number) * (query[j] as number); nn += (f[j] as number) ** 2; }
      return { cid: r.cid, s: nn > 0 ? dot / (Math.sqrt(nn) * qn) : 0 };
    });
    exact.sort((a, b) => b.s - a.s || a.cid - b.cid);
    return exact.slice(0, k).map(x => x.cid);
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

  stats(): { items: number; chunks: number; vectors: number } {
    const one = (sql: string) => (this.#db.prepare(sql).get() as { n: number }).n;
    return { items: one('SELECT count(*) n FROM items'), chunks: one('SELECT count(*) n FROM chunks'), vectors: this.#ids.length };
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
