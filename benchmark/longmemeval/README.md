# LongMemEval subset

Synalla memory's public score comes from 100 of the 500 questions of LongMemEval_S (Wu et al., 2024; dataset
`xiaowu0162/longmemeval-cleaned` on Hugging Face, MIT licence). This folder fixes which 100, before any run.

## The rule

- Strata: each question type, with the "abstention" questions (the answer is not in the history; ids ending in `_abs`)
  as their own strata.
- Each stratum gets its share of 100 seats (its count divided by 5), rounded down and at least 1. The seats left go
  to the largest remainders.
- Within a stratum, question ids are ordered by SHA-256 of the seed `synalla-longmemeval-subset-2026-11-24` followed by
  the id, and the first ones are taken.
- `select.mjs` applies the rule to `longmemeval_oracle.json` (SHA-256 `821a2034…620c`, checked before use) and writes
  `subset.json`. Anyone can rerun it and get the same list.

| Stratum | Questions |
|---|---:|
| knowledge-update | 15 |
| knowledge-update (abstention) | 1 |
| multi-session | 24 |
| multi-session (abstention) | 3 |
| single-session-assistant | 11 |
| single-session-preference | 6 |
| single-session-user | 13 |
| single-session-user (abstention) | 1 |
| temporal-reasoning | 25 |
| temporal-reasoning (abstention) | 1 |

## How it will be run

- Each system reads the haystack sessions through its own normal path (Synalla through its session import), then
  answers with the same answering model.
- Answers are judged with LongMemEval's official judge where it can be paid for; otherwise a local judge, checked
  against the official one on a 30-question sample.
- All answers and grades are published with the harness. Results with a local answering model are compared only
  with each other, not with published leaderboards.

The data itself is not in this repository; download it from Hugging Face.
