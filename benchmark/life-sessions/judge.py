"""Consistency judge for the life sessions: a model of another family (Gemma, `fast`) reads each written session
against the person's storylines and rejects the session if it contradicts them or says something before its day.

  python -I -X utf8 judge.py [--url http://127.0.0.1:9090] [--model fast] [--only L01]

The string checks in generate.py catch wrong or early values; this catches what they cannot: invented details that
clash in meaning ("her piano lesson at 5:30" when she is still looking for a piano teacher), a plan told as done, a
look-alike fact told as the person's own. A rejected session is deleted and recorded in checks.json, so the next
generate.py run writes it again with another seed. Verdicts per session file (by content hash) in judged.json.
A problem counts only if its quote is really in the session.
"""
import argparse, hashlib, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import generate as G  # noqa: E402

SCHEMA = {'type': 'object', 'additionalProperties': False, 'required': ['problems'], 'properties': {'problems': {
    'type': 'array', 'items': {'type': 'object', 'additionalProperties': False, 'required': ['quote', 'fact', 'why'],
        'properties': {'quote': {'type': 'string'}, 'fact': {'type': 'string'}, 'why': {'type': 'string'}}}}}}


def story_lines(stories, name):
    """Every storyline as plain sentences with the day each part becomes known."""
    out = []
    for s in stories:
        for d, text, _ in G.steps_of(s, name):
            out.append(f"- [{s['id']}, from {G.day(d)}] {text}")
    return '\n'.join(sorted(out, key=lambda l: l.split('from ')[1][:10]))


def text_of(path):
    rows = []
    for line in open(path, encoding='utf-8'):
        e = json.loads(line)
        if e.get('type') in ('user', 'assistant'):
            c = e['message']['content']
            rows.append(f"{e['type'].upper()}: {c if isinstance(c, str) else c[0]['text']}")
    return '\n'.join(rows)


def judge(a, name, bio, stories, x, text):
    own = ', '.join(sorted({st['story'] for st in x['steps']})) or 'none'
    prompt = f"""You check a synthetic conversation for consistency. It is between {name} ({bio}) and their AI agent on
{x['date']}. Below is everything that is true about {name} over six weeks, each with the date from which it is known.

FACTS
{story_lines(stories, name)}

This conversation is meant to carry these storylines: {own}.

List every statement in the conversation that
1. contradicts a fact (a different value, a different person, something only considered or imagined told as done,
   someone else's thing told as {name}'s own, a need told as already solved, or solved told as still open); or
2. mentions a fact, or a detail of it, dated after {x['date']} (unless it belongs to the storylines this conversation carries).
Ordinary details that do not touch these facts are fine (meals, errands, patients, clients, weather), and so is an
extra detail about a known thing that does not conflict with any fact (a price for an insurance whose provider is
known, a time for a meeting whose day is known). It is a problem only if it cannot be true together with a fact (a
lesson with a teacher they are still looking for, a different provider, a different time for the same shift).
For each problem give the exact quote from the conversation (copied word for word), the fact id, and why.
Return {{"problems": []}} if there is none.

CONVERSATION
{text}"""
    return G.post(a, prompt, SCHEMA, G.num('judge', x['date'], len(text)) % 100000, 3000)['problems']


def norm(s):
    return ' '.join(s.lower().split())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', default='http://127.0.0.1:9090')
    ap.add_argument('--model', default='fast')
    ap.add_argument('--only', default='')
    a = ap.parse_args()
    total = rejected = 0
    for pid, name, bio, work in G.PEOPLE:
        if a.only and pid not in a.only.split(','):
            continue
        root = os.path.join(G.OUT, pid)
        if not os.path.exists(os.path.join(root, 'index.json')):
            continue
        stories = json.load(open(os.path.join(root, 'storylines.json'), encoding='utf-8'))
        sessions = json.load(open(os.path.join(root, 'index.json'), encoding='utf-8'))
        jp, cp = os.path.join(root, 'judged.json'), os.path.join(root, 'checks.json')
        judged = json.load(open(jp, encoding='utf-8')) if os.path.exists(jp) else {}
        checks = json.load(open(cp, encoding='utf-8')) if os.path.exists(cp) else {}
        for x in sessions:
            path = os.path.join(root, 'sessions', f"{x['n']:03d}.jsonl")
            if not os.path.exists(path):
                continue
            h = hashlib.sha256(open(path, 'rb').read()).hexdigest()[:16]
            if judged.get(str(x['n']), {}).get('hash') == h:
                continue
            text = text_of(path)
            probs = [p for p in judge(a, name, bio, stories, x, text) if norm(p['quote']) and norm(p['quote'])[:60] in norm(text)]
            total += 1
            judged[str(x['n'])] = {'hash': h, 'problems': probs}
            if probs:
                rejected += 1
                checks.setdefault(str(x['n']), []).append([f"judge: {p['fact']}: {p['quote'][:120]} ({p['why'][:120]})" for p in probs])
                os.remove(path)
                del judged[str(x['n'])]
                print(f"{pid} session {x['n']} REJECTED by judge: {[(p['fact'], p['quote'][:80]) for p in probs][:2]}", flush=True)
            else:
                print(f"{pid} session {x['n']} ok", flush=True)
            json.dump(judged, open(jp, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
            json.dump(checks, open(cp, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'JUDGE DONE: {total} judged, {rejected} rejected', flush=True)


if __name__ == '__main__':
    main()
