#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial
import { main, defaultEnv } from '../src/cli.ts';
process.exitCode = await main(process.argv.slice(2), defaultEnv());
