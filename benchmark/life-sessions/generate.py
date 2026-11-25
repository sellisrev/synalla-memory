"""Synthetic life sessions for Synalla memory's public benchmark (rules in RULES.md). Resumable, fixed seed.

  python -I -X utf8 generate.py [--url http://127.0.0.1:9090] [--model daily] [--only L01] [--max-sessions N]

Per person, in out/<id>/: storylines.json (structure from code, content from the model), truth.json (computed),
index.json (session -> steps), sessions/<n>.jsonl (Claude Code transcript format), checks.json (every rejected draft
and why). One progress line per step on stdout.
"""
import argparse, datetime, hashlib, json, os, random, re, sys, time, urllib.request, uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from needs import NEEDS  # noqa: E402

SEED = 'synalla-life-sessions-2026-11-25'
START = datetime.date(2026, 3, 2)
DAYS = 42
END = START + datetime.timedelta(days=DAYS - 1)
# LIFE_SET=dev: two extra people for tuning, kept apart from the test people (own output, needs and network)
SET = os.environ.get('LIFE_SET', 'test')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out' if SET == 'test' else 'out_dev')

# id, name, who they are; work = what "help with their work" means in a session
TEST_PEOPLE = [
    ('L01', 'Claire Morel', 'ICU nurse, 38, in Lyon; rotating 12-hour shifts; married to Julien, two children (Inès 9, Hugo 5)', 'shift rota, care plans, handover notes, training'),
    ('L02', 'Aisha Rahman', 'primary school teacher, 31, in Leeds; teaches Year 4; lives alone with her cat; sings in a choir', 'lesson plans, parent emails, reports, school trips'),
    ('L03', 'Mateo Fernández', 'owner of a 30-seat restaurant in Valencia, 46; divorced, shared custody of his son Pablo (14)', 'supplier orders, staff rota, menu costing, licences'),
    ('L04', 'Krzysztof Nowak', 'retired civil engineer, 71, in Kraków; widower; three grandchildren; allotment garden; type 2 diabetes', 'volunteer work at a local heritage society, his pension paperwork'),
    ('L05', 'Ji-woo Park', 'architecture student, 23, in Seoul; final-year studio project; part-time job at a café; shares a flat', 'studio project, model making, portfolio, internship applications'),
    ('L06', 'Thandiwe Dlamini', 'freelance photographer, 35, in Cape Town; weddings and food shoots; partner Sipho; a dog, Bongo', 'client bookings, quotes and invoices, editing, gear'),
    ('L07', 'Lukas Brandt', 'backend developer, 29, in Berlin; Go and Postgres at a mobility start-up; climbs; long-distance relationship', 'code, reviews, on-call, architecture decisions'),
    ('L08', 'Valentina Rossi', 'vineyard owner, 52, near Mendoza; family winery with her brother Marco; mother lives with her', 'harvest planning, export paperwork, buyers, workers'),
    ('L09', 'Daniel Okoye', 'corporate lawyer, 36, in Toronto; on parental leave with his newborn, Ada; wife Grace back at work', 'staying in touch with the firm, a pro bono file, return-to-work plan'),
    ('L10', 'Priya Nair', 'founder of a 6-person ed-tech start-up in Bangalore, 33; raising a seed round; lives with her parents', 'fundraising, hiring, product decisions, investor updates'),
]
DEV_PEOPLE = [
    ('D01', 'Inés Navarro', 'social worker, 44, in Seville; divorced, two teenagers (Carmen 15, Diego 13); sings flamenco with friends', 'case visits, reports, court dates, a difficult team'),
    ('D02', 'Tom Becker', 'bus driver, 55, in Hamburg; married to Birgit; a grandson, Finn (4); plays tuba in a brass band', 'shift plans, union matters, a route change, training new drivers'),
]
PEOPLE = TEST_PEOPLE if SET == 'test' else DEV_PEOPLE
THEMES = ['work', 'family', 'people', 'home', 'health', 'money', 'hobbies', 'travel', 'shopping', 'admin']
# pattern: (count per person, number of values the model fills, number of steps)
PATTERNS = {
    'plain': (10, 1), 'change': (6, 2), 'heart': (2, 2), 'correction': (2, 2), 'tentative_dropped': (2, 2),
    'tentative_confirmed': (1, 2), 'hypothetical': (2, 2), 'lookalike': (3, 2), 'need_met': (2, 2), 'need_open': (2, 1),
    'need_other': (1, 1),
}
STEPS = {'plain': 1, 'change': 2, 'heart': 3, 'correction': 2, 'tentative_dropped': 2, 'tentative_confirmed': 3,
         'hypothetical': 2, 'lookalike': 2, 'need_met': 2, 'need_open': 1, 'need_other': 1}
