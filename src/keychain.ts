// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// Keys at rest in the operating system's own store (pilot plan W1: "SQLCipher key in the OS keychain"), without a
// native module: macOS Keychain through `security`, Linux Secret Service through `secret-tool` (libsecret), Windows
// through DPAPI (the same per-user protection Credential Manager uses), via PowerShell. Secrets always travel on
// stdin, never on a command line, where other local users could see them in the process list.
//
// This protects keys on a powered-off or locked machine. Anyone using the unlocked session can read them, as with any
// keychain; the install note says so.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { homedir } from 'node:os';

const require = createRequire(import.meta.url);

export interface Keychain {
  readonly kind: string;
  get(name: string): Uint8Array | null;
  set(name: string, value: Uint8Array): void;
  delete(name: string): void;
}

export type Runner = (cmd: string, args: string[], input?: string) => { status: number | null; stdout: string; stderr: string };

const run: Runner = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

const SERVICE = 'synalla-memory';
const checkName = (n: string) => { if (!/^[a-z0-9-]{1,40}$/.test(n)) throw new TypeError('key name must be lowercase letters, digits and dashes'); };
const hex = (v: Uint8Array) => Buffer.from(v).toString('hex');
const unhex = (s: string) => {
  const t = s.trim();
  if (!/^([0-9a-f]{2})+$/.test(t)) throw new Error('keychain returned something that is not a key');
  return new Uint8Array(Buffer.from(t, 'hex'));
};

export function macKeychain(r: Runner = run): Keychain {
  return {
    kind: 'macOS Keychain',
    get(name) {
      checkName(name);
      const o = r('security', ['find-generic-password', '-a', name, '-s', SERVICE, '-w']);
      if (o.status === 44) return null; // item not found
      if (o.status !== 0) throw new Error(`Keychain read failed: ${o.stderr.trim()}`);
      return unhex(o.stdout);
    },
    set(name, value) {
      checkName(name);
      // `security -i` reads commands from stdin, so the secret never appears in the process list.
      const o = r('security', ['-i'], `add-generic-password -U -a ${name} -s ${SERVICE} -w ${hex(value)}\n`);
      if (o.status !== 0) throw new Error(`Keychain write failed: ${o.stderr.trim()}`);
    },
    delete(name) {
      checkName(name);
      const o = r('security', ['delete-generic-password', '-a', name, '-s', SERVICE]);
      if (o.status !== 0 && o.status !== 44) throw new Error(`Keychain delete failed: ${o.stderr.trim()}`);
    },
  };
}

export function linuxSecretService(r: Runner = run): Keychain {
  return {
    kind: 'Secret Service (libsecret)',
    get(name) {
      checkName(name);
      const o = r('secret-tool', ['lookup', 'service', SERVICE, 'account', name]);
      if (o.status !== 0 || !o.stdout.trim()) return null;
      return unhex(o.stdout);
    },
    set(name, value) {
      checkName(name);
      const o = r('secret-tool', ['store', `--label=Synalla memory (${name})`, 'service', SERVICE, 'account', name], hex(value));
      if (o.status !== 0) throw new Error(`Secret Service write failed (is a keyring unlocked?): ${o.stderr.trim()}`);
    },
    delete(name) {
      checkName(name);
      r('secret-tool', ['clear', 'service', SERVICE, 'account', name]);
    },
  };
}

