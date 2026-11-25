"""Questions from the computed truth (RULES.md), before the outside review.

  python -I -X utf8 questions.py      -> out/questions.json

Each storyline gives one or more questions whose reference answer follows from its pattern, never from the text a
model wrote. Every person also gets a question about their open needs (the whole picture) and three questions whose
answer is not in the sessions. Wording is plain on purpose; the reviewer rephrases. Only storylines whose steps all
made it into a kept session are used (a session the checks gave up on drops its storylines).
"""
import json, os, random, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from generate import PEOPLE, OUT, num, day  # noqa: E402

ABSENT = ['blood type', 'shoe size', 'favourite film', 'first car', 'passport number', 'wifi password', "best friend's birthday",
          'favourite football team', 'piano grade', 'gym locker number', 'grandmother\'s maiden name', 'licence plate']


def date_of(sessions, story, step):
    for x in sessions:
        for st in x['steps']:
            if st['story'] == story and st['step'] == step:
                return day(st['day'])


def for_person(pid, name, stories, truth, sessions, have):
    first = name.split()[0]
    rnd = random.Random(num('questions', pid))
    q = []
    tby = {t['id']: t for t in truth}

    def add(kind, story, question, gold, **extra):
        q.append({'id': f'{pid}-Q{len(q) + 1:02d}', 'person': pid, 'type': kind, 'storyline': story, 'question': question,
                  'gold': gold, **extra})

    for s in stories:
        if not all(x['n'] in have for x in sessions for st in x['steps'] if st['story'] == s['id']):
            continue  # a step of this storyline is in a session that was never kept
        p, v, th, t = s['pattern'], s['values'], s['thing'], tby[s['id']]
        o = (s['other_person'] or '').split(' (')[0]
        if p == 'plain':
            add('fact', s['id'], f'What is my {th}?', v[0])
        elif p == 'change':
            add('now', s['id'], f'What is my {th} now?', f'{v[1]} (it was {v[0]})')
            add('before', s['id'], f'What was my {th} before it changed?', v[0])
            add('when', s['id'], f'When did my {th} change to {v[1]}?', date_of(sessions, s['id'], 1))
        elif p == 'heart':
            add('now', s['id'], f'What is my {th} now?', f'{v[0]} (I switched to {v[1]}, then went back)')
        elif p == 'correction':
            add('now', s['id'], f'What is my {th}?', f'{v[1]} ({v[0]} was a slip, corrected on {t["corrected_on"]})')
        elif p == 'tentative_dropped':
            add('considered', s['id'], f'Did I change my {th} to {v[1]}?', f'No: I only thought about it; it is still {v[0]}')
        elif p == 'tentative_confirmed':
            add('now', s['id'], f'What is my {th} now?', f'{v[1]} (changed from {v[0]} after thinking about it)')
            add('when', s['id'], f'When did I go ahead with {v[1]} for my {th}?', date_of(sessions, s['id'], 2))
        elif p == 'hypothetical':
            add('now', s['id'], f'What is my {th}?', f'{v[0]} ({v[1]} was only a what-if)')
        elif p == 'lookalike':
            add('whose', s['id'], f'What is my {th}?', f'{v[0]} ({v[1]} is {o}\'s)')
            add('whose', s['id'], f"What is {o}'s {th}?", v[1])
        elif p == 'need_met':
            add('need', s['id'], f'Am I still looking for {v[0]}?', f'No: sorted on {t["need"]["met_on"]} ({v[1]})')
    open_needs = [s for s in stories if s['pattern'] == 'need_open']
    if open_needs:
        add('needs_now', None, 'What am I looking for at the moment? List everything still open.',
            '; '.join(s['values'][0] for s in open_needs), note='not: needs already solved, or needs of someone else')
    used = ' '.join(s['thing'].lower() for s in stories)
    for th in rnd.sample([a for a in ABSENT if a not in used], 3):
        add('none', None, f'What is my {th}?', 'not in memory')
    return q


def main():
    allq = []
    for pid, name, bio, work in PEOPLE:
        root = os.path.join(OUT, pid)
        if not os.path.exists(os.path.join(root, 'index.json')):
            continue
        stories = json.load(open(os.path.join(root, 'storylines.json'), encoding='utf-8'))
        truth = json.load(open(os.path.join(root, 'truth.json'), encoding='utf-8'))
        sessions = json.load(open(os.path.join(root, 'index.json'), encoding='utf-8'))
        have = {x['n'] for x in sessions if os.path.exists(os.path.join(root, 'sessions', f"{x['n']:03d}.jsonl"))}
        allq += for_person(pid, name, stories, truth, sessions, have)
    json.dump(allq, open(os.path.join(OUT, 'questions.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    by = {}
    for x in allq:
        by[x['type']] = by.get(x['type'], 0) + 1
    print(f'{len(allq)} questions: {by}')


if __name__ == '__main__':
    main()
