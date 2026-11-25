"""Synthetic network for the proactive-matching track (RULES.md): other people's agents and their circle/1 entries.

  python -I -X utf8 network.py        -> out/network.json (entries) and out/network_truth.json (what should match)

No model: structure and texts come from code and a fixed seed, so the truth is exact. Every need in needs.py gets:
- true matches: one entry (two for needs still open at the end) on its topic, tagged with the person's city, not
  expired, from a member who is not the person;
- near misses: the same topic in another city, the same topic but expired, a neighbouring topic in the same city;
- and every member also offers two or three unrelated entries.
A proposal is right when it names a true match for a need of the person that is open on that day (open from the
session where it first comes up until the session where it is solved). Proposals for someone else's or imagined needs,
for needs already solved, or naming a near miss, are false alarms.
"""
import datetime, hashlib, json, os, random, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from needs import NEEDS  # noqa: E402
from generate import PEOPLE, NEED_TOPICS, OUT, START, DAYS  # noqa: E402  (LIFE_SET picks test or dev)

SEED = 'synalla-life-network-2026-11-25'
CITY = {'D01': 'seville', 'D02': 'hamburg', 'V01': 'gothenburg', 'V02': 'marseille', 'L01': 'lyon', 'L02': 'leeds', 'L03': 'valencia', 'L04': 'krakow', 'L05': 'seoul', 'L06': 'cape-town',
        'L07': 'berlin', 'L08': 'mendoza', 'L09': 'toronto', 'L10': 'bangalore'}
# what kind of circle/1 entry fits a topic (type only ranks in matching; topic decides)
TYPE = {'second-hand-goods': 'offer', 'baby-gear': 'lend', 'camping-gear': 'lend', 'sports-equipment': 'lend', 'camera-gear': 'lend',
        'gardening': 'lend', 'farm-equipment': 'offer', 'restaurant-equipment': 'offer', 'furniture': 'offer',
        'doctor-recommendation': 'recommend', 'physiotherapy': 'recommend', 'dentist': 'recommend', 'accounting': 'recommend',
        'tax-advice': 'recommend', 'legal-advice': 'recommend', 'mortgage-advice': 'recommend', 'funding': 'intro',
        'cofounder-search': 'intro', 'hiring': 'intro', 'job-search': 'intro', 'wine-export': 'intro', 'mentoring': 'help'}
# neighbouring topics: close enough to fool a careless matcher, wrong for the need
NEAR = {'babysitting': 'childcare', 'childcare': 'babysitting', 'physiotherapy': 'doctor-recommendation', 'music-lessons': 'tutoring',
        'tutoring': 'music-lessons', 'pet-sitting': 'dog-walking', 'dog-walking': 'pet-sitting', 'translation': 'language-exchange',
        'language-exchange': 'translation', 'second-hand-goods': 'furniture', 'mentoring': 'job-search', 'job-search': 'mentoring',
        'moving-help': 'car-sharing', 'hiring': 'job-search', 'accounting': 'tax-advice', 'tax-advice': 'accounting',
        'restaurant-equipment': 'second-hand-goods', 'lifts': 'car-sharing', 'it-help': 'laptop-repair', 'gardening': 'farm-equipment',
        'fitness-partner': 'running-group', 'makerspace': 'it-help', 'accommodation': 'moving-help', 'photography': 'camera-gear',
        'camera-gear': 'photography', 'event-venue': 'catering', 'tech-advice': 'it-help', 'elder-care': 'home-cleaning',
        'wine-export': 'marketing', 'farm-equipment': 'restaurant-equipment', 'mortgage-advice': 'insurance', 'baby-gear': 'second-hand-goods',
        'doctor-recommendation': 'physiotherapy', 'cofounder-search': 'hiring', 'funding': 'mentoring', 'legal-advice': 'accounting'}
FIRST = ['Ana', 'Ben', 'Chen', 'Dara', 'Eli', 'Fatou', 'Gus', 'Hira', 'Ivo', 'Jules', 'Kemi', 'Lars', 'Mina', 'Nico', 'Omar',
         'Pia', 'Quinn', 'Rosa', 'Sami', 'Tess', 'Uma', 'Vik', 'Wren', 'Xavi', 'Yara', 'Zeno']
