# Agent-session set: construction rules

Published before the set is generated (24 Nov 2026). This is Synalla memory's public benchmark input: synthetic
coding and assistant sessions, so it can be published and rerun. The questions are written by a generator from the
timelines below and checked against the sessions by a second model (Serge, 27 Nov 2026: no outside question writer;
first plan: an outside developer).

## What is generated (`generate.py`, fixed seed)

- **8 fictional developers** (listed in the script), each over **6 simulated weeks** from 2026-03-02.
- For each, a **timeline** of 30 to 45 dated events: project decisions, bugs and their fixes, tools chosen and later
  replaced, people they work with, appointments, purchases, preferences, plans. At least 6 events change an earlier
  one (a moved meeting, a switched library, a new address), so "what is true now" and "when" questions have answers.
- From the timeline, **sessions** between the developer and their agent: coding sessions (with code, errors and logs
  around the facts) and assistant sessions (planning, writing, admin). Each session reveals one or two events, in
  passing or explicitly, among ordinary work. Sessions are written by a local model (the same 35B used in our private
  tests) and saved in Claude Code's own transcript format, so every memory system reads them through its normal path.
- The timeline and the map from sessions to events are published with the set; they are the ground truth for the
  question writer, not input to any system.

## Questions (generated, then checked; rules fixed 28 Nov before any question was generated)

- About 150 in total, spread over the 8 developers.
- Mix: facts stated once (30%), facts needing two or more sessions (20%), what is true now after a change (20%), when
  something happened (15%), preferences (5%), and questions whose answer is not in the sessions (10%).
- Each question has a reference answer and the sessions it comes from.
- **Writer:** the local `daily` model (Qwen3.6 35B-A3B) gets one developer's timeline and the map from sessions to
  events, and writes that developer's 20 questions in the mix above (6 facts, 4 across sessions, 4 true now, 3 when,
  1 preference, 2 not in the sessions), each citing its event ids (`generate_questions.py`).
- **Rules checked by code:** cited events exist; a "true now" question cites the last event of a chain of replaced
  events and its reference is that event's value; a "when" reference holds the event's date; a question whose
  answer is not in the sessions cites no event.
- **Checked by a second model** (Gemma 4 26B, `fast`): it reads the cited sessions and must agree that they support
  the reference answer; for "not in the sessions" it reads every session of that developer and must find no answer.
  A question that fails is dropped, never rewritten by hand; the drops are published with their reason.
- Systems never see the timelines, the questions or the checks before they answer.

## Systems and grading

As in the plan (W1): every system ingests the sessions through its real path, the same answering model for all, two
blind graders from different model families, every disagreement listed, all answers and grades published.
