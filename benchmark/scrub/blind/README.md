# Secret scrubber: blind sets written by another model

The held-out set in `../heldout.mjs` was written by the people who built the scrubber, and it is no longer blind (its
misses shaped the 24 Nov rules). The release claim needs sets written by someone who never saw the scrubber. An
outside person has not been recruited yet, so these sets are a stand-in: two models (Claude Sonnet and Claude Opus),
asked through Claude Code with no tools and no project files, each wrote 50 snippets on each of 10 themes (half with
secrets, half with harmless look-alikes). The prompt (`write.mjs`) describes realistic text only; it never shows the
scrubber, its rules or the earlier sets. It is still a model from the same family as the one that built the
scrubber, so it is weaker evidence than a person outside the project, and it is reported as such.

## Set 1 (27 Nov): retired, now the tuning set

Measured once, blind, on the scrubber as it was: **54.8% of 604 secrets caught (95% interval 50.8–58.7%), 16.9% of
498 harmless snippets changed (13.8–20.4%)**, far from the 99.8% of our own held-out set. The misses were whole
classes the rules did not cover: passwords in French and German prose, on command lines and in tables, recovery-code
lists, more config names, session cookies, webhook URLs, several token formats; the false positives were
placeholders (`sk-...`, `<password>`), masked values and public key material.

The set was then read and used to write the 27 Nov rules (general rules for those classes, never a rule for one
example). On it the new scrubber catches 95.7% and changes 1.2%, which is a tuning number, not evidence. The older
sets did not move (held-out 99.8% / 0%, tuning 99.3% / 0%).

## Set 2 (27 Nov): the blind measurement

Ten new themes (`THEMES_2` in `write.mjs`), the same prompt and writers, written after the 27 Nov rules were frozen.
Rules, fixed before it was written:

- **Set.** Every snippet as written, except those whose listed secrets do not occur in their text (dropped, counted).
  The writer's judgement of what is a secret is kept as is.
- **Caught:** no 8 characters of the secret in a row remain in the scrubbed text (for secrets shorter than 8, the
  secret itself does not remain). When the listed secret is a whole URL with a password in it
  (`scheme://user:password@host`), only the password counts: scheme, user name, host, port and path are not secret.
- **False positive:** a harmless snippet changed at all.
- **Reported:** caught and changed, with Wilson 95% intervals, by writer and by theme. The release bar is the M1 exit:
  at least 95% caught; false positives published.
- **Blind use.** Its misses and false positives are not read before the number is recorded here. A change made after
  reading them needs a fresh set.

**Result (27 Nov, recorded before any miss was read):** 996 snippets (1 dropped), **544 of 603 secrets caught =
90.2% (95% interval 87.6–92.3%); 21 of 497 harmless snippets changed = 4.2% (2.8–6.4%)**. Sonnet's snippets 272/298,
Opus's 272/305. The M1 bar (95% caught) is **not met**. Set 2 is now retired to tuning as well; the next change is
measured on a set 3.

The sets themselves are kept out of the public repository: their invented keys look real enough that GitHub's push
protection (and any secret scanner copying the repository) treats them as leaks. The writers' replies are kept
locally and can be shared on request; `write.mjs` writes a new set of the same kind.

Run: `node benchmark/scrub/blind/write.mjs [--set 2]`, then
`node --import ./tools/ts-resolve.mjs benchmark/scrub/blind/eval.mjs [--set 2]` from the repo root.