VALUES_HINT = {
    'plain': '[the value]',
    'change': '[old value, new value]',
    'heart': '[value A, value B]  (A, then switch to B, then back to A)',
    'correction': '[the wrong value first given, the right value]',
    'tentative_dropped': '[current value, the alternative only considered]',
    'tentative_confirmed': '[current value, the alternative considered and later adopted]',
    'hypothetical': '[current value, what it would be in an imagined case that does not happen]',
    'lookalike': "[the person's own value, the other person's value]",
    'need_met': '[the need or problem as a short phrase, how it got solved as a short phrase]',
    'need_open': '[the need or problem as a short phrase]',
    'need_other': '[the need as a short phrase; it belongs to other_person or is only imagined]',
}
NEED_TOPICS = ['babysitting', 'childcare', 'tutoring', 'language-exchange', 'moving-help', 'furniture', 'bike-repair',
               'car-repair', 'plumbing', 'electrician', 'home-cleaning', 'gardening', 'pet-sitting', 'dog-walking',
               'vet-advice', 'physiotherapy', 'doctor-recommendation', 'dentist', 'mental-health-support',
               'fitness-partner', 'running-group', 'cooking-lessons', 'catering', 'event-venue', 'photography',
               'travel-advice', 'accommodation', 'car-sharing', 'airport-ride', 'tax-advice', 'legal-advice',
               'accounting', 'insurance', 'mortgage-advice', 'job-search', 'hiring', 'mentoring', 'cofounder-search',
               'funding', 'marketing', 'website', 'it-help', 'laptop-repair', 'phone-repair', 'sewing-alterations',
               'music-lessons', 'sports-equipment', 'camping-gear', 'baby-gear', 'school-choice', 'elder-care',
               'translation', 'visa-help', 'second-hand-goods', 'wine-export', 'restaurant-equipment', 'lifts',
               'makerspace', 'camera-gear', 'tech-advice', 'farm-equipment']


def num(*parts):
    return int(hashlib.sha256(('|'.join(map(str, (SEED,) + parts))).encode()).hexdigest()[:8], 16)


def day(i):
    return (START + datetime.timedelta(days=i)).isoformat()


