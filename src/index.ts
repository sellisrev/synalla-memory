// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

export { VERSION } from './version.ts';
export { KINDS, marker, scrub } from './scrub.ts';
export { fuse, ftsQuery, RRF_K, DEFAULT_TOP, CANDIDATES } from './fusion.ts';
export { MemoryStore, quantize, SCHEMA_VERSION } from './store.ts';
export type { Item, Chunk, StoreOptions } from './store.ts';
export { chunkText, itemChunks, header, CHUNK, OVERLAP } from './chunk.ts';
export { parseSession, importClaudeCode, toStoreItem, cleanUserText, FormatChangedError } from './import_claude_code.ts';
export { McpServer, serveStdio, PROTOCOL_VERSIONS } from './mcp.ts';
export { httpEmbedder, QUERY_INSTRUCT } from './embed.ts';
export type { Embedder, HttpEmbedderOptions } from './embed.ts';
