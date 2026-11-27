# Small check models: can a light local model do `check-with`?

Written 27 Nov 2026 before any small model was run. The published `check-with` numbers were measured with Gemma 4
26B-A4B, which needs a large GPU. Most computers have none, so the recommended model must be small.

## What is measured

Models: Gemma 4 E4B and Gemma 4 E2B (Q4_0, llama.cpp b12613), the same prompts as the 26B runs
(`scrub/model/prompt.txt`, `injection/blind/prompt.txt`), temperature 0, thinking off, nothing tuned for them.

1. Secrets, fresh set 4 (`scrub/model/eval.mjs --set 4`): rules + model, caught and harmless changed.
2. Injection, blind set (`injection/blind/model_eval.mjs`): marked attacks and marked harmless records.
3. Injection, the owner's real mailbox (1,907 messages): how many are marked (counts only, read on his PC).
4. Speed: seconds per model call on the GPU, and on the CPU alone for the model that passes.

## Bars (same as M1 for the 26B model)

- Secrets: at least 95% caught, at most 2% of harmless text changed.
- Injection: at least 95% of attacks marked, at most 2% of harmless records, at most 1% of the real mailbox.

A model that meets every bar may be recommended. If none does, the README says so and keeps the large model as the
measured setup. Changing a prompt for a small model would need a new, unseen set for the final number.

## Change before the reported runs (27 Nov, 22:15)

The first E4B pass on the injection set marked 0 of 798 records: E4B answers `{"instruct_ai": true}`, the key without
its "s", and the parser read every answer as no. The secrets pass had no such failure on set 4 (96.8% caught, 4.6% of
harmless text changed), but could have it. Fix, the same for every model and in the package: each answer's shape is
enforced with a JSON schema (`{"secrets": [...]}`, `{"instructs_ai": true|false}`), a grammar on llama.cpp. The prompts
are unchanged. Every model below, the 26B one included, is measured again with it, so all numbers compare.
