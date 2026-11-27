# Life-session benchmark: test results (27 Nov 2026)

The test set: 10 people, about 50 sessions each over six weeks, 460 questions (rules: [RULES.md](RULES.md), written
before any data was generated). Run once, after tuning had ended on the dev and val people. Every system read the
sessions through its own path and answered with the same local model (`daily`, Qwen3.6-35B-A3B). Two blind graders
from different model families, Gemma 4 26B (local) and Claude Opus, graded every answer (1 / 0.5 / 0).

## Answers

| System | Gemma | Claude | Both graders | Median seconds per answer |
|---|---:|---:|---:|---:|
| **Synalla D**: passages, facts (extraction v2) and the owner's needs | 89 | 87 | **87.7** | 27 |
| Synalla A: passages only (the shipped default) | 87 | 81 | 83.9 | 29 |
| OpenClaw 2026.11.6, its own memory (best case) | 70 | 68 | 68.8 | 28 |
| Hermes Agent v0.23.3, its own memory (best case) | 68 | 67 | 67.6 | 6 |

Differences, both graders pooled, paired bootstrap over questions (10,000 resamples):

| | Difference | 95% interval |
|---|---:|---|
| D minus OpenClaw | +19.0 | +15.0 to +22.9 |
| A minus OpenClaw | +15.1 | +11.2 to +19.1 |
| D minus Hermes | +20.2 | +16.3 to +24.0 |
| D minus A | +3.9 | +1.4 to +6.3 |

By question type (Gemma / Claude):

| Type | n | A | D | Hermes | OpenClaw |
|---|---:|---:|---:|---:|---:|
| now (what is true now) | 121 | 90/89 | 90/90 | 59/61 | 63/64 |
| fact | 94 | 88/82 | 90/89 | 74/76 | 69/71 |
| when | 62 | 84/58 | 89/81 | 73/68 | 69/61 |
| before | 54 | 94/91 | 94/91 | 76/75 | 86/86 |
| whose (not a look-alike's) | 54 | 91/81 | 84/81 | 66/58 | 70/58 |
| none (not in memory) | 30 | 100/100 | 97/97 | 97/100 | 100/100 |
| considered (only a plan or what-if) | 18 | 94/97 | 94/97 | 94/97 | 81/83 |
| need (open or met) | 17 | 38/53 | 62/68 | 3/6 | 29/38 |
| needs now (the open list) | 10 | 15/20 | 55/55 | 45/5 | 30/5 |

**Reading.** Both Synalla settings are far ahead of the two agents' own memories, mostly on what is true now and on
whose fact it is. Facts and needs (D) add about 4 points over passages alone, mostly on needs and dates. The graders
disagree by more than 0.5 on 117 of 1,840 answers (listed in `runs/test1/RESULTS.md`); Claude is stricter on dates.
Hermes is fastest: one search call and a short context.

## Reference check

A second model (Claude Opus) read each person's sessions as the systems saw them, never the storylines, the truth or
any answer, and flagged 56 references, each with a quote that was checked to be in the sessions
([out/AUDIT.md](out/AUDIT.md)). On reading them, 36 are material: the sessions support a different main answer
(for example a plate that is the neighbour's car, not Marc's; a need recorded as met by the wrong purchase), or a
"when" reference is the day a change was mentioned while the sessions say it happened earlier. The other 20 concern
a detail in a parenthesis or the date of a correction. Without the 36 (`runs/test1/excluded_audit.txt`), 424
questions: A 88.1, **D 90.9**, Hermes 70.6, OpenClaw 71.9; D minus OpenClaw +19.0 (+15.0 to +23.1), D minus A +2.8
(+0.5 to +5.2). The conclusion does not change. The generator flaws behind them (a value said by one storyline and
contradicted by filler; mention dates taken as change dates) are to be fixed before the public set.

## Proactive matching

After each session, the system could propose matches from a synthetic network for its person's needs (Synalla's
wants scan; replayed from the stores already read). 38 needs across 10 people: **13 found while open (34%)**, 23 of 38
proposals right (61%), each found on the day the need came up; 15 wrong proposals (2 someone else's or imagined, 4
near misses, 9 unrelated); no met need was closed. Hermes and OpenClaw have no proactive feature; their best case
(the answering model asked after each session) was not run in this test. Details: `runs/test1/PROACTIVE.md`.

## Limits

- Synthetic people and sessions, written by one local model in English; real memories are messier. The set tests
  the shape of the work, not the expected rate on a real person.
- One answering model for all; Hermes and OpenClaw are given their best case (their memory tools shown directly), not
  their default prompts.
- Grading is not fully blind: answer styles reveal systems (Hermes session links, OpenClaw memory paths).
- 36 of 460 references are flawed (above); both results are given.
- This is the private life-session set. The public agent-session set still needs its outside question writer.
