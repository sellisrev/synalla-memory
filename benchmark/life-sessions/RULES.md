# Life-session set: construction rules

Published before the set is generated. Synthetic sessions between ordinary people and their personal AI agent, so the
set can be published and rerun. It tests two things a personal agent's memory must do for anyone, not only for
developers:

1. **Know what is true now** about its person, across work and private life, through noise, changes of heart,
   corrections, tentative plans and other people's look-alike facts, and still know the history and the dates.
2. **Act on it:** when something said reveals a need, a want or a problem, look on the network for a match without
   being asked, and stop once the need is met.

## People

10 fictional people, 6 simulated weeks each from 2026-03-02, chosen to cover different lives: a nurse, a primary
teacher, a restaurant owner, a retired engineer, an architecture student, a freelance photographer, a backend
developer, a vineyard owner, a lawyer on parental leave, a start-up founder. Different countries, ages and households.
Every person has work, family and people, home, health, money, hobbies, travel, shopping and admin in their weeks.

Two more groups are made the same way and published, but never counted: **dev** (2 people: a social worker in
Seville, a bus driver in Hamburg), on which the systems may be tuned, and **val** (2 people: a translator in Gothenburg,
a pharmacist in Marseille), never looked at while tuning: a change found on dev is kept only if it does not lose on
val. The 10 test people are run once, after tuning ends.

## Ground truth is computed, not claimed

The structure of each life is fixed by code from a seed, before any text is written: a list of storylines, each with a
pattern, a theme and dates. The local model fills the storylines with content that fits the person (what the thing
is, its values), and code checks it: values specific and distinct, no storyline about the same thing as another, none
giving the person something they still need, no value that is the person's name or a word from who they are (it
would come up in every conversation), and a sense check of each "her dentist is Dr. Okafor" sentence. A storyline the
model never fills correctly (at most 3 per person) is left out, and the list of what was left out is published. The
needs are written by hand (`needs.py`), so their topics, and so the matching truth, are right. Code then computes the
truth on every date. Patterns, per person:

| Pattern | Per person | What happens | True now |
|---|---:|---|---|
| plain | 10 | a fact stated once | the value |
| change | 6 | a value replaced by another (moved appointment, new phone, switched supplier) | the new value |
| change of heart | 2 | A, then B, then back to A | A |
| correction | 2 | a value given, later corrected ("I said 14, it's 16") | the corrected value, from the first date |
| tentative, dropped | 2 | "thinking about B" and never done | the old value; B was only considered |
| tentative, confirmed | 1 | "thinking about B", later done | B, from the later date |
| hypothetical | 2 | "if I took the Berlin job I would..." | unchanged |
| look-alike | 3 | the same kind of fact about someone else (a sister's address, a friend's gym) | the person's own value |
| need, met | 2 | a need or problem comes up, later solved | no longer needed, from the date solved |
| need, open | 2 | a need or problem comes up and is still open at the end | needed |
| need, not the person's | 1 | a need that is hypothetical or someone else's | not the person's need |

## Sessions

About 45 sessions per person, between the person and their agent: everyday help (messages, planning, shopping,
cooking, health questions, paperwork, travel) and help with their work (a lesson plan, a supplier order, a shift swap,
code for the developer). Each storyline step comes up in a session on its date, or later with the date said in the
text, either explicitly or in passing among ordinary talk. About a quarter of the sessions carry no storyline step and
are noise. The local model writes the sessions; they are saved in Claude Code's transcript format, so every memory
system reads them through its normal path.

Every session is checked against the truth on its date and rejected (then rewritten with another seed) if:
- a value it must carry is missing, or a date it must say is not said (code);
- it states a value from a storyline that is not yet revealed, or a stale value as current (code);
- it contradicts a storyline in meaning, or reveals one before its day (a judge from another model family, Gemma 4,
  given every storyline with its dates; a problem counts only if its quote is in the session).

Rejections and their reasons are published (`checks.json`).

## Questions

Generated from the computed truth, one or more per storyline, by rules in code (Who for a person, When for a dated
thing, "Inès's music teacher" for a household member). A storyline is not asked when its thing could be confused with
another storyline's, when its name gives the answer away, or when a dated need comes up after its date; a "not in
memory" question never touches a thing that exists. The wording was then read by Claude (who also wrote the
generator; no system's answers were seen), which reworded or dropped a few questions in `questions_review.json`,
each with its reason; every question not asked is listed in `questions_skipped.json`. A review by a person outside
the project is still to come. Types: what is true now, what it was before, when, what was only
considered, whose fact it is, open needs, and questions with no answer in the sessions.

## Proactive matching

A synthetic network of other people's agents (`network.py`, no model), each with circle/1 entries (what they can help
with, lend, recommend, introduce or offer), tagged with their city. Planted for every need: one entry that matches it
(two for needs still open at the end) in the person's city, and near misses: the same topic in another city, the same
topic expired, a neighbouring topic in the same city. Every member also offers unrelated entries, never on a need's
topic in its city, so every live entry on that topic and city is a planted match (checked). The sessions are fed to each system in date order; after each session the system may propose
matches to its person. Scored:
- a proposal is right if the need is the person's, open on that date, and the entry matches it;
- recall of open needs, precision of proposals, days from the need first coming up to the first right proposal;
- proposals for met, hypothetical or someone else's needs count as false alarms.

Systems without a proactive feature get their best case: after each session, the same answering model is asked
whether anything on the network would help the person now, with the network as a search tool.

## Systems and grading

Every system ingests the sessions through its real path; the same answering model for all; two blind graders from
different model families; every disagreement listed; all answers and grades published. The storylines, the truth per
date, the session-to-storyline map and the check log are published with the set as ground truth for the question
reviewer, not as input to any system.

## Limits

Synthetic people and sessions, written by one local model in English. Facts are said more cleanly than in real life,
and the noise is what the generator was asked for; real memories will be harder. The set tests the shape of the work,
not the expected rate on a real person.
