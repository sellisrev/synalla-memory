# Benchmarks

What Synalla memory is measured on, and the headline results. Every benchmark states its rules before it is run,
reports what it found, including what failed, and can be rerun from this folder. Synthetic data is published; the
owner's real mail is used for counts only and never leaves his computer.

| What | Result | Where |
|---|---|---|
| **Answers about a person's life** (10 synthetic people, six weeks each, 460 questions, two blind graders) | Synalla 87.7 of 100 with facts and needs, 83.9 with passages only; OpenClaw's own memory 68.8, Hermes' 67.6 (same answering model) | [life-sessions](life-sessions/RESULTS.md) |
| **Finding needs others could help with** (same people) | 13 of 38 needs found while open; 23 of 38 proposals right | [life-sessions](life-sessions/RESULTS.md#proactive-matching) |
| **Secrets kept out of the memory** (text no rule was written from) | rules alone 94.0% caught; with a local model 96.8% (Gemma 4 E4B, the built-in check) or 97.0% (Gemma 4 26B) | [scrub](scrub/blind/README.md), [small_models](small_models.md) |
| **Prompt injection marked** (393 attacks written by other models) | rules 13.7%; local model 99.2% (E4B) or 99.7% (26B); 0.16–0.21% of a real mailbox marked | [injection](injection/README.md), [small_models](small_models.md) |
| **Agents fooled by planted instructions** (Hermes, local model, 30 blind attacks) | followed 13 of 90 runs with the rules' marks, 3 of 90 with the built-in check's (three repeats) | [injection](injection/README.md#round-3-hermes-on-blind-attacks-design-fixed-27-nov-before-it-was-run) |
| **Agents fooled, known attack shapes** (Claude Haiku, Sonnet, Opus; Hermes) | Claude 0 of 342 runs; Hermes 6 of 114, then 0 with the mark | [injection](injection/RESULTS.md) |
| **Money and ID numbers given stand-ins** (IBAN, card, social security, tax, passport; 400 records written by other models) | 96.6% caught, 0.5% of harmless records changed (second blind set, after one round of fixes) | [pii](pii/README.md) |
| **Matching needs between people** (synthetic circle of 20) | topic-only matching: 98% of needs found at 70% precision | [circle](circle/README.md) |

## What these do not show

- The life-session people and their sessions are synthetic. Real memories are messier; the numbers compare systems
  on the same input, they are not a promise for yours.
- The secrets and injection sets were written by language models asked to imitate real mail and notes. Each was used
  once for the result reported, after the design was fixed, except where a file says otherwise.
- The built-in check model misses its own first bar on false alarms (4.4% of harmless lines hidden, 5.2% of harmless
  test mail marked): the bar was relaxed after the results because a wrong hide is now reversible.
  [small_models.md](small_models.md) says how.
- Money and ID number detection was fixed once after its first blind set (57.3% caught) and then measured once on a
  fresh set; its published test card numbers are left readable on purpose.
