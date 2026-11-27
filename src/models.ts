// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// Local models without a server to install (pilot plan W1). The package runs llama.cpp's own `llama-server` as a
// sidecar on a free localhost port and talks to it through the same OpenAI-compatible route as any local endpoint
// (embed.ts). Chosen over the node-llama-cpp module (24 Nov 2026): that module brings a postinstall script, about 30
// dependencies on caret ranges and 14 platform packages; the sidecar is one pinned release archive per platform from
// ggml-org/llama.cpp plus one model file, both checked against published SHA-256 digests before use.
//
// Downloads come only from the pinned URLs below (github.com release assets and huggingface.co), on first use,
// with a progress callback. Unpacking uses the system `tar` (bsdtar on Windows 10+ also reads .zip).

import { createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { guardFetch, isLoopback, MODEL_HOSTS } from './egress.ts';

export const LLAMA_CPP_BUILD = 'b12110';

export interface Asset { url: string; sha256: string; size: number }

const GH = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_BUILD}/llama-${LLAMA_CPP_BUILD}-bin-`;
/** Digests as published by GitHub for release b12110 (4 Nov 2026). */
export const SERVER_ASSETS: Record<string, Asset> = {
  'win32-x64-cpu': { url: GH + 'win-cpu-x64.zip', size: 24708445, sha256: '98901e327c252875accaf2d1bf364e10e868843b0b63468baad1aa945cdc5da2' },
  'win32-x64-vulkan': { url: GH + 'win-vulkan-x64.zip', size: 37661146, sha256: '9732a5e48887ca54d0bfe4af4324dc85fd56cd8cda19b52df3542fa6ebe6874f' },
  'darwin-arm64-cpu': { url: GH + 'macos-arm64.tar.gz', size: 16650691, sha256: '4f5b8de12e0b9516658ca6a5764c6ffb3d7c659c3dd538556b1413c7b4050662' },
  'darwin-x64-cpu': { url: GH + 'macos-x64.tar.gz', size: 12388601, sha256: 'c8094268b6bf62f4998f0e45656fd9f5e2d4afb6b1cd0044d761db64be1dd47d' },
  'linux-x64-cpu': { url: GH + 'ubuntu-x64.tar.gz', size: 23051958, sha256: '368227edcc229be5f9bed16a2223d79b5e41d0ac2e19bcf5825e82291c060e55' },
  'linux-x64-vulkan': { url: GH + 'ubuntu-vulkan-x64.tar.gz', size: 35858360, sha256: 'a5d741940956ec62e8783aee7e5a4c7c761af867d6f027c3277a51e1a3ac59b0' },
};

/**
 * The Microsoft Visual C++ runtime that llama.cpp's Windows builds need and a new PC may not have (STATUS_DLL_NOT_FOUND
 * on a clean Windows, 27 Nov 2026). Microsoft's redistributable files, unchanged and signed, from the Visual Studio
 * 2022 redist folder, published on our own release; they go next to llama-server.exe, where Windows looks first.
 */
const VCRT = 'https://github.com/sellisrev/synalla-memory/releases/download/vcruntime-14.44.35211/';
export const WIN_RUNTIME: (Asset & { file: string })[] = [
  { file: 'msvcp140.dll', url: VCRT + 'msvcp140.dll', size: 557728, sha256: '0f885b509a685d2bbfa652fed26b5fb31d88fbdab0a978c641d1c7b8aa460aa9' },
  { file: 'vcruntime140.dll', url: VCRT + 'vcruntime140.dll', size: 124544, sha256: 'd5e4d9a3e835fa679450145d6a7d94e36573a509317111904d9b3712c30d9066' },
  { file: 'vcruntime140_1.dll', url: VCRT + 'vcruntime140_1.dll', size: 49792, sha256: '1f2d41c4aa5db0bc33ebf7b66d72943a817d7ce6cbe880502a9403823633093f' },
];

/** Qwen3-Embedding-0.6B, Q8_0, the embedder of the measured CPU default (official Qwen release; LFS sha256). */
export const EMBED_MODEL: Asset & { file: string; dim: number } = {
  url: 'https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf',
  file: 'Qwen3-Embedding-0.6B-Q8_0.gguf', size: 639150592, dim: 1024,
  sha256: '06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439',
};

export function serverAssetKey(platform: NodeJS.Platform = process.platform, arch: string = process.arch, gpu: 'cpu' | 'vulkan' = 'cpu'): string {
  const key = `${platform}-${arch}-${platform === 'darwin' ? 'cpu' : gpu}`; // macOS builds use Metal by themselves
  if (!SERVER_ASSETS[key]) throw new Error(`no pinned llama.cpp build for ${key}; point embedUrl at your own local endpoint instead`);
  return key;
}

export type Progress = (done: number, total: number) => void;

/** Download `asset` to `dest`, checking size and SHA-256 while streaming; a mismatch leaves nothing behind. */
export async function download(asset: Asset, dest: string, opts: { fetch?: typeof fetch; progress?: Progress } = {}): Promise<void> {
  const f = guardFetch('model-download', MODEL_HOSTS, { followRedirects: true, ...(opts.fetch ? { base: opts.fetch } : {}) });
  const r = await f(asset.url);
  if (!r.ok || !r.body) throw new Error(`download failed: HTTP ${r.status} for ${asset.url}`);
  const tmp = `${dest}.part`;
  const hash = createHash('sha256');
  const out = createWriteStream(tmp);
  let done = 0;
  try {
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      done += chunk.length;
      if (done > asset.size) throw new Error(`download larger than the pinned ${asset.size} bytes`);
      if (!out.write(chunk)) await new Promise<void>(res => out.once('drain', () => res()));
      opts.progress?.(done, asset.size);
    }
    await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
    const got = hash.digest('hex');
    if (done !== asset.size || got !== asset.sha256) throw new Error(`checksum mismatch for ${asset.url}: refusing to use it`);
    renameSync(tmp, dest);
  } catch (e) {
    out.destroy();
    rmSync(tmp, { force: true });
    throw e;
  }
}

function findServer(dir: string): string | null {
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop() as string;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p); else if (e.name === exe) return p;
    }
  }
  return null;
}

/** Make sure the pinned server and embedding model are in `dir`; download them if not. Returns their paths. */
export async function ensureModels(dir: string, opts: { gpu?: 'cpu' | 'vulkan'; fetch?: typeof fetch; progress?: (what: string, done: number, total: number) => void } = {}):
  Promise<{ server: string; model: string }> {
  const key = serverAssetKey(process.platform, process.arch, opts.gpu ?? 'cpu');
  const binDir = join(dir, `llama.cpp-${LLAMA_CPP_BUILD}-${key}`);
  let server = existsSync(binDir) ? findServer(binDir) : null;
  if (!server) {
    mkdirSync(dir, { recursive: true });
    const asset = SERVER_ASSETS[key] as Asset;
    const archive = join(dir, asset.url.split('/').pop() as string);
    await download(asset, archive, { ...(opts.fetch ? { fetch: opts.fetch } : {}), progress: (d, t) => opts.progress?.('llama.cpp', d, t) });
    const tmp = `${binDir}.tmp`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    // On Windows use the system's bsdtar (reads .zip); a GNU tar earlier on the PATH (Git Bash, MSYS) reads "C:" as a host.
    const tar = process.platform === 'win32' ? join(process.env['SystemRoot'] ?? 'C:/Windows', 'System32', 'tar.exe') : 'tar';
    const x = spawnSync(tar, ['-xf', archive, '-C', tmp], { encoding: 'utf8' });
    if (x.status !== 0) throw new Error(`could not unpack ${archive}: ${x.stderr || x.error}`);
    renameSync(tmp, binDir);
    rmSync(archive, { force: true });
    server = findServer(binDir);
    if (!server) throw new Error('llama-server not found in the pinned archive');
  }
  if (key.startsWith('win32-')) { // also for servers unpacked before the runtime was shipped
    const at = dirname(server);
    for (const dll of WIN_RUNTIME) {
      const p = join(at, dll.file);
      if (!existsSync(p) || statSync(p).size !== dll.size) {
        await download(dll, p, { ...(opts.fetch ? { fetch: opts.fetch } : {}), progress: (d, t) => opts.progress?.('Visual C++ runtime', d, t) });
      }
    }
  }
  const model = join(dir, EMBED_MODEL.file);
  if (!existsSync(model) || statSync(model).size !== EMBED_MODEL.size) {
    mkdirSync(dir, { recursive: true });
    await download(EMBED_MODEL, model, { ...(opts.fetch ? { fetch: opts.fetch } : {}), progress: (d, t) => opts.progress?.('embedding model', d, t) });
  }
  return { server, model };
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
  });
}

export interface Sidecar { url: string; stop(): void; process: ChildProcess }

/**
 * Start llama-server for embeddings on a free localhost port and wait until it answers /health. The arguments match
 * the measured setting (last-token pooling, 8,192-token batches). `gpuLayers` 0 keeps it on the CPU.
 */
export async function startEmbedServer(server: string, model: string, opts: { gpuLayers?: number; timeoutMs?: number; fetch?: typeof fetch } = {}): Promise<Sidecar> {
  const port = await freePort();
  const args = ['-m', model, '--embedding', '--pooling', 'last', '-ub', '8192', '-c', '8192', '--host', '127.0.0.1', '--port', String(port),
    '-ngl', String(opts.gpuLayers ?? 0)];
  const child = spawn(server, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let errTail = '';
  child.stderr?.on('data', (d: Buffer) => { errTail = (errTail + d.toString('utf8')).slice(-4000); });
  const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill(); };
  process.once('exit', stop);
  const url = `http://127.0.0.1:${port}`;
  const f = guardFetch('embed', isLoopback, opts.fetch ? { base: opts.fetch } : {});
  const until = Date.now() + (opts.timeoutMs ?? 120000);
  while (Date.now() < until) {
    if (child.exitCode !== null) {
      await new Promise(r => setTimeout(r, 50)); // let the last stderr lines arrive
      throw new Error(sidecarFailure(child.exitCode, errTail));
    }
    try { if ((await f(`${url}/health`)).ok) return { url, stop, process: child }; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  stop();
  throw new Error('llama-server did not become healthy in time');
}

/** A failure message the owner can act on, from llama-server's exit code and the end of its error output. */
export function sidecarFailure(code: number | null, stderr: string): string {
  const lib = /error while loading shared libraries: ([^\s:]+)/.exec(stderr)?.[1];
  if (lib) {
    const pkg = /^libgomp\.so/.test(lib) ? 'libgomp1' : /^libvulkan\.so/.test(lib) ? 'libvulkan1' : null;
    return `the built-in embedding server needs the system library ${lib}`
      + (pkg ? ` (Debian/Ubuntu: sudo apt install ${pkg}; Fedora: sudo dnf install ${pkg === 'libgomp1' ? 'libgomp' : 'vulkan-loader'})` : '')
      + '. Or run init with --embed-url <your embedding endpoint>, or --no-embed for keyword search only.';
  }
  // Windows STATUS_DLL_NOT_FOUND: llama.cpp's Windows build needs the Microsoft Visual C++ runtime, which a new PC
  // may not have (found on a clean Windows Sandbox, 27 Nov 2026).
  if (code === 3221225781 || code === -1073741515) {
    return 'the built-in embedding server needs the Microsoft Visual C++ runtime, which this PC does not have. Install it with'
      + ' `winget install Microsoft.VCRedist.2015+.x64` (or from https://aka.ms/vs/17/release/vc_redist.x64.exe), then try again.'
      + ' Or run init with --embed-url <your embedding endpoint>, or --no-embed for keyword search only.';
  }
  const last = stderr.trim().split(/\r?\n/).slice(-3).join(' | ');
  return `llama-server exited with code ${code}${last ? `: ${last}` : ''}`;
}
