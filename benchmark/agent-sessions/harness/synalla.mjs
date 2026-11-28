// Agent-session benchmark harness for Synalla memory (the package's own code, through its MCP recall tool).
//
//   node --import ./tools/ts-resolve.mjs benchmark/agent-sessions/harness/synalla.mjs build [--persona P1] [--no-facts]
//   node --import ./tools/ts-resolve.mjs benchmark/agent-sessions/harness/synalla.mjs answer --arm A|D --questions <file> --out <file> [--only id,id]
//
// build: one encrypted store per persona in work/synalla/<P>, sessions imported with the Claude Code importer,
// passages embedded (Qwen3-Embedding-0.6B at :5941, the model the package pins), facts extracted by the local `daily`
// model with --agent-sessions (the sessions are the persona's own records here), then fact vectors.
// answer: arm A = passages only (the shipped default reads no facts from agent sessions); arm D = passages + facts.
// The answer prompt and model settings are those of agent-network/experiments/memory_ab/answer.py.
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { MemoryStore } from '../../../src/store.ts';
import { importClaudeCode } from '../../../src/import_claude_code.ts';
import { httpEmbedder } from '../../../src/embed.ts';
import { httpChatModel, extractPending } from '../../../src/facts.ts';
import { McpServer } from '../../../src/mcp.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'out');
const WORK = join(HERE, '..', 'work', process.env.SYNALLA_WORK ?? 'synalla'); // v2 stores: synalla_v2
const LLM = process.env.SYNALLA_LLM ?? 'http://127.0.0.1:9090'; // another daily server when llama-swap is busy
const TODAY = '2026-04-13'; // the day after the last simulated week
const OWNERS = { P1: 'Maya Okafor', P2: 'Jonas Weber', P3: 'Priya Raman', P4: 'Luca Bianchi', P5: 'Sofia Lindqvist', P6: 'Daniel Mensah', P7: 'Hana Kobayashi', P8: 'Marc Dubois' };
const DIM = 1024;
// synthetic data only: a fixed, published key per persona so anyone can open the stores
const keyFor = p => new Uint8Array(createHash('sha256').update(`synalla-benchmark-${p}`).digest());

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
const log = s => process.stderr.write(`${new Date().toISOString()} ${s}\n`);
const embedder = httpEmbedder({ url: 'http://127.0.0.1:5941', dim: DIM });
const open = p => { mkdirSync(join(WORK, p), { recursive: true }); return MemoryStore.open(join(WORK, p, 'memory.db'), { key: keyFor(p), dim: DIM }); };

async function embedAll(store) {
  let n = 0;
  for (let m; (m = store.missingVectors(128)).length;) {
    const v = await embedder.embed(m.map(x => x.text), 'passage');
    store.setVectors(m.map((x, i) => ({ cid: x.cid, vec: v[i] })));
    n += m.length;
  }
  for (let m; (m = store.missingFactVectors(128)).length;) {
    const v = await embedder.embed(m.map(x => x.text), 'passage');
    store.setFactVectors(m.map((x, i) => ({ fid: x.fid, vec: v[i] })));
    n += m.length;
  }
  return n;
}

async function build() {
  const only = opt('--persona');
  for (const p of Object.keys(OWNERS)) {
    if (only && p !== only) continue;
    const store = open(p);
    try {
      const r = await importClaudeCode(store, new Map(), join(OUT, p));
      if (r.failed.length) throw new Error(`${p}: ${r.failed.length} sessions failed to import: ${r.failed[0].error}`);
      log(`${p} imported ${r.imported.length}, embedded ${await embedAll(store)}`);
      if (args.includes('--no-facts')) continue;
      const model = httpChatModel({ url: LLM, model: 'daily' });
      const t0 = Date.now();
      const res = await extractPending(store, model, OWNERS[p], { limit: 1000, agentSessions: true,
        onItem: (id, kept, dropped, err) => log(`${p} facts ${id.slice(-12)} kept ${kept} dropped ${dropped}${err ? ' ERROR ' + err.slice(0, 120) : ''}`) });
      log(`${p} extraction: ${res.items} items, ${res.facts} facts, ${res.failed} failed, ${Math.round((Date.now() - t0) / 1000)} s; embedded ${await embedAll(store)}`);
      if (res.failed > 0) throw new Error(`${p}: ${res.failed} items failed extraction`);
    } finally { store.close(); }
  }
}

function prompt(q, passages, facts) {
  const parts = [`Today is ${TODAY}. Answer the question about the owner of these records, using only what is below.`,
    'If the records do not contain the answer, reply exactly: not in memory.',
    'When something changed over time, give the latest value unless the question asks about the past. Be brief: one or two sentences.', '',
    'RECORDS (each starts with its date and source):'];
  passages.forEach((p, i) => parts.push(`--- ${i + 1}\n${p.text}`));
  if (facts.length) parts.push('', 'FACTS EXTRACTED FROM THE RECORDS (automatic hints; they can be wrong. When a fact and a record disagree, trust the record):', ...facts.map(f => f.line));
  parts.push('', `QUESTION: ${q}`);
  return parts.join('\n');
}

async function answer() {
  const arm = opt('--arm'), qfile = opt('--questions'), out = opt('--out');
  if (!['A', 'D'].includes(arm) || !qfile || !out) throw new Error('usage: answer --arm A|D --questions <file> --out <file>');
  const only = new Set((opt('--only', '') || '').split(',').filter(Boolean));
  const done = new Set(existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).id) : []);
  const qs = JSON.parse(readFileSync(qfile, 'utf8'));
  const stores = {};
  try {
    for (const q of qs) {
      if ((only.size && !only.has(q.id)) || done.has(q.id)) continue;
      const store = stores[q.persona] ??= open(q.persona);
      const t0 = Date.now();
      const mcp = new McpServer(store, { embedder });
      const r = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'recall', arguments: { question: q.question } } });
      const { passages, facts } = r.result.structuredContent;
      const useFacts = arm === 'D' ? facts : [];
      const res = await fetch(`${LLM}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'daily', messages: [{ role: 'user', content: prompt(q.question, passages, useFacts) }], max_tokens: 8000, temperature: 0.2 }),
        signal: AbortSignal.timeout(900_000) });
      if (!res.ok) throw new Error(`answering model answered ${res.status}`);
      const body = await res.json();
      const text = (body.choices?.[0]?.message?.content ?? '').trim();
      if (text.includes('????????')) throw new Error(`garbage output on ${q.id}`);
      const row = { id: q.id, arm, answer: text, passages: passages.map(p => p.item), facts: useFacts.length, seconds: Math.round((Date.now() - t0) / 100) / 10, usage: body.usage ?? {} };
      appendFileSync(out, JSON.stringify(row) + '\n');
      log(`${q.id} ${arm} ${row.seconds} s: ${text.slice(0, 100).replace(/\n/g, ' ')}`);
    }
  } finally { for (const s of Object.values(stores)) s.close(); }
}

const cmd = args[0];
(cmd === 'build' ? build() : cmd === 'answer' ? answer() : Promise.reject(new Error('build | answer')))
  .then(() => process.exit(0), e => { log(`FAILED ${e.stack ?? e}`); process.exit(1); });
