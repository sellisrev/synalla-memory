"""Questions from the computed truth (RULES.md), before the outside review.

  python -I -X utf8 questions.py      -> out/questions.json

Each storyline gives one or more questions whose reference answer follows from its pattern, never from the text a
model wrote. Every person also gets a question about their open needs (the whole picture) and three questions whose
answer is not in the sessions. Wording is plain on purpose; the reviewer rephrases. Only storylines whose steps all
made it into a kept session are used (a session the checks gave up on drops its storylines).
"""
import json, os, random, re, sys, unicodedata

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from generate import PEOPLE, OUT, num, day, thing_words, before_deadline  # noqa: E402

ABSENT = ['blood type', 'shoe size', 'favourite film', 'first car', 'passport number', 'wifi password', "best friend's birthday",
          'favourite football team', 'piano grade', 'gym locker number', 'grandmother\'s maiden name', 'licence plate']


def date_of(sessions, story, step):
    for x in sessions:
        for st in x['steps']:
            if st['story'] == story and st['step'] == step:
                return day(st['day'])


# need phrases where a his/her is someone else's (the rule below would make it the owner's)
OWN_WORDS = {'a maths tutor for Pablo before his June exams': "a maths tutor for Pablo before his June exams",
             'someone to pick Elsa up from school on the Thursdays he works in Stockholm': 'someone to pick Elsa up from school on the Thursdays I work in Stockholm',
             "a maths tutor for Diego before his end-of-term exams": "a maths tutor for Diego before his end-of-term exams"}


DATE = re.compile(r'^(\d{4}-\d{2}-\d{2}|\d{1,2}(st|nd|rd|th)? (January|February|March|April|May|June|July|August|September|October|November|December)|(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}(st|nd|rd|th)?)$')
TITLE = re.compile(r'^(Dr|Mr|Mrs|Ms|Monsieur|Madame|Herr|Frau|Doña|Don|Lic)\.? ')
ROLES = {'doctor', 'dentist', 'cardiologist', 'pediatrician', 'paediatrician', 'physiotherapist', 'therapist', 'teacher', 'tutor',
         'director', 'headteacher', 'partner', 'advisor', 'adviser', 'leader', 'instructor', 'coach', 'technician',
         'representative', 'lawyer', 'accountant', 'mechanic', 'stylist', 'hairdresser', 'agent', 'optometrist', 'vet'}


def mine(phrase):
    """A need phrase (written about the owner in the third person) as the owner says it."""
    import re
    if phrase in OWN_WORDS:
        return OWN_WORDS[phrase]
    for a, b in ((r'\bhim\b', 'me'), (r'\b(she|he) is\b', 'I am'), (r'\b(she|he) has\b', 'I have'), (r'\b(her|his)\b', 'my'),
                 (r'\b(herself|himself)\b', 'myself'), (r'\b(she|he)\b', 'I')):
        phrase = re.sub(a, b, phrase)
    return phrase


skipped = []


