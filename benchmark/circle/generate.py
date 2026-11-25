"""Synthetic circle for calibrating W4's want detection and matching (pilot plan W4, "Precision check before M3").

  python -I -X utf8 generate.py [--url http://127.0.0.1:9090] [--model daily]

The ground truth is planted by this script before any text is written: 20 members, each with things they can offer
and things they need, on topics from a fixed vocabulary; 30 needs have a member who offers exactly that (true
matches); 20 more are near misses (same topic, wrong type, or the offer has expired). A local model then writes each
member's memory (6 sessions in Claude Code transcript format, where needs and offers come up in passing) and their
circle entries (circle/1, from their offers). Output: out/<Mxx>/sessions/*.jsonl, out/<Mxx>/entries.json,
out/truth.json. Resumable; fixed seed.
"""
import argparse, datetime, hashlib, json, os, random, sys, time, urllib.request, uuid

SEED = 'synalla-circle-2026-11-25'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
TYPES = ['help', 'intro', 'lend', 'recommend', 'offer']
TOPICS = ['rust-async', 'postgres-tuning', 'kubernetes-ops', 'react-native', 'godot-games', 'ml-fraud-detection', 'grant-writing',
          'fundraising-seed', 'tax-freelancer', 'apartment-hunting', 'childcare', 'japanese-tutoring', 'climbing-partner',
          'running-group', 'camera-gear', '3d-printer', 'car-sharing', 'bike-repair', 'legal-contracts', 'ux-research',
          'accessibility-audit', 'security-review', 'cofounder-search', 'hiring-backend', 'conference-talks', 'open-source-funding',
          'home-lab', 'nas-setup', 'language-exchange', 'piano-lessons', 'baby-gear', 'moving-help', 'travel-lisbon',
          'travel-tokyo', 'coffee-roasting', 'board-games', 'podcast-gear', 'standing-desk', 'ergonomic-keyboard', 'phd-advice']
SESSION_SCHEMA = {'type': 'object', 'additionalProperties': False, 'required': ['title', 'turns'], 'properties': {
    'title': {'type': 'string'}, 'turns': {'type': 'array', 'minItems': 4, 'maxItems': 10, 'items': {'type': 'object',
        'additionalProperties': False, 'required': ['role', 'text'], 'properties': {
            'role': {'type': 'string', 'enum': ['user', 'assistant']}, 'text': {'type': 'string'}}}}}}
TEXT_SCHEMA = {'type': 'object', 'additionalProperties': False, 'required': ['texts'], 'properties': {
    'texts': {'type': 'array', 'items': {'type': 'string'}}}}
CITIES = ['Lyon', 'Vienna', 'Lisbon', 'Berlin', 'Turin']


def num(*p):
    return int(hashlib.sha256('|'.join(map(str, (SEED,) + p)).encode()).hexdigest()[:8], 16)


