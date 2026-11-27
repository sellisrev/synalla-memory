// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';
import { INSTRUCTIONS } from '../src/mcp.ts';

test('install-skill copies the shipped skill where each agent looks; --print writes it out', async () => {
  const root = mkdtempSync(join(tmpdir(), 'synalla-skill-'));
  try {
    const e = { home: join(root, 'mem'), userHome: root, openclawDir: join(root, 'oc'), keychain: { kind: 't', get: () => null, set() {}, delete() {} },
      out: s => e.o.push(s), err: s => e.r.push(s), o: [], r: [], readStdin: async () => '', now: () => new Date() };
    const skill = readFileSync(new URL('../skills/synalla-memory/SKILL.md', import.meta.url), 'utf8');
    assert.match(skill, /^---\nname: synalla-memory\ndescription: /);
    assert.match(skill, /show_to_owner/);
    assert.equal(await main(['install-skill', 'claude-code'], e), 0);
    assert.equal(readFileSync(join(root, '.claude', 'skills', 'synalla-memory', 'SKILL.md'), 'utf8'), skill);
    assert.equal(await main(['install-skill', 'openclaw'], e), 0);
    assert.equal(readFileSync(join(root, 'oc', 'skills', 'synalla-memory', 'SKILL.md'), 'utf8'), skill);
    e.o.length = 0;
    assert.equal(await main(['install-skill', '--print'], e), 0);
    assert.equal(e.o.join(''), skill);
    assert.notEqual(await main(['install-skill', 'nope'], e), 0);
    // the skill and the server's own instructions tell the agent the same rules
    for (const rule of ['show_to_owner', 'never guess', 'paste']) { assert.match(skill.toLowerCase(), new RegExp(rule)); assert.match(INSTRUCTIONS.toLowerCase(), new RegExp(rule)); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
