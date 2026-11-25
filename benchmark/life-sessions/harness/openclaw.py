"""Life-session benchmark harness (copied from benchmark/agent-sessions/harness) for OpenClaw's built-in memory (memory-core; arm O).

  python -I -X utf8 openclaw.py build
  python -I -X utf8 openclaw.py answer --questions <file> --out <file> [--only id,id] [--limit N]

build: per persona, a workspace whose daily notes (memory/YYYY-MM-DD.md, where OpenClaw keeps detailed dated context)
hold each session of that day as one section: a "## [date] title" heading, then the conversation (user and assistant
turns, tool calls and results as text), as if the agent had logged its sessions there. MEMORY.md starts empty. The
notes are indexed once with `openclaw memory index` (hybrid BM25 + vectors, recency decay) into a pristine state dir.
answer: memory_search and memory_get only, shown directly (best case), the same embedder as Synalla
(Qwen3-Embedding-0.6B at :5941 with its query instruction), the local `daily` model, temperature 0.2, max tokens 8000,
600 s per question (hard kill at 660 s, counted as a timeout and graded wrong). The answer rules are in AGENTS.md,
which OpenClaw injects. Before every question the persona's state dir is replaced by its pristine copy.
"""
import argparse, json, os, shutil, subprocess, sys, time
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
SET = os.environ.get('LIFE_SET', 'test')  # dev: the tuning people, kept apart
OUT = HERE.parent / ('out' if SET == 'test' else 'out_dev')
WORK = HERE.parent / 'work' / 'openclaw' if SET == 'test' else HERE.parent / 'work' / ('openclaw_dev')
OPENCLAW = Path(r'C:\AI\tools\openclaw-runtime\node_modules\openclaw\openclaw.mjs')
TODAY = '2026-04-13'
PERSONAS = [f'L{i:02d}' for i in range(1, 11)] if SET == 'test' else ['D01', 'D02']

AGENTS = f"""# Rules

Today is {TODAY}, whatever the system clock says.
You are the personal assistant of the owner of this OpenClaw install.
Your past sessions with the owner (conversations about work and everyday life over the past weeks) are logged in your daily memory notes
(memory/YYYY-MM-DD.md, one section per session, dated). Use memory_search to look things up and memory_get to read more
of a note.
Answer the owner's question using only what you find in those notes.
If the notes do not contain the answer, reply exactly: not in memory.
When something changed over time, give the latest value unless the question asks about the past.
Be brief: one or two sentences.
"""


