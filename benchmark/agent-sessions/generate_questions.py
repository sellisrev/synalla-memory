# SPDX-FileCopyrightText: 2026 Serge Versillé
# SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial
"""Questions for the agent-session set (RULES.md, "Questions"): written per developer by the local `daily` model from
the timeline, checked by code, then by a second model (`fast`) against the sessions. Writes out/questions.json and
out/questions_dropped.json. Resumable: answers of both models are cached in work/qgen/.

Run with:  python -I generate_questions.py [write|check|all]
"""
import hashlib, json, os, re, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT, CACHE = os.path.join(HERE, 'out'), os.path.join(HERE, 'work', 'qgen')
URL = os.environ.get('QGEN_URL', 'http://127.0.0.1:9090/v1/chat/completions')  # a second server can serve it while llama-swap is busy
PERSONAS = [f'P{i}' for i in range(1, 9)]
MIX = {'fact': 6, 'multi': 4, 'now': 4, 'when': 3, 'pref': 1, 'absent': 2}
os.makedirs(CACHE, exist_ok=True)


def ask(model, system, user, schema, max_tokens=4000):
    key = hashlib.sha256(json.dumps([model, system, user, schema]).encode()).hexdigest()
    f = os.path.join(CACHE, key + '.json')
    if os.path.exists(f):
        return json.load(open(f, encoding='utf-8'))
    body = {'model': model, 'temperature': 0, 'max_tokens': max_tokens, 'chat_template_kwargs': {'enable_thinking': False},
            'response_format': {'type': 'json_schema', 'json_schema': {'name': 'out', 'strict': True, 'schema': schema}},
            'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}]}
    url = URL if model == 'daily' else 'http://127.0.0.1:9090/v1/chat/completions'  # the checker is llama-swap's `fast`
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=900) as r:
        out = json.loads(json.loads(r.read())['choices'][0]['message']['content'])
    json.dump(out, open(f, 'w', encoding='utf-8'), ensure_ascii=False)
    return out


def session_text(p, n):
    parts = []
    for line in open(os.path.join(OUT, p, 'sessions', f'{n:03d}.jsonl'), encoding='utf-8'):
        try:
            m = json.loads(line).get('message') or {}
        except ValueError:
            continue
        c = m.get('content')
        if isinstance(c, str):
            parts.append(f"{m.get('role', '?')}: {c}")
        elif isinstance(c, list):
            parts += [f"{m.get('role', '?')}: {x.get('text', '')}" for x in c if isinstance(x, dict) and x.get('type') == 'text']
    return '\n'.join(parts)


WRITE_SYSTEM = """You write test questions for a memory benchmark. A developer worked with an AI agent for six weeks; the
timeline lists what happened, and which events later events replace. Write questions the developer could ask their
agent later, in the first person ("my", "I"), each answerable from the events it cites (or, for "absent", from none).

Write exactly: 6 "fact" (one event), 4 "multi" (needs two or more events, e.g. combining or comparing), 4 "now" (what
is true now about something that changed: cite the LAST event of a replacement chain and, before it, the events it
replaces; the reference is the current value and may name what it replaced), 3 "when" (when something happened: the
reference must contain the event's date as YYYY-MM-DD), 1 "pref" (a preference the developer stated), 2 "absent"
(plausible questions about this developer whose answer is NOT in the timeline; reference "not in the sessions"; cite
no event). The "reference" is the ANSWER itself, in words: a value, a name, a date, at most one sentence, never an
event id (write "async-std, since 2026-03-17", not "E14"). Write every question as the developer speaking ("What
runtime does my ledger service use now?"), never with the developer's name. Do not ask about anything two events
contradict except as a "now" question. Today is 2026-04-13."""

WRITE_SCHEMA = {'type': 'object', 'additionalProperties': False, 'required': ['questions'], 'properties': {'questions': {
    'type': 'array', 'items': {'type': 'object', 'additionalProperties': False, 'required': ['type', 'question', 'reference', 'events'],
    'properties': {'type': {'type': 'string', 'enum': list(MIX)}, 'question': {'type': 'string'}, 'reference': {'type': 'string'},
                   'events': {'type': 'array', 'items': {'type': 'string'}}}}}}}

CHECK_SYSTEM = """You check a benchmark question against the sessions it comes from. Answer only from the SESSIONS text.
"supported": true if the sessions state the reference answer (for a question about what is true now: the sessions
show this is the latest value). For a question marked ABSENT: "supported" is true only if the sessions do NOT answer
the question at all. Give a short reason."""
CHECK_SCHEMA = {'type': 'object', 'additionalProperties': False, 'required': ['supported', 'reason'],
                'properties': {'supported': {'type': 'boolean'}, 'reason': {'type': 'string'}}}


