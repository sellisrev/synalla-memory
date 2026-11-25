"""Want detection + matching calibration on the synthetic circle (truth planted by generate.py).

  python -I -X utf8 detect.py [--url http://127.0.0.1:9090] [--model daily]

For each member's session, the local model lists the member's own needs as (type, topic, confidence, quote), from the
same closed vocabulary circle/1 uses. Needs are merged per member (highest confidence kept). Matching then follows
synalla/src/entries.ts candidates(): same type and topic, not expired. Reported, per confidence threshold:
need detection precision/recall against the planted needs, and match precision/recall against truth.json (near misses
must not match). Raw detections in out/detections.json (resumable), report in out/calibration.md.
"""
import argparse, glob, json, os, sys, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from generate import TYPES, TOPICS, post, num  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
NOW = 1_800_000_000
ITEM = {'type': 'object', 'additionalProperties': False, 'required': ['type', 'topic', 'confidence', 'quote'], 'properties': {
    'type': {'type': 'string', 'enum': TYPES}, 'topic': {'type': 'string', 'enum': TOPICS},
    'confidence': {'type': 'number'}, 'quote': {'type': 'string'}}}
SCHEMA = {'type': 'object', 'additionalProperties': False, 'required': ['needs'], 'properties': {'needs': {'type': 'array', 'items': ITEM}}}
# variant "split": the model must sort each item into the developer's needs or the developer's own offers
SCHEMA_SPLIT = {'type': 'object', 'additionalProperties': False, 'required': ['own_offers', 'needs'], 'properties': {
    'own_offers': {'type': 'array', 'items': ITEM}, 'needs': {'type': 'array', 'items': ITEM}}}
VARIANT = 'base'
TOPIC_ONLY = False
TYPE_MEANING = ('help = someone does a task with or for them; intro = an introduction to a person; lend = borrow an object; '
                'recommend = advice on what to choose; offer = someone gives a service or thing')


def text_of(path):
    out = []
    for line in open(path, encoding='utf-8'):
        o = json.loads(line)
        if o['type'] in ('user', 'assistant'):
            c = o['message']['content']
            out.append(f"{o['type'].upper()}: {c if isinstance(c, str) else c[0]['text']}")
    return '\n'.join(out)


def detect(a, mid, n, text):
    prompt = f"""Below is a session between a developer and their AI agent. List what the DEVELOPER needs from other people
and could ask their acquaintances for. Only their own unmet needs: not things they offer or can do for others, not
tasks the agent itself completes in the session. For each need, pick the type and topic from the allowed lists, a
confidence from 0 to 1, and a short quote from the session. An empty list is fine.
Types: {TYPE_MEANING}.
Topics: {', '.join(TOPICS)}.

SESSION:
{text}"""
    if VARIANT == 'split':
        prompt = prompt.replace('List what the DEVELOPER needs', 'First list what the DEVELOPER can do or give for others (own_offers), then what the DEVELOPER needs')
        return post(a, prompt, SCHEMA_SPLIT, num('detect', mid, n) % 100000, 3000)['needs']
    return post(a, prompt, SCHEMA, num('detect', mid, n) % 100000, 2000)['needs']