def config(ws):
    return json.dumps({
        'models': {'providers': {'llamaswap': {
            'baseUrl': 'http://127.0.0.1:9090/v1', 'apiKey': 'local', 'api': 'openai-completions', 'request': {'allowPrivateNetwork': True},
            'models': [{'id': 'daily', 'name': 'daily', 'api': 'openai-completions', 'reasoning': True, 'input': ['text'],
                        'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}, 'contextWindow': 262144, 'maxTokens': 8000}]}}},
        'agents': {'defaults': {'workspace': str(ws).replace('\\', '/'), 'model': {'primary': 'llamaswap/daily'},
                                'models': {'llamaswap/daily': {'params': {'temperature': 0.2}}}}},
        'tools': {'allow': ['memory_search', 'memory_get'], 'toolSearch': False},
        'memory': {'search': {'provider': 'openai-compatible', 'model': 'embed', 'remote': {'baseUrl': 'http://127.0.0.1:5941/v1', 'apiKey': 'local'},
                              'queryInstruction': "Instruct: Given a question about a person's life, retrieve passages from their emails, notes and documents that answer it\nQuery: ",
                              'sources': ['memory']}},
        'plugins': {'entries': {'memory-core': {'config': {'dreaming': {'enabled': False}}}}},
    }, indent=1)


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


def section(path):
    title, day, turns = '', None, []
    for line in open(path, encoding='utf-8'):
        e = json.loads(line)
        if e.get('type') == 'ai-title':
            title = e.get('aiTitle', '')
            continue
        if e.get('type') not in ('user', 'assistant') or e.get('isSidechain'):
            continue
        day = day or e['timestamp'][:10]
        text = block_text(e['message'].get('content')).strip()
        if text:
            # a '#' at line start would open a new heading; indent it so a session never splits
            text = '\n'.join((' ' + l) if l.startswith('#') else l for l in text.splitlines())
            turns.append(f"**{e['message']['role']}** ({e['timestamp'][11:16]}): {text}")
    return day, f'## [{day}] {title or "session"} (#{path.stem})\n\n' + '\n\n'.join(turns) + '\n'


def env_for(p, state):
    env = {k: v for k, v in os.environ.items()
           if not (k.endswith('_API_KEY') or k.endswith('_BASE_URL') or k.startswith(('OPENROUTER', 'ANTHROPIC', 'OPENAI', 'GOOGLE', 'GEMINI', 'OPENCLAW')))}
    env['OPENCLAW_STATE_DIR'] = str(state)
    env['OPENCLAW_CONFIG_PATH'] = str(WORK / p / 'openclaw.json5')
    return env


def build():
    for p in PERSONAS:
        root = WORK / p
        if (root / 'state_pristine').exists():
            print(f'{p}: exists, skipped', file=sys.stderr)
            continue
        ws = root / 'workspace'
        (ws / 'memory').mkdir(parents=True, exist_ok=True)
        days = defaultdict(list)
        for f in sorted((OUT / p / 'sessions').glob('*.jsonl')):
            d, s = section(f)
            days[d].append(s)
        for d, parts in days.items():
            (ws / 'memory' / f'{d}.md').write_text(f'# {d}\n\n' + '\n'.join(parts), encoding='utf-8', newline='\n')
        (ws / 'MEMORY.md').write_text('# Memory\n', encoding='utf-8')
        (ws / 'AGENTS.md').write_text(AGENTS, encoding='utf-8')
        (root / 'openclaw.json5').write_text(config(ws), encoding='utf-8')
        r = subprocess.run(['node', str(OPENCLAW), 'memory', 'index', '--agent', 'main'], env=env_for(p, root / 'state_pristine'),
                           capture_output=True, text=True, encoding='utf-8', timeout=1800)
        if r.returncode != 0:
            sys.exit(f'{p}: memory index failed: {r.stderr[-800:]}')
        print(f'{p}: {sum(len(v) for v in days.values())} sessions in {len(days)} daily notes, indexed', file=sys.stderr)


def kill_stray():
    ps = ("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'openclaw\\.mjs' } "
          "| ForEach-Object { taskkill /F /T /PID $_.ProcessId | Out-Null }")
    subprocess.run(['powershell', '-NoProfile', '-Command', ps], capture_output=True)


def reset(p):
    kill_stray()
    work, pristine = WORK / p / 'state_work', WORK / p / 'state_pristine'
    if work.exists():
        for _ in range(30):
            try:
                work.rename(work.with_name(f'state_trash_{time.time_ns()}'))
                break
            except OSError:
                time.sleep(2)
        else:
            sys.exit(f'{work} could not be moved aside after 60 s: stopping (isolation needs a fresh state)')
    for old in work.parent.glob('state_trash_*'):
        shutil.rmtree(old, ignore_errors=True)
    shutil.copytree(pristine, work)
    return work


def answer(a):
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
            p = q['person']
            state = reset(p)
            t0 = time.time()
            cmd = ['node', str(OPENCLAW), 'agent', 'exec', '--config', str(WORK / p / 'openclaw.json5'), '--state-dir', str(state),
                   '--cwd', str(WORK / p / 'workspace'), '--code-mode', 'direct', '--json', '--timeout', '600', '--message-file', '-']
            res, err = {}, None
            proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', env=env_for(p, state))
            try:
                stdout, stderr = proc.communicate(q['question'], timeout=660)
            except subprocess.TimeoutExpired:
                subprocess.run(['taskkill', '/F', '/T', '/PID', str(proc.pid)], capture_output=True)
                try:
                    stdout, stderr = proc.communicate(timeout=30)
                except subprocess.TimeoutExpired:
                    stdout, stderr = '', ''
                err = 'status timeout: killed by runner after 660 s'
            if err is None:
                try:
                    s = stdout.strip()
                    res = json.loads(s[s.index('{'):])
                except Exception:
                    err = f'exit {proc.returncode}; stdout {stdout[-300:]!r}; stderr {stderr[-500:]!r}'
            text = (res.get('final') or '').strip()
            if res and res.get('status') != 'ok':
                err = f"status {res.get('status')}: {json.dumps(res.get('error'))[:300]}"
            if '????????' in text:
                sys.exit(f'garbage output on {q["id"]}')
            if res.get('model') not in (None, 'daily'):
                sys.exit(f'unexpected model {res.get("model")} on {q["id"]}: stopping')
            row = {'id': q['id'], 'arm': 'O', 'answer': text or '(no answer)', 'seconds': round(time.time() - t0, 1),
                   'usage': res.get('usage'), 'assistantTurns': res.get('assistantTurns'), 'toolSummary': res.get('toolSummary'), 'error': err}
            f.write(json.dumps(row, ensure_ascii=False) + '\n')
            f.flush()
            new += 1
            print(q['id'], 'O', row['seconds'], 's:', row['answer'][:100].replace('\n', ' '), err or '', file=sys.stderr, flush=True)
    kill_stray()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['build', 'answer'])
    ap.add_argument('--questions')
    ap.add_argument('--out')
    ap.add_argument('--only', default='')
    ap.add_argument('--limit', type=int, default=0)
    a = ap.parse_args()
    build() if a.cmd == 'build' else answer(a)


if __name__ == '__main__':
    main()
