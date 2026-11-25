// Proactive-matching track for Synalla memory (life-session set, RULES.md).
//
//   node --import ./tools/ts-resolve.mjs benchmark/life-sessions/harness/proactive.mjs [--person L01] [--model daily] [--out <file>]
//
// Per person: a fresh encrypted store, the sessions imported with the Claude Code importer, then read for wants one
// item at a time in date order (scanWants with agentSessions, since these sessions are the person's own records).
// After each item, open wants at confidence >= 0.9 are matched against the network (matchWants: same topic, not
// expired, the person's city); every new (want, entry) pair is a proposal dated that item's day. No question is asked:
// the agent proposes on its own. Proposals go to runs/proactive_<model>.jsonl; score_proactive.py scores them.
import { existsSync, mkdirSync, readFileSync, appendFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { MemoryStore } from '../../../src/store.ts';
import { importClaudeCode } from '../../../src/import_claude_code.ts';
import { httpChatModel } from '../../../src/facts.ts';
import { scanWants, matchWants, WANTS_SCHEMA } from '../../../src/wants.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'out');
const WORK = join(HERE, '..', 'work', 'proactive');
const PEOPLE = {
  L01: ['Claire Morel', 'lyon'], L02: ['Aisha Rahman', 'leeds'], L03: ['Mateo Fernández', 'valencia'], L04: ['Krzysztof Nowak', 'krakow'],
  L05: ['Ji-woo Park', 'seoul'], L06: ['Thandiwe Dlamini', 'cape-town'], L07: ['Lukas Brandt', 'berlin'], L08: ['Valentina Rossi', 'mendoza'],
  L09: ['Daniel Okoye', 'toronto'], L10: ['Priya Nair', 'bangalore'],
};
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const log = s => process.stderr.write(`${new Date().toISOString()} ${s}\n`);
const keyFor = p => new Uint8Array(createHash('sha256').update(`synalla-life-benchmark-${p}`).digest());

const modelName = opt('--model', 'daily');
const outFile = opt('--out', join(HERE, '..', 'runs', `proactive_${modelName}.jsonl`));
mkdirSync(dirname(outFile), { recursive: true });
const done = new Set(existsSync(outFile) ? readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.type === 'done').map(r => r.person) : []);
const net = JSON.parse(readFileSync(join(OUT, 'network.json'), 'utf8'));
const entries = net.members.flatMap(m => m.entries);
const model = httpChatModel({ url: 'http://127.0.0.1:9090', model: modelName, schema: { name: 'wants', schema: WANTS_SCHEMA } });

for (const [pid, [owner, city]] of Object.entries(PEOPLE)) {
  if ((opt('--person') && pid !== opt('--person')) || done.has(pid) || !existsSync(join(OUT, pid, 'sessions'))) continue;
  const dir = join(WORK, pid);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const store = MemoryStore.open(join(dir, 'memory.db'), { key: keyFor(pid), dim: 1024 });
  try {
    const r = await importClaudeCode(store, new Map(), join(OUT, pid));
    if (r.failed.length) throw new Error(`${pid}: ${r.failed.length} sessions failed to import`);
    const proposed = new Set();
    const t0 = Date.now();
    for (let pending; (pending = store.pendingWantScan(1, { agentSessions: true })).length;) {
      const it = pending[0];
      const res = await scanWants(store, model, owner, { limit: 1, agentSessions: true });
      if (res.failed) log(`${pid} ${it.date.slice(0, 10)} wants scan FAILED`);
      const now = Math.floor(Date.parse(it.date) / 1000);
      for (const m of matchWants(store.openWants(), entries, now, { place: [city] })) {
        const w = store.openWants().find(x => x.wid === m.wid);
        for (const e of m.entries) {
          const k = `${m.wid}|${e.id}`;
          if (proposed.has(k)) continue;
          proposed.add(k);
          appendFileSync(outFile, JSON.stringify({ type: 'proposal', person: pid, date: it.date.slice(0, 10), wid: w.wid, what: w.what, topic: w.topic, confidence: w.confidence, entry: e.id }) + '\n');
        }
      }
    }
    const wants = store.allWants();
    for (const w of wants) appendFileSync(outFile, JSON.stringify({ type: 'want', person: pid, ...w }) + '\n');
    appendFileSync(outFile, JSON.stringify({ type: 'done', person: pid, items: r.imported.length, wants: wants.length, proposals: proposed.size, seconds: Math.round((Date.now() - t0) / 1000) }) + '\n');
    log(`${pid}: ${r.imported.length} sessions, ${wants.length} wants (${wants.filter(w => w.confidence >= 0.9).length} at >= 0.9), ${proposed.size} proposals, ${Math.round((Date.now() - t0) / 1000)} s`);
  } finally { store.close(); }
}
