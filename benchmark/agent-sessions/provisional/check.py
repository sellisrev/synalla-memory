import json, sys, re
sys.path.insert(0, '.')
from questions_draft import Q
OUT = '../out'
def text(p, n):
    s = []
    for l in open(f'{OUT}/{p}/sessions/{n:03d}.jsonl', encoding='utf-8'):
        s.append(l)
    return ' '.join(s).lower().replace('\\n', ' ')
qs, bad = [], 0
for i, (p, t, q, g, ss, keys) in enumerate(Q):
    body = ' '.join(text(p, n) for n in ss)
    miss = [k for k in keys if not any(a.lower() in body for a in k)]
    if miss: bad += 1; print('MISSING', p, q, miss)
    qs.append({'id': f'{p}-{i % 10 + 1:02d}', 'persona': p, 'type': t, 'question': q, 'gold': g, 'sessions': ss})
json.dump(qs, open('questions.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(len(qs), 'questions,', bad, 'with missing keys')