def for_person(pid, name, stories, truth, sessions, have):
    first = name.split()[0]
    rnd = random.Random(num('questions', pid))
    q = []
    tby = {t['id']: t for t in truth}
    bio = next(b for p_, n_, b, w_ in PEOPLE if p_ == pid)
    # household names in the bio: "two children (Inès 9, Hugo 5)", "married to Julien", "their daughter Elsa (7)"
    nfc = lambda x: unicodedata.normalize('NFC', x)
    names_in_bio = set(re.findall(r"(?:\(|, )([A-Z][a-z" + "\u00e0-\u00ff" + r"-]+) \d", nfc(bio))) | set(
        re.findall(r"(?:married to|partner|son|daughter|grandson|granddaughter|wife|husband|brother|sister|newborn),? ([A-Z][a-z" + "\u00e0-\u00ff" + r"-]+)", nfc(bio)))

    def my(th):
        """"my dentist", but "Inès's music teacher" and "Hugo's pediatrician" (a person of the household)."""
        th = unicodedata.normalize('NFC', th)
        w = th.split()[0]
        if w.endswith("'s") and w[:1].isupper():
            return th
        if w in names_in_bio:
            return f"{w}'s {th[len(w) + 1:]}"
        return 'my ' + th

    def wh(th, vals):
        """When for a dated thing (an appointment whose value is a date), Who for a person, else What."""
        if any(DATE.match(x.strip()) for x in vals) and not re.search(r'date|birthday|deadline|day', th, re.I):
            return 'When'
        if (thing_words(th) and sorted(thing_words(th), key=th.lower().find)[-1] in ROLES) or any(TITLE.match(x) for x in vals):
            return 'Who'
        return 'What'


    def add(kind, story, question, gold, **extra):
        # ids stay the same when another storyline is skipped: person, storyline, the question's place in it
        n = sum(1 for x in q if x['storyline'] == story and (story or x['type'] == kind)) + 1
        q.append({'id': f"{pid}-{story or kind}-{n}", 'person': pid, 'type': kind, 'storyline': story, 'question': question,
                  'gold': gold, **extra})

    def vague(s):
        # a thing whose words are all in another storyline's thing ("insurance provider" next to "home insurance
        # provider"): its question could fairly be answered with the other value, so it is not asked
        w = thing_words(s['thing'])
        return any(o is not s and not o['pattern'].startswith('need') and w <= thing_words(o['thing']) for o in stories)

    for s in stories:
        if s['pattern'].startswith('need') and before_deadline(s['days'], s['values'][0]) != s['days']:
            # made before the generator kept dated needs ahead of their date: it comes up after the day it is for
            skipped.append({'person': pid, 'storyline': s['id'], 'thing': s['values'][0], 'why': 'the need comes up after its own date'})
            continue
        if not s['pattern'].startswith('need') and re.search(r'(?i)\b(' + re.escape(first) + r'|tentative|hypothetical|imagined|considered|potential|possible|planned)\b', s['thing']):
            # made before the generator refused such names: the question would name the owner or give the answer away
            skipped.append({'person': pid, 'storyline': s['id'], 'thing': s['thing'], 'why': "the thing names the owner or says it was only considered"})
            continue
        if not s['pattern'].startswith('need') and vague(s):
            skipped.append({'person': pid, 'storyline': s['id'], 'thing': s['thing'], 'why': 'could be confused with another storyline'})
            continue
        if not all(x['n'] in have for x in sessions for st in x['steps'] if st['story'] == s['id']):
            continue  # a step of this storyline is in a session that was never kept
        p, v, th, t = s['pattern'], s['values'], s['thing'], tby[s['id']]
        o = (s['other_person'] or '').split(' (')[0]
        W = wh(th, v)
        if p == 'plain':
            add('fact', s['id'], f'{W} is {my(th)}?', v[0])
        elif p == 'change':
            add('now', s['id'], f'{W} is {my(th)} now?', f'{v[1]} (it was {v[0]})')
            add('before', s['id'], f'{W} was {my(th)} before it changed?', v[0])
            if W != 'When':  # "when did my appointment change to 9 March" mixes the two dates up
                add('when', s['id'], f'When did {my(th)} change to {v[1]}?', date_of(sessions, s['id'], 1))
        elif p == 'heart':
            add('now', s['id'], f'{W} is {my(th)} now?', f'{v[0]} (I switched to {v[1]}, then went back)')
        elif p == 'correction':
            add('now', s['id'], f'{W} is {my(th)}?', f'{v[1]} ({v[0]} was a slip, corrected on {t["corrected_on"]})')
        elif p == 'tentative_dropped':
            add('considered', s['id'], f'Did I change {my(th)} to {v[1]}?', f'No: I only thought about it; it is still {v[0]}')
        elif p == 'tentative_confirmed':
            add('now', s['id'], f'{W} is {my(th)} now?', f'{v[1]} (changed from {v[0]} after thinking about it)')
            add('when', s['id'], f'When did I go ahead with {v[1]} for {my(th)}?', date_of(sessions, s['id'], 2))
        elif p == 'hypothetical':
            add('now', s['id'], f'{W} is {my(th)}?', f'{v[0]} ({v[1]} was only a what-if)')
        elif p == 'lookalike':
            add('whose', s['id'], f'{W} is {my(th)}?', f'{v[0]} ({v[1]} is {o}\'s)')
            add('whose', s['id'], f"{W} is {o}'s {th}?", v[1])
        elif p == 'need_met':
            add('need', s['id'], f'Am I still looking for {mine(v[0])}?', f'No: sorted on {t["need"]["met_on"]} ({v[1]})')
    gone = {x['storyline'] for x in skipped if x['person'] == pid}
    open_needs = [s for s in stories if s['pattern'] == 'need_open' and s['id'] not in gone]
    if open_needs:
        add('needs_now', None, 'Which of my needs are still open: things I am looking for someone to provide or help with (a person, a service, an item)? List them all.',
            '; '.join(s['values'][0] for s in open_needs), note='not: needs already solved, or needs of someone else')
    spell = lambda t: thing_words(t.replace('licence', 'license').replace('favourite', 'favorite'))
    used = set().union(*(spell(s['thing']) for s in stories))
    for th in rnd.sample([a for a in ABSENT if not (spell(a) - {'first', 'best', 'number'}) & used], 3):
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
    # the wording review (questions_review.json, published): {id: {"question": new wording} | {"drop": reason}}
    rp = os.path.join(OUT, 'questions_review.json')
    review = json.load(open(rp, encoding='utf-8')) if os.path.exists(rp) else {}
    unknown = set(review) - {q['id'] for q in allq}
    assert not unknown, f'review names unknown questions: {sorted(unknown)}'
    for q in allq:
        r = review.get(q['id'], {})
        if 'question' in r:
            q['plain'], q['question'] = q['question'], r['question']
        if 'drop' in r:
            skipped.append({'person': q['person'], 'storyline': q['storyline'], 'question': q['question'], 'why': 'review: ' + r['drop']})
    allq = [q for q in allq if 'drop' not in review.get(q['id'], {})]
    json.dump(allq, open(os.path.join(OUT, 'questions.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    json.dump(skipped, open(os.path.join(OUT, 'questions_skipped.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'{len(skipped)} storylines or questions not asked (reasons in questions_skipped.json)')
    by = {}
    for x in allq:
        by[x['type']] = by.get(x['type'], 0) + 1
    print(f'{len(allq)} questions: {by}')


if __name__ == '__main__':
    main()
