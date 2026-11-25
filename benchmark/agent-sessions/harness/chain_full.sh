#!/bin/bash
# Provisional run, stage 2: all 80 questions on every arm, then blind grading by Gemma (fast).
# First checks passed on 25 Nov. Each step stops the chain on failure.
set -u
cd /c/Claude/synalla-memory
R=benchmark/agent-sessions/runs/prov1; Q=benchmark/agent-sessions/provisional/questions.json; L=$R/chain.log
mkdir -p $R
say() { echo "$(date -Is) $*" >> $L; }
HPY='C:\AI\hermes\installs\4cc947a3e5ab212d\environments\711a9273c71745809ddc303a35315928\venv\Scripts\python.exe'
FIRST=P1-01,P2-02,P3-05,P4-01,P7-01
say "full D"; node --import ./tools/ts-resolve.mjs benchmark/agent-sessions/harness/synalla.mjs answer --arm D --questions $Q --out $R/answers_D.jsonl >> $R/answer_D.log 2>&1 || { say "FAILED D"; exit 1; }
say "full A"; node --import ./tools/ts-resolve.mjs benchmark/agent-sessions/harness/synalla.mjs answer --arm A --questions $Q --out $R/answers_A.jsonl >> $R/answer_A.log 2>&1 || { say "FAILED A"; exit 1; }
say "full H"; (cd /c/AI/tools/src/hermes-agent && HERMES_RUNTIME_DIR='C:\AI\tools\hermes-runtime' "$HPY" -X utf8 'C:\Claude\synalla-memory\benchmark\agent-sessions\harness\hermes.py' answer --questions 'C:\Claude\synalla-memory\benchmark\agent-sessions\provisional\questions.json' --out 'C:\Claude\synalla-memory\benchmark\agent-sessions\runs\prov1\answers_H.jsonl') >> $R/answer_H.log 2>&1 || { say "FAILED H"; exit 1; }
say "full O"; python -I -X utf8 benchmark/agent-sessions/harness/openclaw.py answer --questions $Q --out $R/answers_O.jsonl >> $R/answer_O.log 2>&1 || { say "FAILED O"; exit 1; }
say "grade make"; python -I -X utf8 benchmark/agent-sessions/harness/grade.py make $R A D H O >> $R/grade.log 2>&1 || { say "FAILED make"; exit 1; }
say "grade local fast"; python -I -X utf8 benchmark/agent-sessions/harness/grade.py local $R --model fast >> $R/grade.log 2>&1 || { say "FAILED grade"; exit 1; }
python -I -X utf8 benchmark/agent-sessions/harness/grade.py score $R $R/grades_local_fast.json >> $R/grade.log 2>&1 || { say "FAILED score"; exit 1; }
say "STAGE2 DONE"
