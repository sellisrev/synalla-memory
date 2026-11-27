# Life-session benchmark: results

460 questions. Scores in % (1 / 0.5 / 0 per answer).

| Grader | A | D | H | O |
|---|---:|---:|---:|---:|
| grades_local_fast | 87 | 89 | 68 | 70 |
| grades_claude | 81 | 87 | 67 | 68 |

## By question type (first grader, then the others)

| Type | n | A | D | H | O |
|---|---:|---:|---:|---:|---:|
| before | 54 | 94/91 | 94/91 | 76/75 | 86/86 |
| considered | 18 | 94/97 | 94/97 | 94/97 | 81/83 |
| fact | 94 | 88/82 | 90/89 | 74/76 | 69/71 |
| need | 17 | 38/53 | 62/68 | 3/6 | 29/38 |
| needs_now | 10 | 15/20 | 55/55 | 45/5 | 30/5 |
| none | 30 | 100/100 | 97/97 | 97/100 | 100/100 |
| now | 121 | 90/89 | 90/90 | 59/61 | 63/64 |
| when | 62 | 84/58 | 89/81 | 73/68 | 69/61 |
| whose | 54 | 91/81 | 84/81 | 66/58 | 70/58 |

## Disagreements over 0.5 (117)

- L01-S08-1 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L01-S08-1 H: {'grades_local_fast': 1, 'grades_claude': 0}
- L01-S08-1 O: {'grades_local_fast': 1, 'grades_claude': 0}
- L01-S09-1 O: {'grades_local_fast': 1, 'grades_claude': 0}
- L01-S17-1 O: {'grades_local_fast': 1, 'grades_claude': 0}
- L01-S17-1 H: {'grades_local_fast': 1, 'grades_claude': 0}
- L01-S17-1 D: {'grades_local_fast': 0, 'grades_claude': 1}
- L01-S24-1 O: {'grades_local_fast': 1, 'grades_claude': 0}
- L01-S27-2 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L01-needs_now-1 O: {'grades_local_fast': 1, 'grades_claude': 0}
- L02-S08-1 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L02-S11-1 O: {'grades_local_fast': 0, 'grades_claude': 1}
- L02-S12-1 H: {'grades_local_fast': 0, 'grades_claude': 1}
- L02-S14-1 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L02-S14-2 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L02-S14-2 D: {'grades_local_fast': 1, 'grades_claude': 0}
- L02-S14-3 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L02-S17-1 A: {'grades_local_fast': 0, 'grades_claude': 1}
- L02-S24-1 O: {'grades_local_fast': 1, 'grades_claude': 0}
- L02-needs_now-1 O: {'grades_local_fast': 1, 'grades_claude': 0}
- L03-S08-1 H: {'grades_local_fast': 0, 'grades_claude': 1}
- L03-S13-2 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L03-S16-3 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L03-S23-2 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L03-S27-1 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L03-S28-1 H: {'grades_local_fast': 1, 'grades_claude': 0}
- L03-needs_now-1 H: {'grades_local_fast': 1, 'grades_claude': 0}
- L04-S01-1 D: {'grades_local_fast': 1, 'grades_claude': 0}
- L04-S01-1 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L04-S02-1 O: {'grades_local_fast': 1, 'grades_claude': 0}
- L04-S05-1 H: {'grades_local_fast': 0, 'grades_claude': 1}
- L04-S14-1 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L04-S14-3 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L04-S14-3 D: {'grades_local_fast': 1, 'grades_claude': 0}
- L04-S15-2 D: {'grades_local_fast': 0, 'grades_claude': 1}
- L04-S16-2 A: {'grades_local_fast': 0, 'grades_claude': 1}
- L04-S16-2 H: {'grades_local_fast': 0, 'grades_claude': 1}
- L04-needs_now-1 O: {'grades_local_fast': 1, 'grades_claude': 0}
- L04-needs_now-1 H: {'grades_local_fast': 1, 'grades_claude': 0}
- L05-S01-1 O: {'grades_local_fast': 0, 'grades_claude': 1}
- L05-S11-1 H: {'grades_local_fast': 0, 'grades_claude': 1}
- L05-S11-1 O: {'grades_local_fast': 0, 'grades_claude': 1}
- L05-S12-3 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L05-S12-3 D: {'grades_local_fast': 1, 'grades_claude': 0}
- L05-S13-1 O: {'grades_local_fast': 0, 'grades_claude': 1}
- L05-S13-1 H: {'grades_local_fast': 0, 'grades_claude': 1}
- L05-S14-2 H: {'grades_local_fast': 0, 'grades_claude': 1}
- L05-S14-2 A: {'grades_local_fast': 0, 'grades_claude': 1}
- L05-S15-3 H: {'grades_local_fast': 0, 'grades_claude': 1}
- L05-S23-2 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L05-S24-1 O: {'grades_local_fast': 1, 'grades_claude': 0}
- L05-S24-1 H: {'grades_local_fast': 1, 'grades_claude': 0}
- L06-S06-1 O: {'grades_local_fast': 0, 'grades_claude': 1}
- L06-S06-1 H: {'grades_local_fast': 0, 'grades_claude': 1}
- L06-S11-2 D: {'grades_local_fast': 1, 'grades_claude': 0}
- L06-S11-3 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L06-S12-2 H: {'grades_local_fast': 1, 'grades_claude': 0}
- L06-S13-3 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L06-S20-1 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L06-S20-1 D: {'grades_local_fast': 1, 'grades_claude': 0}
- L06-S23-2 O: {'grades_local_fast': 1, 'grades_claude': 0}
- L06-S23-2 H: {'grades_local_fast': 1, 'grades_claude': 0}
- L06-S25-1 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L06-S25-1 D: {'grades_local_fast': 1, 'grades_claude': 0}
- L06-S26-2 D: {'grades_local_fast': 0, 'grades_claude': 1}
- L06-S27-1 O: {'grades_local_fast': 1, 'grades_claude': 0}
- L06-S28-2 O: {'grades_local_fast': 1, 'grades_claude': 0}
- L07-S02-1 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L07-S02-1 H: {'grades_local_fast': 1, 'grades_claude': 0}
- L07-S05-1 O: {'grades_local_fast': 1, 'grades_claude': 0}
- L07-S07-1 D: {'grades_local_fast': 1, 'grades_claude': 0}
- L07-S10-1 O: {'grades_local_fast': 1, 'grades_claude': 0}
- L07-S10-1 H: {'grades_local_fast': 1, 'grades_claude': 0}
- L07-S14-2 H: {'grades_local_fast': 1, 'grades_claude': 0}
- L07-S14-3 O: {'grades_local_fast': 1, 'grades_claude': 0}
- L07-S14-3 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L07-S14-3 D: {'grades_local_fast': 1, 'grades_claude': 0}
- L07-S14-3 H: {'grades_local_fast': 1, 'grades_claude': 0}
- L07-S16-2 H: {'grades_local_fast': 1, 'grades_claude': 0}
- L07-S16-2 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L07-S20-1 D: {'grades_local_fast': 1, 'grades_claude': 0}
- L07-S20-1 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L07-S26-2 O: {'grades_local_fast': 1, 'grades_claude': 0}
- L07-S27-1 D: {'grades_local_fast': 1, 'grades_claude': 0}
- L07-S27-1 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L07-S28-1 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L07-S28-1 D: {'grades_local_fast': 1, 'grades_claude': 0}
- L07-S28-2 H: {'grades_local_fast': 1, 'grades_claude': 0}
- L08-S05-1 A: {'grades_local_fast': 0, 'grades_claude': 1}
- L08-S05-1 O: {'grades_local_fast': 0, 'grades_claude': 1}
- L08-S11-3 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L08-S12-3 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L08-S13-3 H: {'grades_local_fast': 1, 'grades_claude': 0}
- L08-S13-3 O: {'grades_local_fast': 1, 'grades_claude': 0}
- L08-S15-3 D: {'grades_local_fast': 1, 'grades_claude': 0}
- L08-S15-3 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L08-needs_now-1 H: {'grades_local_fast': 1, 'grades_claude': 0}
- L09-S07-1 O: {'grades_local_fast': 0, 'grades_claude': 1}
- L09-S09-1 O: {'grades_local_fast': 0, 'grades_claude': 1}
- L09-S15-1 O: {'grades_local_fast': 0, 'grades_claude': 1}
- L09-S19-1 A: {'grades_local_fast': 0, 'grades_claude': 1}
- L09-S26-1 H: {'grades_local_fast': 1, 'grades_claude': 0}
- L09-S26-1 O: {'grades_local_fast': 1, 'grades_claude': 0}
- L09-S26-1 D: {'grades_local_fast': 1, 'grades_claude': 0}
- L09-S26-1 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L09-S27-1 O: {'grades_local_fast': 1, 'grades_claude': 0}
- L09-needs_now-1 H: {'grades_local_fast': 1, 'grades_claude': 0}
- L10-S05-1 H: {'grades_local_fast': 0, 'grades_claude': 1}
- L10-S07-1 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L10-S13-3 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L10-S14-2 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L10-S14-2 D: {'grades_local_fast': 1, 'grades_claude': 0}
- L10-S15-3 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L10-S23-2 A: {'grades_local_fast': 1, 'grades_claude': 0}
- L10-S28-1 O: {'grades_local_fast': 1, 'grades_claude': 0}
- L10-S28-1 H: {'grades_local_fast': 1, 'grades_claude': 0}
- L10-none-1 H: {'grades_local_fast': 0, 'grades_claude': 1}
