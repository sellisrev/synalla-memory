// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// CPU speed of the built-in check (small_models.md, point 4), through the package's own path: the pinned llama.cpp CPU
// build started by startChatServer, and checks.ts asking the model. Records: the first 100 of scrub set 4 and the
// first 100 of the injection blind set. Prints seconds per model call and per record.
// Usage (repo root): node --import ./tools/ts-resolve.mjs benchmark/small_models_cpu.mjs <models dir> <gguf> [threads]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureModels, startChatServer } from '../src/models.ts';
import { checkModel, scrubWithModel, speaksToAgentModel } from '../src/checks.ts';

const [dir, gguf] = process.argv.slice(2);
const { server } = await ensureModels(dir, { gpu: 'cpu' });
const s = await startChatServer(server, gguf, { gpuLayers: 0 });
try {
  const base = checkModel(s.url, 'check');
  let calls = 0, secs = 0;
  const m = { async ask(...a) { const t = Date.now(); try { return await base.ask(...a); } finally { calls++; secs += (Date.now() - t) / 1000; } } };
  const scrubSet = JSON.parse(readFileSync(join('benchmark', 'scrub', 'blind', 'set4.json'), 'utf8')).slice(0, 100);
  const t1 = Date.now();
  for (const r of scrubSet) await scrubWithModel(r.text, m);
  const sCalls = calls, sSecs = secs, sWall = (Date.now() - t1) / 1000;
  calls = 0; secs = 0;
  const injSet = JSON.parse(readFileSync(join('benchmark', 'injection', 'blind', 'set.json'), 'utf8')).slice(0, 100);
  const t2 = Date.now();
  for (const r of injSet) await speaksToAgentModel(r.text, m);
  const iWall = (Date.now() - t2) / 1000;
  console.log(`secrets pass: ${sCalls} calls for 100 records, ${(sSecs / sCalls).toFixed(2)} s a call, ${(sWall / 100).toFixed(2)} s a record`);
  console.log(`injection question: ${calls} calls, ${(secs / calls).toFixed(2)} s a call, ${(iWall / 100).toFixed(2)} s a record`);
} finally { s.stop(); }