def score(truth, merged, entries, th):
    needs = {(m['id'], x['type'] if not TOPIC_ONLY else '', x['topic']) for m in truth['members'] for x in m['needs']}
    found = {(mid, t if not TOPIC_ONLY else '', tp) for mid, d in merged.items() for (t, tp), c in d.items() if c >= th}
    tp_n = len(needs & found)
    owner = {o['id']: m['id'] for m in truth['members'] for o in m['offers']}
    need_key = {x['id']: (m['id'], x['type'], x['topic']) for m in truth['members'] for x in m['needs']}
    want = {(need_key[x['need']][0], x['offer']) for x in truth['matches']}
    got = set()
    for mid, t, tp in found:  # topic_only: ignore type when matching (type vocabulary is ambiguous as a need)
        for oid_owner, es in entries.items():
            if oid_owner == mid:
                continue
            for e in es:
                if (TOPIC_ONLY or e['type'] == t) and e['topic'] == tp and e['expires'] > NOW:
                    got.add((mid, e['id'].upper().replace('-O', '-o')))
    near = {(need_key[x['need']][0], x['offer']) for x in truth['near_misses']}
    tp_m = len(want & got)
    return {'th': th, 'need_p': tp_n / max(1, len(found)), 'need_r': tp_n / len(needs), 'found': len(found),
            'match_p': tp_m / max(1, len(got)), 'match_r': tp_m / len(want), 'matches': len(got), 'near_hit': len(near & got)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', default='http://127.0.0.1:9090')
    ap.add_argument('--model', default='daily')
    ap.add_argument('--variant', default='base', choices=['base', 'split'])
    ap.add_argument('--topic-only', action='store_true')
    a = ap.parse_args()
    global VARIANT, TOPIC_ONLY
    VARIANT, TOPIC_ONLY = a.variant, a.topic_only
    truth = json.load(open(os.path.join(OUT, 'truth.json'), encoding='utf-8'))
    dp = os.path.join(OUT, 'detections.json' if a.variant == 'base' else f'detections_{a.variant}.json')
    det = json.load(open(dp, encoding='utf-8')) if os.path.exists(dp) else {}
    for f in sorted(glob.glob(os.path.join(OUT, 'M*', 'sessions', '*.jsonl'))):
        mid, n = f.split(os.sep)[-3], os.path.basename(f)[:3]
        key = f'{mid}/{n}'
        if key in det:
            continue
        t0 = time.time()
        try:
            det[key] = detect(a, mid, n, text_of(f))
        except Exception as e:
            print(f'{key} FAILED: {e!r}'[:300], flush=True)
            continue
        json.dump(det, open(dp, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        print(f'{key}: {len(det[key])} needs ({time.time() - t0:.0f}s)', flush=True)
    merged = {}
    for key, needs in det.items():
        d = merged.setdefault(key.split('/')[0], {})
        for x in needs:
            k = (x['type'], x['topic'])
            d[k] = max(d.get(k, 0), float(x['confidence']))
    entries = {os.path.basename(os.path.dirname(f)): json.load(open(f, encoding='utf-8')) for f in glob.glob(os.path.join(OUT, 'M*', 'entries.json'))}
    # topic-only recall: was the need's topic found at all, whatever the type (shows type confusion)
    needs = {(m['id'], x['topic']) for m in truth['members'] for x in m['needs']}
    topic_found = {(mid, tp) for mid, d in merged.items() for (t, tp), c in d.items() if c >= 0.5}
    rows = [score(truth, merged, entries, th) for th in (0.3, 0.5, 0.6, 0.7, 0.8, 0.9)]
    lines = ['# Want detection + matching calibration (synthetic circle)', '',
             f'Variant {a.variant}, matching on {"topic only" if a.topic_only else "type and topic"}. {len(det)} sessions, 20 members, 50 planted needs (30 with a true match, 20 near misses). Local model `{a.model}`.', '',
             '| threshold | needs found | need precision | need recall | matches proposed | match precision | match recall | near misses matched |',
             '|---|---|---|---|---|---|---|---|']
    for r in rows:
        lines.append(f"| {r['th']} | {r['found']} | {r['need_p']:.0%} | {r['need_r']:.0%} | {r['matches']} | {r['match_p']:.0%} | {r['match_r']:.0%} | {r['near_hit']} |")
    lines += ['', f'Topic-only need recall at 0.5 (type ignored): {len(needs & topic_found) / len(needs):.0%}.']
    open(os.path.join(OUT, f"calibration_{a.variant}{'_topic' if a.topic_only else ''}.md"), 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
    print('\n'.join(lines), flush=True)
    print('ALL DONE', flush=True)


if __name__ == '__main__':
    main()
