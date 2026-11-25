#!/bin/bash
# Provisional run (25 Nov 2026, Serge's go for up to ~8 GPU hours). Stage 1: build P2-P8 and a 5-question first check
# per arm, then stop for review. Each step stops the chain on failure.
set -u
cd /c/Claude/synalla-memory
R=benchmark/agent-sessions/runs/prov1; Q=benchmark/agent-sessions/provisional/questions.json; L=$R/chain.log
mkdir -p $R
say() { echo "$(date -Is) $*" >> $L; }
HPY='C:\AI\hermes\installs\4cc947a3e5ab212d\environments\711a9273c71745809ddc303a35315928\venv\Scripts\python.exe'
for p in P2 P3 P4 P5 P6 P7 P8; do
  say "build $p"
  node --import ./tools/ts-resolve.mjs benchmark/agent-sessions/harness/synalla.mjs build --persona $p >> $R/build.log 2>&1 || { say "FAILED build $p"; exit 1; }
done
FIRST=P1-01,P2-02,P3-05,P4-01,P7-01
say "first check D"; node --import ./tools/ts-resolve.mjs benchmark/agent-sessions/harness/synalla.mjs answer --arm D --questions $Q --out $R/answers_D.jsonl --only $FIRST >> $R/answer_D.log 2>&1 || { say "FAILED D"; exit 1; }
say "first check A"; node --import ./tools/ts-resolve.mjs benchmark/agent-sessions/harness/synalla.mjs answer --arm A --questions $Q --out $R/answers_A.jsonl --only $FIRST >> $R/answer_A.log 2>&1 || { say "FAILED A"; exit 1; }
say "first check H"; (cd /c/AI/tools/src/hermes-agent && HERMES_RUNTIME_DIR='C:\AI\tools\hermes-runtime' "$HPY" -X utf8 'C:\Claude\synalla-memory\benchmark\agent-sessions\harness\hermes.py' answer --questions 'C:\Claude\synalla-memory\benchmark\agent-sessions\provisional\questions.json' --out 'C:\Claude\synalla-memory\benchmark\agent-sessions\runs\prov1\answers_H.jsonl' --only $FIRST) >> $R/answer_H.log 2>&1 || { say "FAILED H"; exit 1; }
say "first check O"; python -I -X utf8 benchmark/agent-sessions/harness/openclaw.py answer --questions $Q --out $R/answers_O.jsonl --only $FIRST >> $R/answer_O.log 2>&1 || { say "FAILED O"; exit 1; }
say "STAGE1 DONE"
