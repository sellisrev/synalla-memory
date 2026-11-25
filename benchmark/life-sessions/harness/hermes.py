"""Life-session benchmark harness (copied from benchmark/agent-sessions/harness) for Hermes Agent's built-in memory (arm H).

Run with the Hermes venv python, from the Hermes source checkout (it imports Hermes' own code):
  <hermes python> -X utf8 hermes.py build             one pristine Hermes home per persona (no model calls)
  <hermes python> -X utf8 hermes.py answer --questions <file> --out <file> [--only id,id] [--limit N] [--shipped]

build: every Claude Code session of a persona becomes one Hermes session with its own turns (user and assistant
messages, tool calls and results as text), dated as in the transcript, imported through Hermes' own
maintenance.import_sessions. This is how the sessions would sit in Hermes had the persona worked in Hermes.
answer: Hermes' memory as shipped (session_search FTS5 + the memory tool, notes empty), session_search offered directly
(best case; --shipped keeps v0.23.3's tool_search deferral), the local `daily` model, temperature 0.2, max tokens 8000,
15 steps and 600 s per question, the same answer rules as the Synalla arms. Before every question the persona's work
home is replaced by its pristine copy, and the session count is checked.
"""
import argparse, gc, json, os, shutil, sqlite3, sys, time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
SET = os.environ.get('LIFE_SET', 'test')  # dev: the tuning people, kept apart
OUT = HERE.parent / ('out' if SET == 'test' else 'out_dev')
WORK = HERE.parent / 'work' / 'hermes' if SET == 'test' else HERE.parent / 'work' / ('hermes_dev')
TODAY = '2026-04-13'
LLM_BASE, LLM_MODEL = 'http://127.0.0.1:9090/v1', 'daily'
PERSONAS = [f'L{i:02d}' for i in range(1, 11)] if SET == 'test' else ['D01', 'D02']

CONFIG = """model:
  provider: custom
  default: daily
  base_url: http://127.0.0.1:9090/v1
  api_mode: chat_completions
memory:
  write_approval: false
auxiliary:
  background_review:
    enabled: false
  title_generation:
    enabled: false
"""
EAGER = 'tools:\n  tool_search:\n    enabled: "off"\n'

SYSTEM = f"""Today is {TODAY}. You are the personal assistant of the owner of this Hermes install.
Your past sessions with the owner (conversations about work and everyday life over the past weeks, one session per conversation, dated)
are stored in your session history. Use session_search to look things up.
Answer the owner's question using only what you find in those sessions.
If the sessions do not contain the answer, reply exactly: not in memory.
When something changed over time, give the latest value unless the question asks about the past.
Be brief: one or two sentences."""


def epoch(ts):
    return datetime.fromisoformat(ts.replace('Z', '+00:00')).astimezone(timezone.utc).timestamp()


def block_text(c):
    if isinstance(c, str):
        return c
    out = []
    for b in c or []:
        t = b.get('type')
        if t == 'text':
            out.append(b.get('text', ''))
        elif t == 'tool_use':
            out.append(f"[tool call {b.get('name')}] {json.dumps(b.get('input'), ensure_ascii=False)}")
        elif t == 'tool_result':
            r = b.get('content')
            out.append('[tool result] ' + (r if isinstance(r, str) else ' '.join(x.get('text', '') for x in r or [] if isinstance(x, dict))))
    return '\n'.join(out)


def session(path):
    title, msgs, sid = '', [], None
    for line in open(path, encoding='utf-8'):
        e = json.loads(line)
        if e.get('type') == 'ai-title':
            title = e.get('aiTitle', '')
            continue
        if e.get('type') not in ('user', 'assistant') or e.get('isSidechain'):
            continue
        sid = sid or e['sessionId']
        text = block_text(e['message'].get('content')).strip()
        if text:
            msgs.append({'role': e['message']['role'], 'content': text, 'timestamp': epoch(e['timestamp'])})
    day = datetime.fromtimestamp(msgs[0]['timestamp'], timezone.utc).strftime('%Y-%m-%d')
    return {'id': 'cc_' + sid.replace('-', '_'), 'source': 'import', 'title': f'[{day}] {title or "session"} (#{path.stem})',  # titles must be unique
            'started_at': msgs[0]['timestamp'], 'ended_at': msgs[-1]['timestamp'], 'messages': msgs}


def build():
    from persistence_assembly import close_all_stores, open_persistence, profile_scope
    for p in PERSONAS:
        home = WORK / p / 'pristine'
        if (home / 'state.db').exists():
            print(f'{p}: exists, skipped', file=sys.stderr)
            continue
        home.mkdir(parents=True, exist_ok=True)
        (home / 'config.yaml').write_text(CONFIG, encoding='utf-8')
        (home / 'memories').mkdir(exist_ok=True)
        os.environ['HERMES_HOME'] = str(home)
        store = open_persistence(profile_scope(home=home), eager=True)
        batch = [session(f) for f in sorted((OUT / p / 'sessions').glob('*.jsonl'))]
        r = store.maintenance.import_sessions(batch)
        if not r.ok:
            sys.exit(f'{p}: import refused: {list(r.errors)[:3]}')
        store.close()
        close_all_stores()
        print(f'{p}: {r.imported} sessions imported (skipped {r.skipped})', file=sys.stderr)


