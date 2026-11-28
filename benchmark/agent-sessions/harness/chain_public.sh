#!/bin/bash
# Public run 1 (28 Nov): the 143 generated questions (out/questions.json) on A, D (extraction v2), H and O, then blind
# grading by Gemma (fast). A and D use a second `daily` server (:9104) and fresh v2 stores (work/synalla_v2); H and
# O use llama-swap's daily and their stores from the provisional run (same sessions). Each step stops the chain on
# failure. Claude grading follows separately.
set -u
cd /c/Claude/synalla-memory
SP=/c/Users/svers/AppData/Local/Temp/claude/b0147d3e513e77ed/6d013b0b-ffe6-4c3d-b7e1-7b856dc9337c/scratchpad
R=benchmark/agent-sessions/runs/public1; Q=benchmark/agent-sessions/out/questions.json; L=$R/chain.log
mkdir -p $R
say() { echo "$(date -Is) $*" >> $L; }
HPY='C:\AI\hermes\installs\4cc947a3e5ab212d\environments\711a9273c71745809ddc303a35315928\venv\Scripts\python.exe'
export SYNALLA_LLM=http://127.0.0.1:9104 SYNALLA_WORK=synalla_v2

say "waiting for the Hermes repeats to free :9104"
until [ "$(grep -cE '^[0-9]+/60' $SP/hermes_reps.log)" -ge 120 ]; do sleep 30; done
curl -sf 127.0.0.1:5941/health >/dev/null || {
  powershell -c "Start-Process -FilePath C:\AI\tools\llama.cpp-b12613\llama-server.exe -ArgumentList '-m','C:\AI\models\llm\memory-small\Qwen3-Embedding-0.6B-Q8_0.gguf','--embedding','--pooling','last','-ub','8192','-c','8192','-ngl','99','--host','127.0.0.1','--port','5941' -RedirectStandardError '$SP\\embed5941.log' -WindowStyle Hidden"
  until curl -sf 127.0.0.1:5941/health >/dev/null; do sleep 2; done; say "embedder up"; }
say "build v2"; node --import ./tools/ts-resolve.mjs benchmark/agent-sessions/harness/synalla.mjs build > $R/build.log 2>&1 || { say "FAILED build"; exit 1; }
say "answers D"; node --import ./tools/ts-resolve.mjs benchmark/agent-sessions/harness/synalla.mjs answer --arm D --questions $Q --out $R/answers_D.jsonl >> $R/answer_D.log 2>&1 || { say "FAILED D"; exit 1; }
say "answers A"; node --import ./tools/ts-resolve.mjs benchmark/agent-sessions/harness/synalla.mjs answer --arm A --questions $Q --out $R/answers_A.jsonl >> $R/answer_A.log 2>&1 || { say "FAILED A"; exit 1; }
say "waiting for the trial mail import to free llama-swap"
until grep -q "mail done" /c/Claude/agent-network/experiments/memory_ab/data/synalla_trial/trial_mail.log 2>/dev/null; do sleep 30; done
say "answers H"; (cd /c/AI/tools/src/hermes-agent && HERMES_RUNTIME_DIR='C:\AI\tools\hermes-runtime' "$HPY" -X utf8 'C:\Claude\synalla-memory\benchmark\agent-sessions\harness\hermes.py' answer --questions 'C:\Claude\synalla-memory\benchmark\agent-sessions\out\questions.json' --out 'C:\Claude\synalla-memory\benchmark\agent-sessions\runs\public1\answers_H.jsonl') >> $R/answer_H.log 2>&1 || { say "FAILED H"; exit 1; }
say "answers O"; python -I -X utf8 benchmark/agent-sessions/harness/openclaw.py answer --questions $Q --out $R/answers_O.jsonl >> $R/answer_O.log 2>&1 || { say "FAILED O"; exit 1; }
say "grade make"; python -I -X utf8 benchmark/agent-sessions/harness/grade.py make $R A D H O --questions $Q >> $R/grade.log 2>&1 || { say "FAILED make"; exit 1; }
say "grade local fast"; python -I -X utf8 benchmark/agent-sessions/harness/grade.py local $R --model fast >> $R/grade.log 2>&1 || { say "FAILED grade"; exit 1; }
python -I -X utf8 benchmark/agent-sessions/harness/grade.py score $R $R/grades_local_fast.json >> $R/grade.log 2>&1 || { say "FAILED score"; exit 1; }
say "PUBLIC1 DONE"
