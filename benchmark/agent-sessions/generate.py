"""Synthetic agent sessions for Synalla memory's public benchmark (rules in RULES.md). Resumable.

  python -I -X utf8 generate.py [--url http://127.0.0.1:9090] [--model daily] [--only P1] [--sessions-per 40]

Writes out/<persona>/timeline.json, out/<persona>/sessions/<n>.jsonl (Claude Code transcript format) and
out/<persona>/index.json (session -> events). One progress line per step on stdout.
"""
import argparse, datetime, hashlib, json, os, random, sys, time, urllib.request, uuid

SEED = 'synalla-agent-sessions-2026-11-24'
START = datetime.date(2026, 3, 2)
WEEKS = 6
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')

PERSONAS = [
    ('P1', 'Maya Okafor', 'backend developer at a payments start-up in Lisbon; lives with her partner Tomas; runs on weekends'),
    ('P2', 'Jonas Weber', 'indie game developer in Leipzig, building a 2D puzzle game in Godot; has a daughter, Lea, aged 6'),
    ('P3', 'Priya Raman', 'data scientist at a hospital in Manchester; finishing a part-time master; allergic to penicillin'),
    ('P4', 'Luca Bianchi', 'freelance mobile developer in Turin; works for three clients; renting a flat, looking to buy'),
    ('P5', 'Sofia Lindqvist', 'DevOps engineer at a logistics firm in Gothenburg; on-call one week in four; learns Japanese'),
    ('P6', 'Daniel Mensah', 'computer science student in Accra doing an internship at a fintech; writes his thesis on fraud detection'),
    ('P7', 'Hana Kobayashi', 'maintainer of an open-source static site generator, living in Osaka; sponsored part-time'),
    ('P8', 'Marc Dubois', 'CTO of a 9-person agritech start-up in Lyon; preparing a funding round; two children'),
]

TIMELINE_SCHEMA = {'type': 'object', 'additionalProperties': False, 'required': ['events'], 'properties': {'events': {
    'type': 'array', 'minItems': 30, 'maxItems': 45, 'items': {'type': 'object', 'additionalProperties': False,
        'required': ['id', 'date', 'kind', 'fact', 'replaces'],
        'properties': {'id': {'type': 'string'}, 'date': {'type': 'string'},
                       'kind': {'type': 'string', 'enum': ['project', 'bug', 'tool', 'person', 'appointment', 'purchase', 'preference', 'plan', 'life']},
                       'fact': {'type': 'string'}, 'replaces': {'type': ['string', 'null']}}}}}}

SESSION_SCHEMA = {'type': 'object', 'additionalProperties': False, 'required': ['title', 'turns'], 'properties': {
    'title': {'type': 'string'},
    'turns': {'type': 'array', 'minItems': 4, 'maxItems': 14, 'items': {'type': 'object', 'additionalProperties': False,
        'required': ['role', 'text'], 'properties': {'role': {'type': 'string', 'enum': ['user', 'assistant']}, 'text': {'type': 'string'}}}}}}