END_TS = int(datetime.datetime.combine(START + datetime.timedelta(days=DAYS + 60), datetime.time()).timestamp())
EXPIRED_TS = int(datetime.datetime.combine(START - datetime.timedelta(days=10), datetime.time()).timestamp())


def num(*parts):
    return int(hashlib.sha256(('|'.join(map(str, (SEED,) + parts))).encode()).hexdigest()[:8], 16)


def words(topic):
    return topic.replace('-', ' ')


def entry(rnd, eid, topic, city, expired=False):
    t = TYPE.get(topic, 'help')
    text = {'offer': f'I have {words(topic)} to pass on, in {city.replace("-", " ").title()}.',
            'lend': f'I can lend {words(topic)}; pick up in {city.replace("-", " ").title()}.',
            'recommend': f'I can recommend someone good for {words(topic)} in {city.replace("-", " ").title()}.',
            'intro': f'I can introduce you to people for {words(topic)} in {city.replace("-", " ").title()}.',
            'help': f'Happy to help with {words(topic)} in {city.replace("-", " ").title()}.'}[t]
    return {'v': 'circle/1', 'id': eid, 'type': t, 'topic': topic, 'tags': [city], 'text': text,
            'expires': EXPIRED_TS if expired else END_TS}


def main():
    rnd = random.Random(num('network'))
    members, truth = [], []
    k = 0

    def member(city):
        nonlocal k
        k += 1
        m = {'id': f'M{k:03d}', 'name': f'{FIRST[k % len(FIRST)]} {chr(65 + k % 26)}.', 'city': city, 'entries': []}
        members.append(m)
        return m

    def add(m, topic, city, expired=False):
        e = entry(rnd, f"{m['id']}-e{len(m['entries']) + 1}", topic, city, expired)
        m['entries'].append(e)
        return e['id']

    city_topics = {}
    mine = {p[0] for p in PEOPLE}
    cities = sorted({CITY[p] for p in mine} | {'madrid', 'vienna', 'oslo'})  # + cities where nobody in the set lives
    for pid, items in NEEDS.items():
        if pid not in mine:
            continue
        city_topics.setdefault(CITY[pid], set()).update(x[3] for x in items)

    def near_topic(topic, city):  # never a topic that is a real need in that city
        t = NEAR.get(topic)
        while t is None or t in city_topics.get(city, set()):
            t = rnd.choice(NEED_TOPICS)
        return t
    for pid, items in NEEDS.items():
        if pid not in mine:
            continue
        city = CITY[pid]
        for i, (pat, phrase, kw, topic, extra) in enumerate(items):
            n_true = 2 if pat == 'need_open' else 1
            true_ids = [add(member(city), topic, city) for _ in range(n_true)]
            other_city = rnd.choice([c for c in cities if c != city and topic not in city_topics.get(c, set())])
            near = [add(member(other_city), topic, other_city),            # same topic, wrong place
                    add(member(city), topic, city, expired=True),          # same topic, expired
                    add(member(city), near_topic(topic, city), city)]  # neighbouring topic
            truth.append({'person': pid, 'need': f'{pid}-N{i + 1}', 'pattern': pat, 'phrase': phrase, 'topic': topic,
                          'city': city, 'true': true_ids if pat != 'need_other' else [], 'would_fit': true_ids,
                          'near_misses': near})
    planted = {(t['topic'], t['city']) for t in truth}
    for m in members:  # unrelated offers, so most entries are noise; never on a need's topic in its city
        for _ in range(rnd.randint(2, 3)):
            while True:
                topic, city = rnd.choice(NEED_TOPICS), rnd.choice([m['city']] * 3 + cities)
                if (topic, city) not in planted:
                    break
            add(m, topic, city)
    os.makedirs(OUT, exist_ok=True)
    json.dump({'members': members}, open(os.path.join(OUT, 'network.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    json.dump(truth, open(os.path.join(OUT, 'network_truth.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    n = sum(len(m['entries']) for m in members)
    print(f'{len(members)} members, {n} entries, {len(truth)} needs, {sum(len(t["true"]) for t in truth)} true matches')


if __name__ == '__main__':
    main()
