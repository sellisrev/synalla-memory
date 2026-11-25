# Synthetic circle: want detection and matching calibration

`generate.py` plants the truth first (20 members, 50 needs: 30 with an exact offer elsewhere, 20 near misses where the
offer has another type or has expired), then the local model writes each member's circle/1 entries and 6 sessions
where needs and offers come up in passing. `detect.py` asks the local model for each session's needs (type and topic
from circle/1's closed lists, confidence, quote) and matches them the way `synalla/src/entries.ts` `candidates()` does.

## Result (25 Nov 2026, local `daily`, 120 sessions)

| Matching | Threshold | Need recall | Need precision |
|---|---|---|---|
| Type and topic (as `candidates()` does today) | 0.5 to 0.9 | 18% to 24% | 12% to 14% |
| Topic only | 0.5 | 100% | 61% |
| Topic only | 0.9 | 98% | 70% |

- **The type is the weak part, not the topic.** As a description of a need, the five types (help, intro, lend,
  recommend, offer) overlap: someone who needs baby gear may want it lent, given or recommended. Matching on exact
  type drops four needs in five.
- **Confidence 0.9 is the useful threshold.** Below it, precision falls with almost no gain in recall.
- **Asking for needs and the developer's own offers as two lists does not help** (55 to 68% precision against 61 to
  70%); the simple prompt stays.
- "Match precision" in `out/calibration_*.md` counts any offer on the same topic that was not planted as wrong. With
  topic-only matching, members' unplanned offers on a needed topic are often genuine candidates, so need precision is
  the fairer number for false alarms. Type-differs near misses become matches under topic-only matching, which is the
  intended change.

## Limits

- Sessions are synthetic and say offers almost in the words of the member's entry, which makes topics easier to find
  than in real memories. Real sessions will score lower; this sets the prompt and threshold, not the expected rate.
- Two earlier generations were rejected: entry texts that echoed their labels, then sessions where offers were written
  as needs (the detector was then blamed for the generator's errors). Both fixed in `generate.py`; the rejected output
  is kept out of git.

## What this changes in W4

Match asks to entries on **topic** (plus not expired), use type only to rank, and show the owner a detected want only
at confidence 0.9 or more. To apply in `entries.ts` with a protocol note (circle/1 keeps the type field).
