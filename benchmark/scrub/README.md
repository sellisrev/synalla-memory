# Secret scrubber: held-out test

`heldout.mjs` plants 400 secrets (25 kinds of service, each in 8 contexts: `.env` line, `export`, JSON, YAML, a
command-line flag, a curl header, a sentence, a code string) and 400 harmless look-alikes (git hashes, UUIDs, digests,
npm integrity strings, colours, paths, prose using the words "password", "token" and "secret"). The seed is fixed, so
anyone can rerun it: `node --import ../../tools/ts-resolve.mjs heldout.mjs`.

| Scrubber | Secrets caught | Harmless strings changed |
|---|---:|---:|
| as built (before 24 Nov) | 374 / 400 (93.5%) | 7 / 400 (1.8%, all npm integrity strings) |
| after the 24 Nov rules | 399 / 400 (99.8%) | 0 / 400 |

The misses were secrets with no known prefix, in a command-line flag or a sentence. The new rules (see the changes
at the end of `test/fixtures/scrub/SPEC.md`) were tuned on a second set with another seed (`tuning.mjs`: 99.3%,
0 false positives). This set is therefore no longer blind; a fresh set written by someone outside the project will
back the release claim.