/** Windows: DPAPI (current user) blobs in %APPDATA%\Synalla\keys\<name>.dpapi. */
export function windowsDpapi(r: Runner = run, dir = join(process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'), 'Synalla', 'keys')): Keychain {
  const file = (name: string) => join(dir, `${name}.dpapi`);
  const ps = (script: string, input?: string) =>
    r('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], input);
  const prelude = 'Add-Type -AssemblyName System.Security; $ErrorActionPreference = "Stop"; ';
  return {
    kind: 'Windows DPAPI',
    get(name) {
      checkName(name);
      const p = file(name).replace(/'/g, "''");
      const o = ps(prelude + `$p = '${p}'; if (-not (Test-Path -LiteralPath $p)) { exit 3 }; `
        + `$b = [IO.File]::ReadAllBytes($p); $u = [Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser'); `
        + `[Console]::Out.Write(([BitConverter]::ToString($u) -replace '-','').ToLower())`);
      if (o.status === 3) return null;
      if (o.status !== 0) throw new Error(`DPAPI read failed: ${o.stderr.trim()}`);
      return unhex(o.stdout);
    },
    set(name, value) {
      checkName(name);
      const target = file(name).replace(/'/g, "''");
      const o = ps(prelude + `$h = [Console]::In.ReadToEnd().Trim(); $b = [byte[]]::new($h.Length / 2); `
        + `for ($i = 0; $i -lt $b.Length; $i++) { $b[$i] = [Convert]::ToByte($h.Substring(2 * $i, 2), 16) }; `
        + `$e = [Security.Cryptography.ProtectedData]::Protect($b, $null, 'CurrentUser'); `
        + `New-Item -ItemType Directory -Force -Path (Split-Path -LiteralPath '${target}') | Out-Null; `
        + `$t = '${target}' + '.tmp'; [IO.File]::WriteAllBytes($t, $e); Move-Item -Force -LiteralPath $t -Destination '${target}'`, hex(value));
      if (o.status !== 0) throw new Error(`DPAPI write failed: ${o.stderr.trim()}`);
    },
    delete(name) {
      checkName(name);
      const o = ps(`Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath '${file(name).replace(/'/g, "''")}'`);
      if (o.status !== 0) throw new Error(`DPAPI delete failed: ${o.stderr.trim()}`);
    },
  };
}

export function systemKeychain(platform: NodeJS.Platform = process.platform, r: Runner = run,
  opts: { dir?: string; passphrase?: () => string | undefined } = {}): Keychain {
  if (platform === 'darwin') return macKeychain(r);
  if (platform === 'win32') return windowsDpapi(r);
  return linuxKeychain(opts.dir ?? join(homedir(), '.synalla', 'memory', 'keys'), opts.passphrase ?? (() => process.env['SYNALLA_MEMORY_PASSPHRASE']), r);
}

const PMAGIC = Buffer.from('SMK1');

/**
 * Keys in files under `dir`, each sealed with AES-256-GCM under a key derived from a passphrase (scrypt, N=2^15,
 * r=8, p=1, 16-byte salt per file). For machines with no usable keychain: Linux servers, WSL, containers. The
 * passphrase comes from `passphrase()` (the CLI reads SYNALLA_MEMORY_PASSPHRASE), so the MCP server can start
 * without a terminal. Without the passphrase the files are useless; with it, they open.
 */
export function passphraseKeychain(dir: string, passphrase: () => string | undefined): Keychain {
  const { scryptSync, randomBytes, createCipheriv, createDecipheriv } = require('node:crypto') as typeof import('node:crypto');
  const fs = require('node:fs') as typeof import('node:fs');
  const file = (name: string) => join(dir, `${name}.key`);
  const pass = () => {
    const p = passphrase();
    if (!p || p.length < 12) throw new Error('no usable keychain here: set SYNALLA_MEMORY_PASSPHRASE (at least 12 characters) to keep the keys in passphrase-protected files');
    return p;
  };
  const kdf = (p: string, salt: Buffer) => scryptSync(p, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return {
    kind: 'passphrase-protected files',
    get(name) {
      checkName(name);
      if (!fs.existsSync(file(name))) return null;
      const b = fs.readFileSync(file(name));
      if (b.length < 4 + 16 + 12 + 16 || !b.subarray(0, 4).equals(PMAGIC)) throw new Error(`${file(name)} is not a Synalla key file`);
      const d = createDecipheriv('aes-256-gcm', kdf(pass(), b.subarray(4, 20)), b.subarray(20, 32));
      d.setAuthTag(b.subarray(b.length - 16));
      try { return new Uint8Array(Buffer.concat([d.update(b.subarray(32, b.length - 16)), d.final()])); } catch {
        throw new Error('wrong passphrase for the memory keys (SYNALLA_MEMORY_PASSPHRASE)');
      }
    },
    set(name, value) {
      checkName(name);
      const salt = randomBytes(16), nonce = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', kdf(pass(), salt), nonce);
      const body = Buffer.concat([c.update(Buffer.from(value)), c.final()]);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file(name)}.tmp`;
      fs.writeFileSync(tmp, Buffer.concat([PMAGIC, salt, nonce, body, c.getAuthTag()]), { mode: 0o600 });
      fs.renameSync(tmp, file(name));
    },
    delete(name) {
      checkName(name);
      fs.rmSync(file(name), { force: true });
    },
  };
}

/**
 * Linux: the Secret Service when it works, otherwise passphrase-protected files. A key already in a file is read from
 * there, so a machine that gains a keyring later keeps working.
 */
export function linuxKeychain(dir: string, passphrase: () => string | undefined, r: Runner = run): Keychain {
  const files = passphraseKeychain(dir, passphrase);
  const ss = linuxSecretService(r);
  let usable: boolean | undefined;
  const secretServiceWorks = () => {
    if (usable !== undefined) return usable;
    try {
      const probe = new Uint8Array([1, 2, 3, 4]);
      ss.set('probe', probe);
      usable = Buffer.from(ss.get('probe') ?? []).equals(Buffer.from(probe));
      ss.delete('probe');
    } catch { usable = false; }
    return usable;
  };
  const fs = require('node:fs') as typeof import('node:fs');
  const inFile = (name: string) => fs.existsSync(join(dir, `${name}.key`));
  return {
    get kind() { return secretServiceWorks() ? ss.kind : files.kind; },
    get(name) { return inFile(name) || !secretServiceWorks() ? files.get(name) : ss.get(name); },
    set(name, value) { if (secretServiceWorks()) ss.set(name, value); else files.set(name, value); },
    delete(name) { files.delete(name); if (secretServiceWorks()) ss.delete(name); },
  };
}