def count(db_path):
    with sqlite3.connect(db_path) as db:
        return db.execute('SELECT count(*) FROM sessions').fetchone()[0]


def reset(p, close_all_stores, shipped):
    close_all_stores()
    pristine, work = WORK / p / 'pristine', WORK / p / 'work'
    work.mkdir(parents=True, exist_ok=True)
    for f in work.glob('state.db*'):
        for _ in range(30):  # Windows: a Hermes handle can outlive the agent for a moment
            try:
                f.unlink()
                break
            except PermissionError:
                gc.collect()
                close_all_stores()
                time.sleep(2)
        else:
            sys.exit(f'{f} still locked after 60 s: stopping (isolation needs a fresh store)')
    shutil.copy2(pristine / 'state.db', work / 'state.db')
    cfg = CONFIG + ('' if shipped else EAGER)
    (work / 'config.yaml').write_text(cfg, encoding='utf-8')
    shutil.rmtree(work / 'memories', ignore_errors=True)
    (work / 'memories').mkdir()
    os.environ['HERMES_HOME'] = str(work)
    return work, count(work / 'state.db'), count(pristine / 'state.db')


def tool_calls(messages):
    calls = []
    for m in messages or []:
        for c in (m.get('tool_calls') or []) if isinstance(m, dict) else []:
            fn = c.get('function', {}) if isinstance(c, dict) else {}
            calls.append({'name': fn.get('name'), 'args': (fn.get('arguments') or '')[:300]})
    return calls


def isolate_env():
    for k in list(os.environ):
        if k.endswith('_API_KEY') or k.endswith('_BASE_URL') or k.startswith(('OPENROUTER', 'ANTHROPIC', 'OPENAI', 'NOUS', 'HONCHO', 'GOOGLE', 'GEMINI')):
            del os.environ[k]


def answer(a):
    from persistence_assembly import close_all_stores
    from run_agent import AIAgent
    out = Path(a.out)
    done = {json.loads(l)['id'] for l in open(out, encoding='utf-8')} if out.exists() else set()
    only = set(filter(None, a.only.split(',')))
    new = 0
    with open(out, 'a', encoding='utf-8') as f:
        for q in json.load(open(a.questions, encoding='utf-8')):
            if (only and q['id'] not in only) or q['id'] in done:
                continue
            if a.limit and new >= a.limit:
                break
            work, have, want = reset(q['person'], close_all_stores, a.shipped)
            if have != want:
                sys.exit(f'{q["person"]} work home has {have} sessions, pristine has {want}: isolation broken, stopping')
            t0 = time.time()
            agent = AIAgent(base_url=LLM_BASE, api_key='local', provider='custom', api_mode='chat_completions', model=LLM_MODEL,
                            enabled_toolsets=['session_search', 'memory'], skip_context_files=True, skip_background_review=True,
                            quiet_mode=True, ephemeral_system_prompt=SYSTEM, max_iterations=15, run_budget_seconds=600,
                            max_tokens=8000, request_overrides={'temperature': 0.2}, cwd=str(work), platform='cli')
            try:
                res = agent.run_conversation(q['question'])
                text, err = (res.get('final_response') or '').strip(), None
            except Exception as e:  # graded as wrong
                res, text, err = {}, '', f'{type(e).__name__}: {e}'
            if '????????' in text:
                sys.exit(f'garbage output on {q["id"]}')
            usage = {k: getattr(agent, k) for k in ('session_prompt_tokens', 'session_completion_tokens', 'session_total_tokens') if hasattr(agent, k)}
            row = {'id': q['id'], 'arm': 'Hs' if a.shipped else 'H', 'answer': text or '(no answer)', 'seconds': round(time.time() - t0, 1),
                   'usage': usage, 'tools': tool_calls(res.get('messages')), 'error': err}
            try:
                agent.close()
            except Exception:
                pass
            del agent, res
            gc.collect()
            f.write(json.dumps(row, ensure_ascii=False) + '\n')
            f.flush()
            new += 1
            print(q['id'], row['arm'], row['seconds'], 's', len(row['tools']), 'calls:', row['answer'][:100].replace('\n', ' '), err or '', file=sys.stderr, flush=True)
    close_all_stores()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['build', 'answer'])
    ap.add_argument('--questions')
    ap.add_argument('--out')
    ap.add_argument('--only', default='')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--shipped', action='store_true')
    a = ap.parse_args()
    isolate_env()
    build() if a.cmd == 'build' else answer(a)


if __name__ == '__main__':
    main()
