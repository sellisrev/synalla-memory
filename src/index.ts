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
export { backup, restore, rotateBackupKey, listSnapshots, prune, retained, folderTarget, sealManifest, openManifest, PIECE } from './backup.ts';
export type { Target, Manifest, SnapshotResult, SnapshotInfo } from './backup.ts';
export { webdavTarget } from './backup.ts';
export type { WebDavOptions } from './backup.ts';
export { exportPlain, renderPlain, README as READABLE_README } from './export.ts';
export type { StoredItem } from './store.ts';
export { systemKeychain, macKeychain, linuxSecretService, windowsDpapi } from './keychain.ts';
export type { Keychain, Runner } from './keychain.ts';
export { main as cli, reminders } from './cli.ts';
export type { Config } from './cli.ts';
export { toRecoveryCode, fromRecoveryCode } from './recovery_code.ts';
export { readHermes, hermesDbPath, HermesFormatChangedError } from './import_hermes.ts';
export { readOpenClaw, readOpenClawDb, openclawStateDir, openclawAgentDbs, OpenClawFormatChangedError } from './import_openclaw.ts';
export { ensureModels, startEmbedServer, download, serverAssetKey, SERVER_ASSETS, EMBED_MODEL, LLAMA_CPP_BUILD } from './models.ts';
export type { Asset, Sidecar } from './models.ts';
export { extractionPrompt, checkFacts, factLine, itemText, extractPending, httpChatModel, FACTS_SCHEMA, ITEM_CHARS, MAX_FACTS } from './facts.ts';
export type { ChatModel, HttpChatOptions } from './facts.ts';
export type { Fact, FactInput } from './store.ts';
export { s3Target, signS3 } from './backup.ts';
export type { S3Options } from './backup.ts';
export { guardFetch, sameOrigin, domains, isLoopback, MODEL_HOSTS, egressLog, resetEgressLog, EgressRefused } from './egress.ts';
export type { EgressKind, Allow } from './egress.ts';
export { itemWindows } from './facts.ts';
export { MAX_WINDOWS } from './facts.ts';
export { passphraseKeychain, linuxKeychain } from './keychain.ts';
export { sidecarFailure } from './models.ts';