ABSENT_SYSTEM = """You check whether a question is answered anywhere in a developer's sessions with their AI agent. "answered": true
if the SESSIONS text gives the answer to the QUESTION (even in passing), false if it does not. Give a short reason."""
ABSENT_SCHEMA = {'type': 'object', 'additionalProperties': False, 'required': ['answered', 'reason'],
                 'properties': {'answered': {'type': 'boolean'}, 'reason': {'type': 'string'}}}


def write():
    allq = []
    for p in PERSONAS:
        tl = json.load(open(os.path.join(OUT, p, 'timeline.json'), encoding='utf-8'))['events']
        idx = json.load(open(os.path.join(OUT, p, 'index.json'), encoding='utf-8'))
        user = 'TIMELINE:\n' + '\n'.join(f"{e['id']} {e['date']} [{e['kind']}] {e['fact']}" + (f" (replaces {e['replaces']})" if e['replaces'] else '') for e in tl)
        out = ask('daily', WRITE_SYSTEM, user, WRITE_SCHEMA)
        for q in out['questions']:
            q['persona'] = p
            ev = {e['id']: e for e in tl}
            q['sessions'] = sorted({s['n'] for s in idx for e in q['events'] if e in s['events']})
            q['problems'] = rule_problems(q, ev)
            allq.append(q)
        print(p, len(out['questions']), 'written', sum(1 for q in allq if q['persona'] == p and not q['problems']), 'pass the rules', flush=True)
    json.dump(allq, open(os.path.join(CACHE, 'written.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


def rule_problems(q, ev):
    pr = []
    if re.search(r'\bE\d{2}\b', q['reference']) or re.search(r'\bE\d{2}\b', q['question']):
        pr.append('names an event id instead of the answer')
    if any(e not in ev for e in q['events']):
        pr.append('cites an unknown event')
    if q['type'] == 'absent':
        if q['events']:
            pr.append('absent question cites events')
        return pr
    if not q['events']:
        pr.append('cites no event')
        return pr
    if q['type'] == 'now':
        # one cited event must end a chain: it replaces an earlier one and nothing replaces it (citation order is free)
        replaced = {e['replaces'] for e in ev.values() if e['replaces']}
        if not any(e in ev and ev[e]['replaces'] and e not in replaced for e in q['events']):
            pr.append('now: no cited event ends a chain of replacements')
    if q['type'] == 'when' and not any(ev[e]['date'] in q['reference'] for e in q['events'] if e in ev):
        pr.append("when: the reference does not hold the event's date")
    if q['type'] == 'multi' and len(q['events']) < 2:
        pr.append('multi: fewer than two events')
    return pr


def check():
    allq = json.load(open(os.path.join(CACHE, 'written.json'), encoding='utf-8'))
    kept, dropped, counter = [], [], {}
    for q in allq:
        if q['problems']:
            dropped.append({**q, 'why': '; '.join(q['problems'])})
            continue
        p = q['persona']
        if q['type'] == 'absent':
            ns = [s['n'] for s in json.load(open(os.path.join(OUT, p, 'index.json'), encoding='utf-8'))]
        else:
            ns = q['sessions']
        text = '\n\n'.join(f'--- session {n}\n' + session_text(p, n) for n in ns)[:90000]
        user = f"QUESTION{' (ABSENT)' if q['type'] == 'absent' else ''}: {q['question']}\nREFERENCE: {q['reference']}\n\nSESSIONS:\n{text}"
        if q['type'] == 'absent':
            # its own plain question: the first form ("supported" meaning "not answered") was misread (28 Nov)
            a = ask('fast', ABSENT_SYSTEM, f"QUESTION: {q['question']}\n\nSESSIONS:\n{text}", ABSENT_SCHEMA, 400)
            v = {'supported': not a['answered'], 'reason': a['reason']}
        else:
            v = ask('fast', CHECK_SYSTEM, user, CHECK_SCHEMA, 400)
        if not v['supported']:
            dropped.append({**q, 'why': 'second model: ' + v['reason']})
            continue
        counter[p] = counter.get(p, 0) + 1
        kept.append({'id': f'{p}-{counter[p]:02d}', 'persona': p, 'type': q['type'], 'question': q['question'], 'reference': q['reference'],
                     'events': q['events'], 'sessions': q['sessions'], 'check': v['reason']})
        print(len(kept), 'kept', len(dropped), 'dropped', flush=True)
    json.dump(kept, open(os.path.join(OUT, 'questions.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    json.dump(dropped, open(os.path.join(OUT, 'questions_dropped.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    by = {}
    for q in kept:
        by[q['type']] = by.get(q['type'], 0) + 1
    print('DONE', len(kept), 'questions', by, len(dropped), 'dropped')


if __name__ == '__main__':
    step = sys.argv[1] if len(sys.argv) > 1 else 'all'
    if step in ('write', 'all'):
        write()
    if step in ('check', 'all'):
        check()