def post(url, model, prompt, schema, seed, max_tokens):
    body = {'model': model, 'messages': [{'role': 'user', 'content': prompt}], 'max_tokens': max_tokens, 'temperature': 0.7, 'seed': seed,
            'chat_template_kwargs': {'enable_thinking': False},
            'response_format': {'type': 'json_schema', 'json_schema': {'name': 'out', 'schema': schema, 'strict': True}}}
    req = urllib.request.Request(url + '/v1/chat/completions', data=json.dumps(body).encode(), headers={'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=1800) as r:
        return json.loads(json.load(r)['choices'][0]['message']['content'])


def num(*parts):
    return int(hashlib.sha256(('|'.join(map(str, (SEED,) + parts))).encode()).hexdigest()[:8], 16)


def timeline(a, pid, name, bio):
    path = os.path.join(OUT, pid, 'timeline.json')
    if os.path.exists(path):
        return json.load(open(path, encoding='utf-8'))
    end = START + datetime.timedelta(weeks=WEEKS) - datetime.timedelta(days=1)
    prompt = f"""Invent a realistic 6-week timeline for {name}, a {bio}, from {START} to {end}. They use an AI coding and
assistant agent every working day.

Give 30 to 45 events in date order. Mix: their software project (decisions, architecture, libraries, bugs and fixes,
deadlines, people they work with by name), and their life (appointments, purchases with prices, family, preferences,
plans). Each fact is one specific, checkable sentence with names, numbers or dates (not vague). At least 6 events
change an earlier one (a moved deadline, a replaced library, a new phone number, a cancelled trip): for those, set
"replaces" to the earlier event's id; otherwise null. Ids are E01, E02, ... Dates are YYYY-MM-DD within the 6 weeks."""
    t = post(a.url, a.model, prompt, TIMELINE_SCHEMA, num('timeline', pid) % 100000, 8000)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(t, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    return t


def briefs(pid, events, n):
    """Plan n sessions over the weeks: each reveals 1-2 events on or after their date; some sessions are pure work noise."""
    rnd = random.Random(num('briefs', pid))
    evs = sorted(events, key=lambda e: e['date'])
    out = []
    for i in range(n):
        day = START + datetime.timedelta(days=int(i * WEEKS * 7 / n) + rnd.randint(0, 1))
        due = [e for e in evs if e['date'] <= day.isoformat() and not any(e['id'] in b['events'] for b in out)]
        k = 0 if rnd.random() < 0.15 or not due else min(len(due), rnd.choice([1, 1, 2]))
        out.append({'n': i + 1, 'date': day.isoformat(), 'kind': 'coding' if rnd.random() < 0.65 else 'assistant', 'events': [e['id'] for e in due[:k]]})
    # every event appears in some session: put leftovers into the last sessions after their date
    left = [e for e in evs if not any(e['id'] in b['events'] for b in out)]
    for e in left:
        cands = [b for b in out if b['date'] >= e['date'] and len(b['events']) < 3] or out[-1:]
        cands[0]['events'].append(e['id'])
    return out


def session(a, pid, name, bio, events_by_id, b):
    facts = '\n'.join(f"- {events_by_id[x]['fact']} (event date {events_by_id[x]['date']})" for x in b['events']) or '- (none: an ordinary work session)'
    prompt = f"""Write one realistic session between {name} ({bio}) and their AI agent on {b['date']}.
Kind: {'a coding session in their project (code snippets, error messages, commands, file names)' if b['kind'] == 'coding' else 'an assistant session (planning, writing, admin, research)'}.
4 to 14 turns, alternating user and assistant, starting with the user. Most of the session is ordinary work. These facts
must come up naturally, said by {name} or confirmed in the conversation, with their exact names, numbers and dates:
{facts}
Do not mention that this is synthetic. Give a short session title."""
    return post(a.url, a.model, prompt, SESSION_SCHEMA, num('session', pid, b['n']) % 100000, 6000)


def to_jsonl(pid, b, s):
    sid = str(uuid.UUID(int=num('sid', pid, b['n']) << 96 | num('sid2', pid, b['n'])))
    t = datetime.datetime.fromisoformat(b['date'] + 'T09:00:00') + datetime.timedelta(minutes=num('t', pid, b['n']) % 480)
    lines = [json.dumps({'type': 'ai-title', 'aiTitle': s['title'], 'sessionId': sid})]
    for k, turn in enumerate(s['turns']):
        ts = (t + datetime.timedelta(minutes=2 * k)).isoformat() + 'Z'
        content = turn['text'] if turn['role'] == 'user' else [{'type': 'text', 'text': turn['text']}]
        lines.append(json.dumps({'type': turn['role'], 'sessionId': sid, 'timestamp': ts, 'isSidechain': False, 'cwd': f'/home/dev/{pid.lower()}',
                                 'message': {'role': turn['role'], 'content': content}}, ensure_ascii=False))
    return '\n'.join(lines) + '\n'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', default='http://127.0.0.1:9090')
    ap.add_argument('--model', default='daily')
    ap.add_argument('--only', default='')
    ap.add_argument('--sessions-per', type=int, default=40)
    ap.add_argument('--max-sessions', type=int, default=0, help='stop each persona after this many sessions (for a first check)')
    a = ap.parse_args()
    for pid, name, bio in PERSONAS:
        if a.only and pid not in a.only.split(','):
            continue
        t0 = time.time()
        tl = timeline(a, pid, name, bio)
        events_by_id = {e['id']: e for e in tl['events']}
        print(f'{pid} timeline: {len(tl["events"])} events, {sum(1 for e in tl["events"] if e["replaces"])} changes ({time.time() - t0:.0f}s)', flush=True)
        plan = briefs(pid, tl['events'], a.sessions_per)
        idx = os.path.join(OUT, pid, 'index.json')
        json.dump(plan, open(idx, 'w', encoding='utf-8'), indent=1)
        os.makedirs(os.path.join(OUT, pid, 'sessions'), exist_ok=True)
        for b in plan[: a.max_sessions or None]:
            path = os.path.join(OUT, pid, 'sessions', f'{b["n"]:03d}.jsonl')
            if os.path.exists(path):
                continue
            t1 = time.time()
            try:
                s = session(a, pid, name, bio, events_by_id, b)
            except Exception as e:
                print(f'{pid} session {b["n"]} FAILED: {e!r}'[:300], flush=True)
                continue
            open(path, 'w', encoding='utf-8').write(to_jsonl(pid, b, s))
            print(f'{pid} session {b["n"]}/{len(plan)} {b["kind"]} {len(s["turns"])} turns, events {b["events"]} ({time.time() - t1:.0f}s)', flush=True)
    print('ALL DONE', flush=True)


if __name__ == '__main__':
    main()
