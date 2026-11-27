# Secret scrubber: blind set written by another model

The held-out set in `../heldout.mjs` was written by the people who built the scrubber, and it is no longer blind (its
misses shaped the 24 Nov rules). The release claim needs a set written by someone who never saw the scrubber. An
outside person has not been recruited yet, so this set is a stand-in: two models (Claude Sonnet and Claude Opus),
asked through Claude Code with no tools and no project files, each wrote 50 snippets on each of 10 themes (half with
secrets, half with harmless look-alikes). The prompt (`write.mjs`) describes realistic text only; it never shows the
scrubber, its rules or the earlier sets. It is still a model from the same family as the one that built the
scrubber, so it is weaker evidence than a person outside the project, and it is reported as such.

Rules, fixed before the first measurement (27 Nov 2026):

- **Set.** Every snippet as written, except those whose listed secrets do not occur in their text (dropped and
  counted). A writer's judgement of what is a secret is kept as is, even where we would disagree; disagreements are
  listed when the set is retired, not fixed.
- **Caught:** no 8 characters of the secret in a row remain in the scrubbed text (for secrets shorter than 8, the
  secret itself does not remain). **False positive:** a harmless snippet changed at all.
- **Reported:** caught and changed, with Wilson 95% intervals, by writer and by theme.
- **Blind use.** The misses and false positives are not read while the scrubber may still change for this release
  (`eval.mjs` hides them unless `--list`). A change made after reading them needs a fresh set.

Run: `node benchmark/scrub/blind/write.mjs` (writes `raw/` and `set.json`), then
`node --import ./tools/ts-resolve.mjs benchmark/scrub/blind/eval.mjs` from the repo root.
