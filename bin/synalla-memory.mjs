#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial
// Installed packages run the compiled code in dist/; a source checkout runs src/ (Node 22.18+ strips the types).
import { existsSync } from 'node:fs';
const built = new URL('../dist/cli.js', import.meta.url);
const { main, defaultEnv } = await import(existsSync(built) ? built.href : new URL('../src/cli.ts', import.meta.url).href);
process.exitCode = await main(process.argv.slice(2), defaultEnv());