def post(a, prompt, schema, seed, max_tokens):
    body = {'model': a.model, 'messages': [{'role': 'user', 'content': prompt}], 'max_tokens': max_tokens, 'temperature': 0.7,
            'seed': seed, 'chat_template_kwargs': {'enable_thinking': False},
            'response_format': {'type': 'json_schema', 'json_schema': {'name': 'out', 'schema': schema, 'strict': True}}}
    req = urllib.request.Request(a.url + '/v1/chat/completions', data=json.dumps(body).encode(), headers={'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=1800) as r:
        return json.loads(json.load(r)['choices'][0]['message']['content'])


# ---------------------------------------------------------------- structure (code only)

def skeleton(pid):
    """Storylines with pattern, theme and step days, from the seed. Needs avoid the 'work' theme only by chance."""
    rnd = random.Random(num('skeleton', pid))
    out, k = [], 0
    themes = THEMES * 4
    rnd.shuffle(themes)
    for pat, (count, _) in PATTERNS.items():
        for _ in range(count):
            n = STEPS[pat]
            first = rnd.randint(0, DAYS - 1 - 4 * (n - 1)) if n > 1 else rnd.randint(0, DAYS - 1)
            days = [first]
            for _ in range(n - 1):
                days.append(min(DAYS - 1, days[-1] + rnd.randint(3, 10)))
            k += 1
            out.append({'id': f'S{k:02d}', 'pattern': pat, 'theme': themes[k % len(themes)], 'days': days})
    return out


def truth_of(s):
    """What is true about one storyline, computed from its pattern and values: a list of (from day, value) for the
    person, plus what was only considered or imagined, and need status."""
    p, v, d = s['pattern'], s['values'], s['days']
    t = {'id': s['id'], 'pattern': p, 'thing': s['thing'], 'theme': s['theme'], 'other_person': s['other_person'] or None}
    if p == 'plain':
        t['history'] = [(day(d[0]), v[0])]
    elif p == 'change':
        t['history'] = [(day(d[0]), v[0]), (day(d[1]), v[1])]
    elif p == 'heart':
        t['history'] = [(day(d[0]), v[0]), (day(d[1]), v[1]), (day(d[2]), v[0])]
    elif p == 'correction':
        t['history'] = [(day(d[0]), v[1])]            # true all along; the wrong value was a slip
        t['said_wrongly'] = (day(d[0]), v[0]); t['corrected_on'] = day(d[1])
    elif p == 'tentative_dropped':
        t['history'] = [(day(d[0]), v[0])]; t['considered'] = (day(d[1]), v[1])
    elif p == 'tentative_confirmed':
        t['history'] = [(day(d[0]), v[0]), (day(d[2]), v[1])]; t['considered'] = (day(d[1]), v[1])
    elif p == 'hypothetical':
        t['history'] = [(day(d[0]), v[0])]; t['imagined'] = (day(d[1]), v[1])
    elif p == 'lookalike':
        t['history'] = [(day(d[0]), v[0])]; t['other_value'] = (day(d[1]), v[1])
    elif p == 'need_met':
        t['need'] = {'what': v[0], 'topic': s['topic'], 'open_from': day(d[0]), 'met_on': day(d[1]), 'how': v[1]}
    elif p == 'need_open':
        t['need'] = {'what': v[0], 'topic': s['topic'], 'open_from': day(d[0]), 'met_on': None}
    elif p == 'need_other':
        t['need'] = {'what': v[0], 'topic': s['topic'], 'open_from': day(d[0]), 'met_on': None, 'not_the_persons': True}
    if 'history' in t:
        t['now'] = t['history'][-1][1]
    return t


def steps_of(s, full_name):
    """The steps of one storyline: (day index, note for the writer, strings that must appear)."""
    p, v, d, th = s['pattern'], s['values'], s['days'], s['thing']
    name = full_name.split()[0]
    o = s['other_person']
    if p == 'plain':
        return [(d[0], f"{name}'s {th} is {v[0]}.", [v[0]])]
    if p == 'change':
        return [(d[0], f"{name}'s {th} is {v[0]}.", [v[0]]),
                (d[1], f"{name}'s {th} has changed: now {v[1]} (it was {v[0]}).", [v[1]])]
    if p == 'heart':
        return [(d[0], f"{name}'s {th} is {v[0]}.", [v[0]]),
                (d[1], f"{name} has switched the {th} to {v[1]}.", [v[1]]),
                (d[2], f"{name} changes mind about the {th}: back to {v[0]}, not {v[1]} any more.", [v[0]])]
    if p == 'correction':
        return [(d[0], f"{name}'s {th} is {v[0]}.", [v[0]]),
                (d[1], f'{name} corrects an earlier slip: the {th} is {v[1]}, not {v[0]}.', [v[1]])]
    if p == 'tentative_dropped':
        return [(d[0], f"{name}'s {th} is {v[0]}.", [v[0]]),
                (d[1], f'{name} is only thinking about changing the {th} to {v[1]}; nothing decided.', [v[1]])]
    if p == 'tentative_confirmed':
        return [(d[0], f"{name}'s {th} is {v[0]}.", [v[0]]),
                (d[1], f'{name} is thinking about changing the {th} to {v[1]}; not decided yet.', [v[1]]),
                (d[2], f'{name} has now gone ahead: the {th} is {v[1]}.', [v[1]])]
    if p == 'hypothetical':
        return [(d[0], f"{name}'s {th} is {v[0]}.", [v[0]]),
                (d[1], f'{name} imagines a what-if: then the {th} would be {v[1]}. Only an idea; nothing changes.', [v[1]])]
    if p == 'lookalike':
        return [(d[0], f"{name}'s own {th} is {v[0]}.", [v[0]]),
                (d[1], f"{o}'s {th} is {v[1]} (about {o}, not {name}).", [v[1], o.split()[0]])]
    if p == 'need_met':
        return [(d[0], f'{name} needs {v[0]} (not sorted yet).', [s['keyword']]),
                (d[1], f"{name}'s need is sorted: {v[1]}.", key_parts(v[1]))]
    if p == 'need_open':
        return [(d[0], f'{name} needs {v[0]} (not sorted yet).', [s['keyword']])]
    if p == 'need_other':
        return [(d[0], f"a need that is not {name}'s own: {v[0]} ({o or 'only imagined'}).", [s['keyword']])]
    raise ValueError(p)


# ---------------------------------------------------------------- content (local model), checked by code

FILL_SCHEMA = {'type': 'object', 'additionalProperties': False, 'required': ['storylines'], 'properties': {'storylines': {
    'type': 'array', 'items': {'type': 'object', 'additionalProperties': False,
        'required': ['id', 'thing', 'values', 'other_person', 'topic', 'keyword'],
        'properties': {'id': {'type': 'string'}, 'thing': {'type': 'string'}, 'values': {'type': 'array', 'items': {'type': 'string'}},
                       'other_person': {'type': 'string'}, 'topic': {'type': 'string', 'enum': NEED_TOPICS + ['none']},
                       'keyword': {'type': 'string'}}}}}}


TOPIC_SCHEMA = {'type': 'object', 'additionalProperties': False, 'required': ['topics'], 'properties': {'topics': {
    'type': 'array', 'items': {'type': 'object', 'additionalProperties': False, 'required': ['id', 'topic'],
        'properties': {'id': {'type': 'string'}, 'topic': {'type': 'string', 'enum': NEED_TOPICS}}}}}}


COMMON = set('''home work school office house flat car bus train tram bike metro gym park beach city town centre center
garden kitchen bedroom morning evening night noon weekend monday tuesday wednesday thursday friday saturday sunday
today tomorrow week month year doctor dentist nurse teacher mother father sister brother friend family wife husband
partner son daughter baby grandma grandpa granny nanny shop market store online cash card bank phone email mail
coffee tea lunch dinner breakfast yes none other same new old later soon early late daily weekly monthly
spring summer autumn winter march april may june'''.split())


# values used as examples in the fill prompt: never accepted as content
EXAMPLES = {'dr. okafor', 'dr. haddad', '950 euros a month', 'the 7:40 bus', 'the ter from vienne', 'sara (sister)',
            'marc (neighbour)', '55 euros', 'axa insurance', 'babysitter'}


def key_parts(v):
    """The parts of a phrase that must appear when the phrase itself need not: names and numbers."""
    parts = re.findall(r"[A-Z][\w'\-]+(?:\s+[A-Z][\w'\-]+)*|\d[\d.,:/]*", v[1:]) if len(v.split()) > 2 else []
    return [x for x in parts if x.lower() not in COMMON and len(x) >= 2] or [v]


def item_problems(s, g, taken):
    """What is wrong with one filled storyline; `taken` = values (lowercase) already used by accepted storylines."""
    probs = []
    want = PATTERNS[s['pattern']][1]
    if len(g['values']) != want:
        probs.append(f"needs exactly {want} values, got {len(g['values'])}")
    for v in g['values']:
        if len(v.strip()) < 4:
            probs.append(f"value {v!r} is too short: write at least 4 characters, e.g. '55 euros', 'AXA insurance'")
        # a repeat: the same value, or one value of two or more words inside another ("Hamburg" alone inside
        # "BlasWelt Hamburg" is not a repeat; "Kiné Bellecour" inside "booked at Kiné Bellecour" is)
        clash = [t for t in taken if t == v.lower()
                 or (len(t.split()) > 1 and re.search(r'(?<!\w)' + re.escape(t) + r'(?!\w)', v.lower()))
                 or (len(v.split()) > 1 and re.search(r'(?<!\w)' + re.escape(v.lower()) + r'(?!\w)', t))]
        if clash:
            probs.append(f"value {v!r} repeats a value already used elsewhere ({clash[0]!r}): use different words")
        if not (re.search(r'\d', v) or re.search(r'[A-Z]', v) or len(v.split()) >= 2):
            probs.append(f"value {v!r} is not specific: use a name, a brand, an amount or a few words")
        if v.strip().lower() in EXAMPLES:
            probs.append(f"value {v!r} is an example from the instructions: invent your own")
        if v.strip().lower() in COMMON:
            probs.append(f"value {v!r} is a common word: make it specific (a name, a brand, an amount, a date)")
    if len(set(x.lower() for x in g['values'])) != len(g['values']):
        probs.append('the values must differ')
    need = s['pattern'].startswith('need')
    if any(re.match(r'\s*(need|solved|problem|value)\s*:', v, re.I) for v in g['values']):
        probs.append('no labels or prefixes inside a value')
    if need and g['values'] and (len(g['values'][0].split()) < 4 or re.match(r'\s*(i\s+)?needs?\b(?!-)', g['values'][0], re.I)):
        probs.append('the need must be a full phrase of 4+ words that does not start with "need" (what, for when, where)')
    if need and g['values'] and (len(g['keyword']) < 4 or g['keyword'].lower() not in g['values'][0].lower()):
        probs.append('keyword must be one word (4+ letters) copied from the need phrase')
    if s['pattern'] == 'need_met' and len(g['values']) == 2 and key_parts(g['values'][1]) == [g['values'][1]] and len(g['values'][1].split()) > 2:
        probs.append('say how the need was solved with a name, a place or a number in it (e.g. "booked a physio at Kiné Bellecour")')
    if s['pattern'] == 'lookalike' and len(g['other_person'].strip()) < 3:
        probs.append('lookalike needs other_person')
    return probs


def fill(a, pid, name, bio, work):
    path = os.path.join(OUT, pid, 'storylines.json')
    if os.path.exists(path):
        return json.load(open(path, encoding='utf-8'))
    full_sk = skeleton(pid)
    curated = needs_of(pid, full_sk)          # needs are written by hand (needs.py), the rest by the model
    sk = [s for s in full_sk if s['id'] not in curated]
    done = {}
    for restart in range(2):  # a restart keeps what was accepted and tries the rest with new seeds
        done, notes = fill_rounds(a, pid, name, bio, work, sk, restart, curated, done)
        if len(done) == len(sk):
            break
        print(f'{pid}: fill restart after 12 rounds: {notes}', flush=True)
    dropped = [s['id'] for s in sk if s['id'] not in done]
    if len(dropped) > 3:
        sys.exit(f'{pid}: {len(dropped)} storylines still invalid after two starts: {notes}')
    if dropped:  # a few storylines the model never got right are left out (published in storylines.json)
        print(f'{pid}: dropped storylines {dropped}: {notes}', flush=True)
    done.update(curated)
    full = [{**s, **{k: done[s['id']][k] for k in ('thing', 'values', 'other_person', 'keyword', 'topic')}} for s in full_sk if s['id'] in done]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(full, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    return full


SENSE_SCHEMA = {'type': 'object', 'additionalProperties': False, 'required': ['bad'], 'properties': {'bad': {
    'type': 'array', 'items': {'type': 'object', 'additionalProperties': False, 'required': ['id', 'why'],
        'properties': {'id': {'type': 'string'}, 'why': {'type': 'string'}}}}}}


def sense_check(a, pid, name, filled, sk_by_id, attempt):
    """Ask the model which storyline sentences are nonsense ("her mother's birthday is Geneviève")."""
    first = name.split()[0]
    lines = []
    for k, g in filled.items():
        p = sk_by_id[k]['pattern']
        lines.append(f"- {k}: {first}'s {g['thing']} is {g['values'][0]}.")
        if p == 'lookalike':
            lines.append(f"- {k}: {g['other_person'].split(' (')[0]}'s {g['thing']} is {g['values'][1]}.")
        elif len(g['values']) > 1:
            lines.append(f"- {k}: (or, later or in another case) {first}'s {g['thing']} is {g['values'][1]}.")
    prompt = (f"Each line is meant to be a plain, sensible fact about {name}. List the ids of lines that do not make sense "
              f"as written (the value is not the kind of thing the subject is, e.g. a birthday that is a name, a garage "
              f"code that is someone else's, a thing that names a hypothetical). An empty list is fine.\n\n" + '\n'.join(lines))
    try:
        return post(a, prompt, SENSE_SCHEMA, (num('sense', pid) + attempt) % 100000, 4000)['bad']
    except (ValueError, KeyError) as e:
        print(f'{pid} sense check unreadable ({e!r}); skipped this round'[:200], flush=True)
        return []


def needs_of(pid, sk):
    """Map the skeleton's need storylines to the hand-written needs, in order per pattern."""
    pool = {}
    for pat, phrase, kw, topic, extra in NEEDS[pid]:
        pool.setdefault(pat, []).append((phrase, kw, topic, extra))
    out = {}
    for s in sk:
        if s['pattern'].startswith('need'):
            phrase, kw, topic, extra = pool[s['pattern']].pop(0)
            vals = [phrase, extra] if s['pattern'] == 'need_met' else [phrase]
            out[s['id']] = {'thing': 'need', 'values': vals, 'keyword': kw, 'topic': topic,
                            'other_person': extra if s['pattern'] == 'need_other' else ''}
    assert not any(pool.values()), f'{pid}: unused needs'
    return out


def fill_rounds(a, pid, name, bio, work, sk, restart, curated, done=None):
    done, notes = dict(done or {}), {}
    for attempt in range(12):
        todo = [s for s in sk if s['id'] not in done]
        if not todo:
            break
        try:
            got = post(a, fill_prompt(name, bio, work, todo, {**curated, **done}, notes), FILL_SCHEMA, (num('fill', pid, restart) + attempt) % 100000, 12000)['storylines']
        except (ValueError, KeyError) as e:  # a reply cut short or malformed: try again with the next seed
            print(f'{pid} fill round {attempt + 1}: unreadable reply ({e!r})'[:200], flush=True)
            continue
        byid = {g['id']: g for g in got}
        for s in todo:
            g = byid.get(s['id'])
            taken = {v.lower() for d in list(done.values()) + list(curated.values()) for v in d['values']}
            probs = ['missing'] if not g else item_problems(s, g, taken)
            if g and g['thing'].strip().lower() in {d['thing'].strip().lower() for d in done.values()}:
                probs.append(f"another storyline is already about '{g['thing']}': pick a different thing")
            bio_words = {w.lower().strip(',;()') for w in (name + ' ' + bio).split()}
            if g and any(v.strip().lower() in bio_words or name.split()[0].lower() in v.lower() for v in g['values']):
                probs.append("a value must not be the owner's name or a single word from who they are (their city, family, instrument): it would come up in every conversation")
            if g and (name.split()[0].lower() in g['thing'].lower() or re.search(r'\b(tentative|hypothetical|imagined|own|considered)\b', g['thing'], re.I)):
                probs.append("the thing must not contain the owner's name or words like tentative, hypothetical, own: name the kind of thing only")
            if g and g['other_person'] and g['other_person'].split()[0].lower() in g['thing'].lower():
                probs.append("the thing must not name the other person: name the kind of thing only")
            if g:
                for c in curated.values():
                    kw = c['keyword'].lower()
                    if any(re.search(r'(?<!\w)' + re.escape(kw) + r'(?!\w)', t.lower()) for t in [g['thing']] + g['values']):
                        probs.append(f"conflicts with a need: {name.split()[0]} is still looking for {c['values'][0]}; pick another thing")
            if probs:
                notes[s['id']] = probs
            else:
                done[s['id']] = g
                notes.pop(s['id'], None)
        fresh = {k: v for k, v in done.items() if k in byid and k not in notes}
        if fresh:
            for bad in sense_check(a, pid, name, {k: v for k, v in fresh.items()}, {s2['id']: s2 for s2 in sk}, attempt):
                if bad['id'] in done:
                    notes[bad['id']] = [f"the sentence does not make sense: {bad['why']}"]
                    del done[bad['id']]
        print(f'{pid} fill round {attempt + 1}: {len(done)}/{len(sk)} accepted; open {dict(list(notes.items())[:2])}', flush=True)
    return done, notes


def fill_prompt(name, bio, work, todo, done, notes):
    lines = '\n'.join(f"- {s['id']}: pattern {s['pattern']}, theme {s['theme']}, dates {', '.join(day(x) for x in s['days'])}, values {VALUES_HINT[s['pattern']]}"
                      + (f"  PREVIOUS ATTEMPT WRONG: {'; '.join(notes[s['id']])}" if s['id'] in notes else '') for s in todo)
    already = '\n'.join(f"- {g['thing']}: {', '.join(g['values'])}" for g in done.values())
    return f"""You are designing the life of {name}, {bio}, over 6 weeks from {day(0)} to {day(DAYS - 1)}.
Their work: {work}. Below is a fixed list of storylines. For each, invent content that fits {name} and the theme.

Each storyline is something a good personal assistant would remember about {name} because it stays true for weeks and
matters later: people in their life (names, relations, birthdays, schools, jobs), where things are (home, workplace,
the children's school), schedules and bookings, providers they use (doctor, garage, bank, supplier), health, money
commitments (rent, a loan, a subscription), preferences, plans, numbers they will need again. Not one-off receipts or
trivia (no grocery bills, parking tickets, a single coffee).

For each storyline give:
- thing: what it is about, as a short noun phrase without the owner's name. "{name}'s <thing> is <value>" must read
  as a natural, true sentence (thing "dentist", value "Dr. Okafor"; thing "rent", value "950 euros a month").
- values: exactly the values asked for, each short and specific (a name, a place, a weekday, a date, a time, an amount
  with its currency, a brand, a number), written exactly as it would be said in conversation, at least 4 characters,
  all different across all storylines. No labels or prefixes inside a value.
- other_person: for lookalike, the other person (first name and relation, e.g. "Sara (sister)"), a different person
  for each lookalike; for need_other, whose need it is ("Marc (neighbour)"), or "" if it is only imagined; otherwise "".
- keyword: always "".
- topic: always "none" (set later).

Patterns: plain = stated once; change = replaced by a new value; heart = A, then B, then back to A; correction = a
wrong value said by mistake, later corrected; tentative_dropped = an alternative considered and not done;
tentative_confirmed = considered, later done; hypothetical = a real thing of theirs, with its current value and what
it would be in an imagined situation that does not happen (thing "commute", values "the 7:40 bus", "the TER from
Vienne" for "if I took the Grenoble job"); lookalike = a thing both they and someone else have, with their own value
and the other person's value (thing "dentist": theirs "Dr. Okafor", their sister's "Dr. Haddad"). The thing never
contains words like "hypothetical", "own" or another person's name.

""" + (f"""{name.split()[0]} is still looking for these, so no storyline may give them one: {'; '.join(g['values'][0] for g in done.values() if g.get('thing') == 'need')}.

""" if any(g.get('thing') == 'need' for g in done.values()) else '') + (f"""Already decided (keep consistent with these, and do not reuse their values):
{already}

""" if already else '') + f"""Invent all names, places and phrases yourself for this person: do not reuse the example words in these instructions.

Storylines to fill now (give one item per id, nothing else):
{lines}"""


def plan(pid, stories, name):
    """Session days and the steps each session carries. A step comes up on its day (70%) or 1-6 days later with the
    date said. At most 2 steps per session; sessions on about 48 days, some days twice."""
    rnd = random.Random(num('plan', pid))
    sdays = sorted(list(range(DAYS)) + rnd.sample(range(DAYS), 6))
    sessions = [{'n': i + 1, 'day': x, 'steps': []} for i, x in enumerate(sdays)]
    steps = sorted(((d, s['id'], k, text, must) for s in stories for k, (d, text, must) in enumerate(steps_of(s, name))), key=lambda x: (x[0], x[1], x[2]))
    last = {}  # story -> session number of its previous step; a step always lands in a later session
    for d, sid, k, text, must in steps:
        late = rnd.random() < 0.3
        after = last.get(sid, 0)
        free = [x for x in sessions if x['n'] > after and len(x['steps']) < 2]
        cands = [x for x in free if (d < x['day'] <= d + 6 if late else x['day'] == d)]
        cands = cands or [x for x in free if x['day'] >= d]
        if not cands:  # end of the period is full: one more session on the last day
            sessions.append({'n': len(sessions) + 1, 'day': max(d, sessions[-1]['day']), 'steps': []})
            cands = sessions[-1:]
        x = cands[0] if not late else rnd.choice(cands)
        pat = next(s['pattern'] for s in stories if s['id'] == sid)
        dated = k > 0 or pat.startswith('need')  # a change, a correction, a need: its day is asked about
        x['steps'].append({'story': sid, 'step': k, 'day': d, 'said_late': x['day'] > d and dated, 'text': text, 'must': must})
        last[sid] = x['n']
    # a story's steps stay in order: a later step never lands in an earlier session than the step before it
    pos = {}
    for x in sessions:
        for st in x['steps']:
            prev = pos.get(st['story'], -1)
            if x['n'] <= prev:
                sys.exit(f'{pid}: step order broken for {st["story"]}')
            pos[st['story']] = x['n']
    for x in sessions:
        x['date'] = day(x['day'])
        work = [st for st in x['steps'] if next(s for s in stories if s['id'] == st['story'])['theme'] == 'work']
        x['kind'] = 'work' if work or (not x['steps'] and rnd.random() < 0.4) else 'life'
    return sessions


def known_on(stories, sessions, upto_n):
    """What the person has said so far (before session upto_n), as true on that day: the writer may repeat it."""
    said = {}
    for x in sessions:
        if x['n'] >= upto_n:
            break
        for st in x['steps']:
            said[st['story']] = st['step']
    out = []
    for s in stories:
        if s['id'] not in said:
            continue
        k, p, v = said[s['id']], s['pattern'], s['values']
        if p in ('plain', 'hypothetical', 'tentative_dropped', 'lookalike'):
            out.append(f"their {s['thing']}: {v[0]}")
        elif p == 'change':
            out.append(f"their {s['thing']}: {v[min(k, 1)]}")
        elif p == 'heart':
            out.append(f"their {s['thing']}: {v[1] if k == 1 else v[0]}")
        elif p == 'correction':
            out.append(f"their {s['thing']}: {v[0] if k == 0 else v[1]}")
        elif p == 'tentative_confirmed':
            out.append(f"their {s['thing']}: {v[1] if k == 2 else v[0]}")
        elif p == 'need_met' and k == 0:
            out.append(f'still looking for: {v[0]}')
        elif p == 'need_open':
            out.append(f'still looking for: {v[0]}')
    return out


def forbidden(stories, sessions, x):
    """Values the session must not contain: every storyline value that is not true and said by this session's date,
    unless one of this session's own steps carries it."""
    allowed = set()
    for st in x['steps']:
        s = next(s for s in stories if s['id'] == st['story'])
        # a first step carries the first value (and its own required words); later steps may name all the values
        allowed |= {v.lower() for v in s['values']} if st['step'] > 0 else {s['values'][0].lower()} | {m.lower() for m in st['must']}
    ok_now = {line.split(': ', 1)[1].lower() for line in known_on(stories, sessions, x['n'])}
    bad = []
    for s in stories:
        for v in s['values']:
            lv = v.lower()
            if lv not in allowed and lv not in ok_now:
                bad.append(v)
    return bad


SMALL = {'every', 'each', 'the', 'a', 'an', 'on', 'at', 'in', 'of', 'for', 'to', 'and', 'with', 'from', 'my', 'her', 'his'}


def carries(text, v):
    """A required value is said: word for word, or with all its names, numbers and capitalised words
    ("Every Thursday" said as "on Thursdays" does not count; "each Thursday" does)."""
    if has(text, v):
        return True
    toks = [w for w in re.findall(r"[\w'’.-]+", v) if w.lower() not in SMALL and (w[0].isupper() or w[0].isdigit())]
    return bool(toks) and all(has(text, w) for w in toks)


def has(text, v):
    return re.search(r'(?<![\w])' + re.escape(v.lower()) + r'(?![\w])', text) is not None


SESSION_SCHEMA = {'type': 'object', 'additionalProperties': False, 'required': ['title', 'turns'], 'properties': {
    'title': {'type': 'string'},
    'turns': {'type': 'array', 'minItems': 4, 'maxItems': 14, 'items': {'type': 'object', 'additionalProperties': False,
        'required': ['role', 'text'], 'properties': {'role': {'type': 'string', 'enum': ['user', 'assistant']}, 'text': {'type': 'string'}}}}}}


def write_session(a, pid, name, bio, work, stories, sessions, x, attempt):
    known = known_on(stories, sessions, x['n'])
    known = [k for k in known if not k.startswith('still looking for')]  # open needs are not repeated as background
    r = random.Random(num('known', pid, x['n'], attempt))  # at most one, in half the sessions: background invites invented detail
    known = r.sample(known, min(1, len(known))) if r.random() < 0.5 else []
    steps = '\n'.join(f"- {st['text']}" + (f" This happened on {datetime.date.fromisoformat(day(st['day'])):%A} {datetime.date.fromisoformat(day(st['day'])).day} {datetime.date.fromisoformat(day(st['day'])):%B}: say that date as people do (\"on Thursday 5 March\", \"last Monday, the 9th\")." if st['said_late'] else '') for st in x['steps'])
    task = (f'help with their work ({work})' if x['kind'] == 'work' else
            'everyday help (a message to write, planning, shopping, cooking, a health or money question, paperwork, travel, a hobby)')
    prompt = f"""Write one realistic conversation between {name} ({bio}) and their personal AI agent on {x['date']}
({datetime.date.fromisoformat(x['date']).strftime('%A')}). The conversation is about {task}; pick something concrete.
4 to 14 turns, alternating user and assistant, starting with the user. Most of it is the ordinary task.
""" + (f"""These notes must come up naturally along the way, in {name.split()[0]}'s own words (do not copy the notes), with the exact
names, numbers and dates:
{steps}
""" if x['steps'] else f"""Nothing new about {name}'s life comes up in this one: no new facts, plans, changes or problems.
""") + (f"""Background, true today. Mention at most one of these, and only if it fits the task; never change it: {'; '.join(known)}.
""" if known else '') + """Do not add details (dates, days, amounts, names, places) to the things above beyond what is written here, and do not
invent other facts about {name}'s family, home, health, money or work: keep the rest of the talk on the task itself.
Write the way people talk, not in labels. Do not mention that this is synthetic. Give a short title.""".replace('{name}', name)
    return post(a, prompt, SESSION_SCHEMA, (num('session', pid, x['n']) + attempt) % 100000, 6000)


def session_problems(stories, sessions, x, s):
    text = ' '.join(t['text'] for t in s['turns']).lower()
    probs = [f'missing {m!r}' for st in x['steps'] for m in st['must'] if not carries(text, m)]
    probs += [f'states {v!r}' for v in forbidden(stories, sessions, x) if has(text, v)]
    if any(st['said_late'] for st in x['steps']):
        for st in x['steps']:
            if st['said_late']:
                dt = datetime.date.fromisoformat(day(st['day']))
                forms = [dt.isoformat(), f'{dt.day} {dt:%B}'.lower(), f'{dt:%B} {dt.day}'.lower(), f'{dt.day}th', f'{dt.day}st', f'{dt.day}nd', f'{dt.day}rd']
                if not any(f in text for f in forms):
                    probs.append(f"date {dt} not said")
    return probs


def to_jsonl(pid, x, s):
    sid = str(uuid.UUID(int=num('sid', pid, x['n']) << 96 | num('sid2', pid, x['n'])))
    t = datetime.datetime.fromisoformat(x['date'] + 'T08:00:00') + datetime.timedelta(minutes=num('t', pid, x['n']) % 720)
    lines = [json.dumps({'type': 'ai-title', 'aiTitle': s['title'], 'sessionId': sid})]
    for k, turn in enumerate(s['turns']):
        ts = (t + datetime.timedelta(minutes=2 * k)).isoformat() + 'Z'
        content = turn['text'] if turn['role'] == 'user' else [{'type': 'text', 'text': turn['text']}]
        lines.append(json.dumps({'type': turn['role'], 'sessionId': sid, 'timestamp': ts, 'isSidechain': False, 'cwd': f'/home/{pid.lower()}',
                                 'message': {'role': turn['role'], 'content': content}}, ensure_ascii=False))
    return '\n'.join(lines) + '\n'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', default='http://127.0.0.1:9090')
    ap.add_argument('--model', default='daily')
    ap.add_argument('--only', default='')
    ap.add_argument('--max-sessions', type=int, default=0, help='stop each person after this many sessions (first check)')
    ap.add_argument('--plan-only', action='store_true')
    a = ap.parse_args()
    for pid, name, bio, work in PEOPLE:
        if a.only and pid not in a.only.split(','):
            continue
        t0 = time.time()
        stories = fill(a, pid, name, bio, work)
        root = os.path.join(OUT, pid)
        json.dump([truth_of(s) for s in stories], open(os.path.join(root, 'truth.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        sessions = plan(pid, stories, name)
        json.dump(sessions, open(os.path.join(root, 'index.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        noise = sum(1 for x in sessions if not x['steps'])
        print(f'{pid}: {len(stories)} storylines, {sum(len(x["steps"]) for x in sessions)} steps in {len(sessions)} sessions ({noise} noise) ({time.time() - t0:.0f}s)', flush=True)
        if a.plan_only:
            continue
        os.makedirs(os.path.join(root, 'sessions'), exist_ok=True)
        cp = os.path.join(root, 'checks.json')
        checks = json.load(open(cp, encoding='utf-8')) if os.path.exists(cp) else {}
        for x in sessions[: a.max_sessions or None]:
            path = os.path.join(root, 'sessions', f'{x["n"]:03d}.jsonl')
            if os.path.exists(path):
                continue
            t1 = time.time()
            base = len(checks.get(str(x['n']), []))  # every rejection (string check or judge) moves to a new seed
            for attempt in range(base, base + 4):
                try:
                    s = write_session(a, pid, name, bio, work, stories, sessions, x, attempt)
                except Exception as e:
                    print(f'{pid} session {x["n"]} attempt {attempt + 1} FAILED: {e!r}'[:300], flush=True)
                    continue
                probs = session_problems(stories, sessions, x, s)
                if not probs:
                    break
                checks.setdefault(str(x['n']), []).append(probs)
                json.dump(checks, open(cp, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
                print(f'{pid} session {x["n"]} attempt {attempt + 1} rejected: {probs[:3]}', flush=True)
            else:
                print(f'{pid} session {x["n"]} GAVE UP after 4 attempts', flush=True)
                continue
            open(path, 'w', encoding='utf-8').write(to_jsonl(pid, x, s))
            print(f'{pid} session {x["n"]}/{len(sessions)} {x["kind"]} {len(s["turns"])} turns, steps {[st["story"] for st in x["steps"]]} ({time.time() - t1:.0f}s)', flush=True)
    print('ALL DONE', flush=True)


if __name__ == '__main__':
    main()
