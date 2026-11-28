"""One injection-test run with Hermes Agent as the agent (README.md, second agent family).

Run with the Hermes venv python from the Hermes source checkout (it imports Hermes' own code):
  <hermes python> -X utf8 hermes_one.py --memory-home <synalla home> --question "<q>" --case A|B --cwd <dir> --out <result.json>

A fresh Hermes home per run, with the Synalla memory MCP server as its only memory (toolset mcp-synalla) and, in
case B, Hermes' terminal toolset. Model: the local `daily` (llama-swap), temperature 0.2, 12 steps, 300 s.
Writes the tool calls (name, arguments, result head) and the final answer as JSON, in the shape run.mjs scores.
"""
import argparse, json, os, shutil, sys, tempfile, time
from pathlib import Path

BASE = os.environ.get('HERMES_MODEL_URL', 'http://127.0.0.1:9090/v1')  # another server than llama-swap when it is busy
CONFIG = """model:
  provider: custom
  default: daily
  base_url: {base}
  api_mode: chat_completions
memory:
  write_approval: false
auxiliary:
  background_review:
    enabled: false
  title_generation:
    enabled: false
tools:
  tool_search:
    enabled: "off"
mcp_servers:
  synalla:
    command: {node}
    args: [{bin}, serve]
    env:
      SYNALLA_MEMORY_HOME: {home}
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--memory-home', required=True)
    ap.add_argument('--question', required=True)
    ap.add_argument('--case', choices=['A', 'B'], required=True)
    ap.add_argument('--cwd', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--system', required=True)
    ap.add_argument('--node', required=True)
    ap.add_argument('--bin', required=True)
    a = ap.parse_args()
    for k in list(os.environ):
        if k.endswith('_API_KEY') or k.endswith('_BASE_URL') or k.startswith(('OPENROUTER', 'ANTHROPIC', 'OPENAI', 'NOUS', 'HONCHO', 'GOOGLE', 'GEMINI')):
            del os.environ[k]
    home = Path(tempfile.mkdtemp(prefix='hermes-inj-'))
    q = lambda p: json.dumps(str(p))  # YAML accepts JSON strings
    (home / 'config.yaml').write_text(CONFIG.format(node=q(a.node), bin=q(a.bin), home=q(a.memory_home), base=BASE), encoding='utf-8')
    os.environ['HERMES_HOME'] = str(home)
    from tools.mcp_tool_discovery import discover_mcp_tools
    from run_agent import AIAgent
    t0 = time.time()
    names = discover_mcp_tools()
    toolsets = ['mcp-synalla'] + (['terminal'] if a.case == 'B' else [])
    agent = AIAgent(base_url=BASE, api_key='local', provider='custom', api_mode='chat_completions', model='daily',
                    enabled_toolsets=toolsets, skip_context_files=True, skip_background_review=True, quiet_mode=True,
                    ephemeral_system_prompt=a.system, max_iterations=12, run_budget_seconds=300, max_tokens=4000,
                    request_overrides={'temperature': 0.2}, cwd=a.cwd, platform='cli')
    err = None
    try:
        res = agent.run_conversation(a.question)
    except Exception as e:  # counted, never silently passed
        res, err = {}, f'{type(e).__name__}: {e}'
    calls, results = [], {}
    for m in res.get('messages') or []:
        if not isinstance(m, dict):
            continue
        for c in m.get('tool_calls') or []:
            fn = c.get('function', {})
            try:
                args = json.loads(fn.get('arguments') or '{}')
            except Exception:
                args = {'raw': fn.get('arguments')}
            calls.append({'id': c.get('id'), 'name': fn.get('name'), 'input': args})
        if m.get('role') == 'tool':
            results[m.get('tool_call_id')] = str(m.get('content'))[:400]
    for c in calls:
        c['result'] = {'error': False, 'text': results.get(c['id'], '')}
    out = {'answer': (res.get('final_response') or '').strip(), 'calls': calls, 'secs': round(time.time() - t0, 1), 'error': err,
           'mcp_tools': names}
    Path(a.out).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding='utf-8')
    try:
        agent.close()
    except Exception:
        pass
    shutil.rmtree(home, ignore_errors=True)
    print(json.dumps({'secs': out['secs'], 'calls': [c['name'] for c in calls], 'error': err}))


if __name__ == '__main__':
    main()
