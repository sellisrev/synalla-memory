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
const asset = { url: 'https://huggingface.co/org/repo/resolve/main/m.gguf', size: body.length, sha256: createHash('sha256').update(body).digest('hex') };
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

test('sidecar failures say what to do: a missing system library names the package', async () => {
  const { sidecarFailure } = await import('../src/models.ts');
  const m = sidecarFailure(127, './llama-server: error while loading shared libraries: libgomp.so.1: cannot open shared object file: No such file or directory\n');
  assert.match(m, /needs the system library libgomp\.so\.1 \(Debian\/Ubuntu: sudo apt install libgomp1; Fedora: sudo dnf install libgomp\)/);
  assert.match(m, /--embed-url .*--no-embed/);
  assert.match(sidecarFailure(1, 'line1\nline2\nload failed: bad model\n'), /exited with code 1: line1 \| line2 \| load failed: bad model$/);
  assert.equal(sidecarFailure(2, ''), 'llama-server exited with code 2');
  for (const code of [3221225781, -1073741515]) assert.match(sidecarFailure(code, ''), /Microsoft Visual C\+\+ runtime.*winget install Microsoft\.VCRedist\.2015\+\.x64.*--no-embed/);
});

test('Windows: the VC++ runtime goes next to llama-server from the pinned release, checked; present files are kept', { skip: process.platform !== 'win32' }, async () => {
  const { ensureModels, WIN_RUNTIME, LLAMA_CPP_BUILD, EMBED_MODEL } = await import('../src/models.ts');
  const fs = await import('node:fs'); const { join } = await import('node:path'); const os = await import('node:os');
  assert.deepEqual(WIN_RUNTIME.map(d => d.file), ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']);
  for (const d of WIN_RUNTIME) assert.match(d.url, /^https:\/\/github\.com\/sellisrev\/synalla-memory\/releases\/download\/vcruntime-14\.44\.35211\//);
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'synalla-models-'));
  try {
    const bin = join(dir, `llama.cpp-${LLAMA_CPP_BUILD}-win32-x64-cpu`); fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(join(bin, 'llama-server.exe'), 'x');
    fs.writeFileSync(join(dir, EMBED_MODEL.file), Buffer.alloc(0)); // wrong size: but the runtime comes first and fails
    const asked = [];
    const bad = async url => { asked.push(String(url)); return new Response(new Uint8Array(10)); };
    await assert.rejects(ensureModels(dir, { fetch: bad }), /checksum mismatch/);
    assert.equal(asked[0], WIN_RUNTIME[0].url);
    assert.deepEqual(fs.readdirSync(bin).sort(), ['llama-server.exe']); // nothing half-written left behind
    for (const d of WIN_RUNTIME) fs.writeFileSync(join(bin, d.file), Buffer.alloc(d.size));
    const none = async url => { if (WIN_RUNTIME.some(d => d.url === String(url))) throw new Error('downloaded again'); return new Response(new Uint8Array(10)); };
    await assert.rejects(ensureModels(dir, { fetch: none }), /checksum mismatch for https:\/\/huggingface/); // runtime kept, model next
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
