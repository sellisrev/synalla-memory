# Provisional questions (not the public set)

80 questions (10 per developer) written by Claude from the timelines on 25 Nov 2026, to test the harness, measure the
run cost and get an early reading. The public questions are written or approved by an outside developer (`../RULES.md`);
results on this set are reported as provisional and are not the public number.

`check.py` checks that every reference answer appears in the sessions it cites. Three drafted questions were replaced
because sessions held conflicting values (a mortgage payment estimated three ways; three different valuation caps; a
later session saving with ConfigFile after the switch to JSON). Every date answer was checked against the session text,
not the timeline: two were corrected or dropped.

Known weaknesses of the generated set, to fix before the public questions are written:
- several `replaces` links in the timelines are meaningless (an event replacing itself or an unrelated one), so the
  "6 changes" rule was met on paper only;
- filler sessions invent facts that contradict the timeline (rent, valuation, the game's name).
- sessions invent facts that contradict the timeline, inside event sessions too (P2 #037 saves with ConfigFile again);
- session dates lag the timeline dates by days to weeks (P2 E42 is dated 22 Mar, its session 8 Apr), so a date taken
  from the timeline is not what the sessions say; reference dates must come from the session text.
