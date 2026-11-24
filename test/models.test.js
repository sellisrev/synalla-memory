// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { download, serverAssetKey, startEmbedServer, SERVER_ASSETS, EMBED_MODEL } from '../src/models.ts';
import { httpEmbedder } from '../src/embed.ts';

const body = Buffer.from('pretend model bytes '.repeat(1000));
const asset = { url: 'https://example.org/m.gguf', size: body.length, sha256: createHash('sha256').update(body).digest('hex') };
const serve = (bytes, status = 200) => async () => ({ ok: status === 200, status, body: (async function* () { for (let i = 0; i < bytes.length; i += 4096) yield bytes.subarray(i, i + 4096); })() });

test('download: checks size and SHA-256 while streaming; a mismatch leaves nothing behind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'synalla-dl-'));
  try {
    const seen = [];
    await download(asset, join(dir, 'ok.gguf'), { fetch: serve(body), progress: (d, t) => seen.push([d, t]) });
    assert.deepEqual(readFileSync(join(dir, 'ok.gguf')), body);
    assert.deepEqual(seen.at(-1), [body.length, body.length]);
    const tampered = Buffer.from(body); tampered[5] ^= 1;
    await assert.rejects(download(asset, join(dir, 'bad.gguf'), { fetch: serve(tampered) }), /checksum mismatch/);
    await assert.rejects(download(asset, join(dir, 'big.gguf'), { fetch: serve(Buffer.concat([body, body])) }), /larger than the pinned/);
    await assert.rejects(download(asset, join(dir, 'gone.gguf'), { fetch: serve(body, 404) }), /HTTP 404/);
    assert.deepEqual(readdirSync(dir).sort(), ['ok.gguf'], 'no partial files left');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pinned assets: every platform key resolves, only github.com and huggingface.co, digests are hex', () => {
  assert.equal(serverAssetKey('win32', 'x64'), 'win32-x64-cpu');
  assert.equal(serverAssetKey('win32', 'x64', 'vulkan'), 'win32-x64-vulkan');
  assert.equal(serverAssetKey('darwin', 'arm64', 'vulkan'), 'darwin-arm64-cpu');
  assert.throws(() => serverAssetKey('linux', 'riscv64'), /no pinned llama.cpp build/);
  for (const a of [...Object.values(SERVER_ASSETS), EMBED_MODEL]) {
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
    assert.ok(['github.com', 'huggingface.co'].includes(new URL(a.url).hostname), a.url);
  }
});

// Runs only where the pinned build and model already sit on disk (this build machine); downloads nothing.
const LOCAL_SERVER = 'C:/AI/tools/llama.cpp-b12110/llama-server.exe';
const LOCAL_MODEL = 'C:/AI/models/llm/memory-small/Qwen3-Embedding-0.6B-Q8_0.gguf';
test('sidecar: starts llama-server on a free port (CPU) and embeds; stop ends it', async () => {
  if (!existsSync(LOCAL_SERVER) || !existsSync(LOCAL_MODEL)) return;
  const s = await startEmbedServer(LOCAL_SERVER, LOCAL_MODEL, { gpuLayers: 0 });
  try {
    assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const [a, b, c] = await httpEmbedder({ url: s.url, dim: EMBED_MODEL.dim }).embed(['The landlord is Frau Kerschbaumer', 'Our landlady is called Kerschbaumer', 'Gradient descent converges'], 'passage');
    const cos = (x, y) => x.reduce((s, v, i) => s + v * y[i], 0) / Math.sqrt(x.reduce((s, v) => s + v * v, 0) * y.reduce((s, v) => s + v * v, 0));
    assert.ok(cos(a, b) > cos(a, c), 'related sentences are closer');
  } finally { s.stop(); }
  await new Promise(r => s.process.once('exit', r));
});
