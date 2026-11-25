# Agent-session benchmark harness

Runs every memory system on the same synthetic sessions (`../out`, from `../generate.py`), with the same answering
model, and grades the answers blind. Construction rules: `../RULES.md`.

| Arm | System | How the sessions get in | What answers |
|---|---|---|---|
| A | Synalla memory, shipped default | Claude Code importer; agent sessions are not read for facts by default | MCP `recall` passages + one call to the answering model |
| D | Synalla memory with facts | as A, plus `extract --agent-sessions` with the local model | MCP `recall` passages and facts + one call |
| H | Hermes Agent v0.23.3, built-in memory | each session becomes one Hermes session with its turns (`import_sessions`) | Hermes' agent loop with `session_search` and `memory`, offered directly |
| O | OpenClaw 2026.11.6, memory-core | each session logged as a section of its day's note (`memory/YYYY-MM-DD.md`), indexed | OpenClaw's agent loop with `memory_search` and `memory_get`, offered directly |

Same for every arm: the answering model (`daily`, Qwen3.6-35B-A3B Q4_K_M through llama-swap), temperature 0.2, max
tokens 8000, today fixed at 2026-04-13, the answer rules ("not in memory", latest value unless asked about the past,
brief). H and O get their best case: tools shown directly, 15 steps and 600 s per question; a timeout is graded wrong.
The embedder for A, D and O is Qwen3-Embedding-0.6B (Q8_0) on port 5941; Hermes has no vector search.

## Steps

```
node --import ./tools/ts-resolve.mjs benchmark/agent-sessions/harness/synalla.mjs build
<hermes python> -X utf8 harness/hermes.py build        # from the Hermes source checkout
python -I -X utf8 harness/openclaw.py build
node --import ./tools/ts-resolve.mjs benchmark/agent-sessions/harness/synalla.mjs answer --arm D --questions <q> --out runs/<r>/answers_D.jsonl
...  (answer --arm A, hermes.py answer, openclaw.py answer, each with --questions and --out)
python -I -X utf8 harness/grade.py make runs/<r> A D H O
python -I -X utf8 harness/grade.py local runs/<r> --model fast      # Gemma 4 26B as one grader
python -I -X utf8 harness/grade.py score runs/<r> runs/<r>/grades_*.json
```

Stores, homes and indexes go to `../work/` and answers to `../runs/`; both are rebuilt from the published sessions and
are not in git.
