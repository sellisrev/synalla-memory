// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

export const VERSION = "0.0.1";
export { KINDS, marker, scrub } from './scrub.ts';
export { fuse, ftsQuery, RRF_K, DEFAULT_TOP, CANDIDATES } from './fusion.ts';
export { MemoryStore, quantize, SCHEMA_VERSION } from './store.ts';
export type { Item, Chunk, StoreOptions } from './store.ts';
