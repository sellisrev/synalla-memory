"""Blind grading for the life-session benchmark (copied from benchmark/agent-sessions/harness/grade.py).

  python -I -X utf8 grade.py make <run dir> <arm> <arm> ...   -> <run dir>/grading_input.json + grading_key.json
  python -I -X utf8 grade.py local <run dir> [--model fast]   -> <run dir>/grades_local.json (a local model as one grader)
  python -I -X utf8 grade.py score <run dir> <grades file> [<grades file> ...]   -> <run dir>/RESULTS.md

Answers are read from <run dir>/answers_<arm>.jsonl. Each question's answers are shuffled under the letters X, Y, Z, ...
with a fixed seed, so a grader sees the question, the reference answer and the answers but not which system gave which.
Scores: 1 correct and complete; 0.5 partly correct or missing an asked-for part; 0 wrong, invented, or "not in memory"
when the answer exists. For type "none", 1 only if the answer says it is not in memory. A grades file is
{question id: {letter: score}}. Every disagreement between grades files of more than 0.5 is listed in RESULTS.md.
"""
import json, random, re, sys, urllib.request
from collections import defaultdict
from pathlib import Path

LETTERS = 'XYZWVUTS'
RULES = ('Grade each answer against the reference. 1 = correct and complete; 0.5 = partly correct or missing an asked-for '
         'part; 0 = wrong, invented, or "not in memory" when the reference has an answer. When the reference is "not in '
         'memory", 1 only if the answer says the information is not available. Extra detail that does not contradict the '
         'reference is fine. Dates may be written in any format.')


def load(run, arm):
    return {json.loads(l)['id']: json.loads(l) for l in open(run / f'answers_{arm}.jsonl', encoding='utf-8')}


def make(run, arms, questions):
    qs = json.load(open(questions, encoding='utf-8'))
    ans = {a: load(run, a) for a in arms}
    rnd = random.Random(20261125)
    items, key = [], {}
    for q in qs:
        if not all(q['id'] in ans[a] for a in arms):
            continue
        order = list(arms)
        rnd.shuffle(order)
        key[q['id']] = dict(zip(LETTERS, order))
        items.append({'id': q['id'], 'type': q['type'], 'question': q['question'], 'reference': q['gold'],
                      **{L: ans[a][q['id']]['answer'] for L, a in zip(LETTERS, order)}})
    json.dump({'rules': RULES, 'items': items}, open(run / 'grading_input.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    json.dump(key, open(run / 'grading_key.json', 'w', encoding='utf-8'), indent=1)
    print(f'{len(items)} questions, arms {arms}')


def local(run, model):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    import gpu_lock
    with gpu_lock.holding():
        _local(run, model, gpu_lock)


def _local(run, model, gpu_lock):
    data = json.load(open(run / 'grading_input.json', encoding='utf-8'))
    out = run / f'grades_local_{model}.json'
    grades = json.load(open(out, encoding='utf-8')) if out.exists() else {}
    for it in data['items']:
        if it['id'] in grades:
            continue
        gpu_lock.touch()
        letters = [L for L in LETTERS if L in it]
        prompt = (f"{data['rules']}\n\nQUESTION: {it['question']}\nREFERENCE: {it['reference']}\n\n"
                  + '\n'.join(f'ANSWER {L}: {it[L]}' for L in letters)
                  + '\n\nReply with JSON only, one score per answer, e.g. {' + ', '.join(f'"{L}": 1' for L in letters) + '}')
        body = json.dumps({'model': model, 'messages': [{'role': 'user', 'content': prompt}], 'max_tokens': 4000, 'temperature': 0,
                           'chat_template_kwargs': {'enable_thinking': False}}).encode()
        req = urllib.request.Request('http://127.0.0.1:9090/v1/chat/completions', data=body, headers={'content-type': 'application/json'})
        with urllib.request.urlopen(req, timeout=600) as r:
            text = json.load(r)['choices'][0]['message']['content']
        m = re.search(r'\{[^{}]*\}', text)
        g = json.loads(m.group(0)) if m else {}
        if sorted(g) != sorted(letters) or any(v not in (0, 0.5, 1) for v in g.values()):
            sys.exit(f'{it["id"]}: unreadable grade {text[:200]!r}')
        grades[it['id']] = g
        json.dump(grades, open(out, 'w', encoding='utf-8'), indent=1)
        print(it['id'], g, file=sys.stderr)


def score(run, files, questions):
    qs = {q['id']: q for q in json.load(open(questions, encoding='utf-8'))}
    key = json.load(open(run / 'grading_key.json', encoding='utf-8'))
    graders = {Path(f).stem: json.load(open(f, encoding='utf-8')) for f in files}
    arms = sorted({a for k in key.values() for a in k.values()})
    tot = {g: defaultdict(float) for g in graders}
    by_type = {g: defaultdict(lambda: defaultdict(float)) for g in graders}
    n_type = defaultdict(int)
    disagreements = []
    for qid, k in key.items():
        n_type[qs[qid]['type']] += 1
        for L, arm in k.items():
            vals = {}
            for g, gr in graders.items():
                v = gr[qid][L]
                tot[g][arm] += v
                by_type[g][qs[qid]['type']][arm] += v
                vals[g] = v
            if len(vals) > 1 and max(vals.values()) - min(vals.values()) > 0.5:
                disagreements.append((qid, arm, vals))
    n = len(key)
    lines = ['# Agent-session benchmark: results', '', f'{n} questions. Scores in % (1 / 0.5 / 0 per answer).', '',
             '| Grader | ' + ' | '.join(arms) + ' |', '|---|' + '---:|' * len(arms)]
    for g in graders:
        lines.append(f'| {g} | ' + ' | '.join(f'{100 * tot[g][a] / n:.0f}' for a in arms) + ' |')
    lines += ['', '## By question type (first grader, then the others)', '', '| Type | n | ' + ' | '.join(arms) + ' |', '|---|---:|' + '---:|' * len(arms)]
    for t in sorted(n_type):
        cells = ['/'.join(f'{100 * by_type[g][t][a] / n_type[t]:.0f}' for g in graders) for a in arms]
        lines.append(f'| {t} | {n_type[t]} | ' + ' | '.join(cells) + ' |')
    lines += ['', f'## Disagreements over 0.5 ({len(disagreements)})', '']
    lines += [f'- {qid} {arm}: {vals}' for qid, arm, vals in disagreements]
    (run / 'RESULTS.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print('\n'.join(lines[:8 + len(graders)]))


if __name__ == '__main__':
    cmd, run = sys.argv[1], Path(sys.argv[2])
    questions = Path(__file__).resolve().parent.parent / 'out' / 'questions.json'  # life sessions: generated from the truth
    if '--questions' in sys.argv:
        questions = Path(sys.argv[sys.argv.index('--questions') + 1])
    rest = [a for a in sys.argv[3:] if not a.startswith('--') and a != str(questions)]
    if cmd == 'make':
        make(run, rest, questions)
    elif cmd == 'local':
        local(run, sys.argv[sys.argv.index('--model') + 1] if '--model' in sys.argv else 'fast')
    elif cmd == 'score':
        score(run, rest, questions)
