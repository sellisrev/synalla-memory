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
OUT = os.path.join(HERE, '..', {'test': 'out', 'dev': 'out_dev', 'val': 'out_val'}[os.environ.get('LIFE_SET', 'test')])


def open_windows():
    """need id -> (person, pattern, open day, met day or None), from the session plan of each person."""
    truth = json.load(open(os.path.join(OUT, 'network_truth.json'), encoding='utf-8'))
    sp = os.path.join(OUT, 'questions_skipped.json')
    skipped = {(x['person'], x['storyline']) for x in (json.load(open(sp, encoding='utf-8')) if os.path.exists(sp) else [])}
    out = {}
    for t in truth:
        pid = t['person']
        stories = json.load(open(os.path.join(OUT, pid, 'storylines.json'), encoding='utf-8'))
        index = json.load(open(os.path.join(OUT, pid, 'index.json'), encoding='utf-8'))
        s = next(s for s in stories if s['pattern'].startswith('need') and s['values'][0] == t['phrase'])
        when = {st['step']: x['date'] for x in index for st in x['steps'] if st['story'] == s['id']}
        # skip: not counted (questions_skipped.json, e.g. it comes up after its own date); proposals for it are ignored
        out[t['need']] = {**t, 'open': when.get(0), 'met': when.get(1), 'skip': (pid, s['id']) in skipped}
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
    props = [p for p in props if not (by_entry.get(p['entry'], (None,))[0] or {}).get('skip')]
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
        else:  # the text mentioned the need before its planned session (the writer let it slip early)
            kinds['early'] += 1
    own = [n for n in needs.values() if n['person'] in people and n['pattern'] != 'need_other' and n['open'] and not n['skip']]
    from datetime import date
    lat = [(date.fromisoformat(first_right[n['need']]) - date.fromisoformat(n['open'])).days for n in own if n['need'] in first_right]
    total = len(props)
    lines = [f'## {os.path.basename(path)}', '', f'{len(people)} people, {len(own)} own needs, {total} proposals.', '',
             f'- needs found (at least one right proposal while open): {len(first_right)}/{len(own)} ({100 * len(first_right) / max(1, len(own)):.0f}%)',
             f"- proposals right: {kinds['right']}/{total} ({100 * kinds['right'] / max(1, total):.0f}%); "
             f"not counting early ones (a need the text mentions before its planned day): {kinds['right']}/{total - kinds['early']} "
             f"({100 * kinds['right'] / max(1, total - kinds['early']):.0f}%)",
             f'- days from first mention to first right proposal: ' + (f'median {sorted(lat)[len(lat) // 2]}, max {max(lat)}' if lat else 'n/a'),
             '- other proposals: ' + (', '.join(f'{k} {v}' for k, v in kinds.items() if k != 'right') or 'none'), '']
    # closing: map each want to the need its right proposals were for; a met need should be closed on or after
    # the day it was met (within 7 days); an open need, or a met need closed before that day, is closed wrongly
    wants = {(r['person'], r['wid']): r for r in rows if r['type'] == 'want'}
    need_of = {}
    for p in props:
        n, how = by_entry.get(p['entry'], (None, None))
        if n is not None and how == 'fit' and n['person'] == p['person']:
            need_of.setdefault((p['person'], p['wid']), n)
    closed_ok = closed_bad = not_closed = 0
    for key, n in need_of.items():
        w = wants.get(key)
        if not w or n['pattern'] == 'need_other':
            continue
        c = w['closed_at']
        if n['met'] is None:
            closed_bad += c is not None
        elif c is None:
            not_closed += 1
        elif n['met'] <= c and (date.fromisoformat(c) - date.fromisoformat(n['met'])).days <= 7:
            closed_ok += 1
        else:
            closed_bad += 1
    lines.insert(-1, f'- closing (needs met in the sessions): closed right {closed_ok}, not closed {not_closed}; closed wrongly {closed_bad}')
    missed = [f"  - {n['need']} ({n['pattern']}): {n['phrase']}" for n in own if n['need'] not in first_right]
    if missed:
        lines += ['Missed:', *missed, '']
    return '\n'.join(lines)


def main():
    needs = open_windows()
    print('\n'.join(score(p, needs) for p in sys.argv[1:]))


if __name__ == '__main__':
    main()