def post(a, prompt, schema, seed, max_tokens):
    body = {'model': a.model, 'messages': [{'role': 'user', 'content': prompt}], 'max_tokens': max_tokens, 'temperature': 0.7, 'seed': seed,
            'chat_template_kwargs': {'enable_thinking': False},
            'response_format': {'type': 'json_schema', 'json_schema': {'name': 'out', 'schema': schema, 'strict': True}}}
    req = urllib.request.Request(a.url + '/v1/chat/completions', data=json.dumps(body).encode(), headers={'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=1800) as r:
        return json.loads(json.load(r)['choices'][0]['message']['content'])


def plant():
    """The ground truth, fixed before any text: offers, needs, true matches and near misses."""
    rnd = random.Random(num('plant'))
    members = [{'id': f'M{i:02d}', 'city': rnd.choice(CITIES), 'offers': [], 'needs': []} for i in range(1, 21)]
    truth = {'matches': [], 'near_misses': []}
    for k in range(30):  # true matches
        a, b = rnd.sample(members, 2)
        topic, typ = rnd.choice(TOPICS), rnd.choice(TYPES)
        oid = f'{b["id"]}-o{len(b["offers"]) + 1}'
        b['offers'].append({'id': oid, 'type': typ, 'topic': topic, 'expired': False})
        a['needs'].append({'id': f'{a["id"]}-n{len(a["needs"]) + 1}', 'type': typ, 'topic': topic})
        truth['matches'].append({'need': a['needs'][-1]['id'], 'offer': oid})
    for k in range(20):  # near misses: same topic but another type, or an expired offer
        a, b = rnd.sample(members, 2)
        topic, typ = rnd.choice(TOPICS), rnd.choice(TYPES)
        expired = k % 2 == 1
        otype = typ if expired else rnd.choice([t for t in TYPES if t != typ])
        oid = f'{b["id"]}-o{len(b["offers"]) + 1}'
        b['offers'].append({'id': oid, 'type': otype, 'topic': topic, 'expired': expired})
        a['needs'].append({'id': f'{a["id"]}-n{len(a["needs"]) + 1}', 'type': typ, 'topic': topic})
        truth['near_misses'].append({'need': a['needs'][-1]['id'], 'offer': oid, 'why': 'offer expired' if expired else 'type differs'})
    for m in members:  # every member also has an unrelated offer or two
        for _ in range(rnd.randint(1, 2)):
            m['offers'].append({'id': f'{m["id"]}-o{len(m["offers"]) + 1}', 'type': rnd.choice(TYPES), 'topic': rnd.choice(TOPICS), 'expired': False})
    return members, truth


def jsonl(mid, n, date, s):
    sid = str(uuid.UUID(int=num('sid', mid, n) << 96 | num('sid2', mid, n)))
    t = datetime.datetime.fromisoformat(date + 'T10:00:00')
    lines = [json.dumps({'type': 'ai-title', 'aiTitle': s['title'], 'sessionId': sid})]
    for k, turn in enumerate(s['turns']):
        content = turn['text'] if turn['role'] == 'user' else [{'type': 'text', 'text': turn['text']}]
        lines.append(json.dumps({'type': turn['role'], 'sessionId': sid, 'timestamp': (t + datetime.timedelta(minutes=2 * k)).isoformat() + 'Z',
                                 'isSidechain': False, 'message': {'role': turn['role'], 'content': content}}, ensure_ascii=False))
    return '\n'.join(lines) + '\n'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', default='http://127.0.0.1:9090')
    ap.add_argument('--model', default='daily')
    a = ap.parse_args()
    members, truth = plant()
    os.makedirs(OUT, exist_ok=True)
    json.dump({'members': members, **truth}, open(os.path.join(OUT, 'truth.json'), 'w', encoding='utf-8'), indent=1)
    print(f'planted: {len(members)} members, {len(truth["matches"])} matches, {len(truth["near_misses"])} near misses', flush=True)
    for m in members:
        d = os.path.join(OUT, m['id'])
        os.makedirs(os.path.join(d, 'sessions'), exist_ok=True)
        ep = os.path.join(d, 'entries.json')
        if not os.path.exists(ep) and m['offers']:
            desc = '\n'.join(f'- {o["type"]} / {o["topic"]}' for o in m['offers'])
            r = post(a, f"""A developer living in {m['city']} writes what they can do for people they know. For each item below
(type / topic), write one sentence in the first person, at most 300 characters, concrete: what exactly, how, and any
condition. Do not repeat the type/topic label; write a real sentence.
Example for "lend / camera-gear": "I can lend my Sony A7 III with a 35mm lens for a weekend, if you pick it up in Lyon."
Items, in this order (return exactly {len(m['offers'])} sentences):
{desc}""", TEXT_SCHEMA, num('entries', m['id']) % 100000, 2000)
            texts = (r['texts'] + [''] * len(m['offers']))[: len(m['offers'])]
            entries = [{'v': 'circle/1', 'id': o['id'].lower(), 'type': o['type'], 'topic': o['topic'], 'tags': [m['city'].lower()],
                        'text': (texts[i] or f"I can {o['type']} with {o['topic'].replace('-', ' ')}.")[:500],
                        'expires': 1_700_000_000 if o['expired'] else 1_900_000_000} for i, o in enumerate(m['offers'])]
            json.dump(entries, open(ep, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        items = [('need', x) for x in m['needs']] + [('offer', x) for x in m['offers']]
        for n in range(1, 7):
            path = os.path.join(d, 'sessions', f'{n:03d}.jsonl')
            if os.path.exists(path):
                continue
            mine = [x for i, x in enumerate(items) if i % 6 == n - 1]
            lines = '\n'.join(f'- {"they need" if k == "need" else "they could offer others"}: {x["type"]} about {x["topic"].replace("-", " ")}' for k, x in mine) or '- (nothing in particular)'
            date = (datetime.date(2026, 9, 1) + datetime.timedelta(days=7 * n + num('d', m['id'], n) % 5)).isoformat()
            t0 = time.time()
            try:
                s = post(a, f"""Write a realistic session between a developer living in {m['city']} and their AI agent on {date}: mostly
ordinary work or planning. These things should come up naturally, in passing, as the developer's own situation (never as
a list, never mentioning a "circle" or "network"):
{lines}
4 to 10 turns, alternating, starting with the user. Give a short title.""", SESSION_SCHEMA, num('s', m['id'], n) % 100000, 5000)
            except Exception as e:
                print(f'{m["id"]} session {n} FAILED: {e!r}'[:300], flush=True)
                continue
            open(path, 'w', encoding='utf-8').write(jsonl(m['id'], n, date, s))
            print(f'{m["id"]} session {n}/6 ({time.time() - t0:.0f}s)', flush=True)
    print('ALL DONE', flush=True)


if __name__ == '__main__':
    main()
