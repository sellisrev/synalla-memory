"""Score proactive proposals against the planted truth (RULES.md, network.py).

  python -I -X utf8 score_proactive.py <proposals.jsonl> [<more.jsonl> ...]

A need is open from the day of the session where it first comes up until the day of the session where it is solved.
A proposal is right when its entry is a planted match for one of the person's own needs and it is dated while that
need is open. Everything else is a false alarm, by kind: a near miss (other city, expired, neighbouring topic), a fit
for someone else's or an imagined need, a fit proposed after the need was met, or an unrelated entry.
"""
import json, os, sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'out')


def open_windows():
    """need id -> (person, pattern, open day, met day or None), from the session plan of each person."""
    truth = json.load(open(os.path.join(OUT, 'network_truth.json'), encoding='utf-8'))
    out = {}
    for t in truth:
        pid = t['person']
        stories = json.load(open(os.path.join(OUT, pid, 'storylines.json'), encoding='utf-8'))
        index = json.load(open(os.path.join(OUT, pid, 'index.json'), encoding='utf-8'))
        s = next(s for s in stories if s['pattern'].startswith('need') and s['values'][0] == t['phrase'])
        when = {st['step']: x['date'] for x in index for st in x['steps'] if st['story'] == s['id']}
        out[t['need']] = {**t, 'open': when.get(0), 'met': when.get(1)}
    return out


def score(path, needs):
    rows = [json.loads(l) for l in open(path, encoding='utf-8')]
    props = [r for r in rows if r['type'] == 'proposal']
    people = sorted({r['person'] for r in rows if r['type'] == 'done'})
    by_entry = {}
    for n in needs.values():
        for e in n['would_fit']:
            by_entry[e] = (n, 'fit')
        for e in n['near_misses']:
            by_entry.setdefault(e, (n, 'near'))
    kinds, first_right = Counter(), {}
    for p in props:
        n, how = by_entry.get(p['entry'], (None, None))
        if n is None or n['person'] != p['person']:
            kinds['unrelated'] += 1
        elif how == 'near':
            kinds['near miss'] += 1
        elif n['pattern'] == 'need_other':
            kinds["someone else's or imagined need"] += 1
        elif n['open'] and p['date'] >= n['open'] and (n['met'] is None or p['date'] < n['met']):
            kinds['right'] += 1
            first_right.setdefault(n['need'], p['date'])
        elif n['met'] and p['date'] >= n['met']:
            kinds['after the need was met'] += 1
        else:
            kinds['before the need came up'] += 1
    own = [n for n in needs.values() if n['person'] in people and n['pattern'] != 'need_other' and n['open']]
    from datetime import date
    lat = [(date.fromisoformat(first_right[n['need']]) - date.fromisoformat(n['open'])).days for n in own if n['need'] in first_right]
    total = len(props)
    lines = [f'## {os.path.basename(path)}', '', f'{len(people)} people, {len(own)} own needs, {total} proposals.', '',
             f'- needs found (at least one right proposal while open): {len(first_right)}/{len(own)} ({100 * len(first_right) / max(1, len(own)):.0f}%)',
             f"- proposals right: {kinds['right']}/{total} ({100 * kinds['right'] / max(1, total):.0f}%)",
             f'- days from first mention to first right proposal: ' + (f'median {sorted(lat)[len(lat) // 2]}, max {max(lat)}' if lat else 'n/a'),
             '- false alarms: ' + (', '.join(f'{k} {v}' for k, v in kinds.items() if k != 'right') or 'none'), '']
    missed = [f"  - {n['need']} ({n['pattern']}): {n['phrase']}" for n in own if n['need'] not in first_right]
    if missed:
        lines += ['Missed:', *missed, '']
    return '\n'.join(lines)


def main():
    needs = open_windows()
    print('\n'.join(score(p, needs) for p in sys.argv[1:]))


if __name__ == '__main__':
    main()
