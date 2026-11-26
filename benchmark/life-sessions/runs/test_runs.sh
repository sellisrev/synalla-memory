#!/bin/bash
# The one test run (10 people, after tuning ended on dev; RULES.md). Usage: bash runs/test_runs.sh <facts variant: v1|v2>
# Arms: A (passages, shipped default), D (facts of the chosen extraction), H (Hermes), O (OpenClaw); then the
# proactive track; then blind grading by Gemma. Each step stops the chain on failure; every step resumes.
set -u
V=${1:?facts variant v1 or v2}
cd /c/Claude/synalla-memory
export LIFE_SET=test
R=benchmark/life-sessions/runs/test1; Q=benchmark/life-sessions/out/questions.json; L=$R/chain.log
mkdir -p $R
say() { echo "== $(date -Is) $*" | tee -a $L; }
VA=""; [ $V = v2 ] && VA="--variant v2"
HPY='C:\AI\hermes\installs\4cc947a3e5ab212d\environments\711a9273c71745809ddc303a35315928\venv\Scripts\python.exe'
until [ -f $Q ] && grep -q "test DONE" benchmark/life-sessions/gen.log; do sleep 60; done
cp $Q $R/questions.json
say "build synalla $V"; node --import ./tools/ts-resolve.mjs benchmark/life-sessions/harness/synalla.mjs build $VA >> $R/build_$V.log 2>&1 || { say "FAILED build"; exit 1; }
until [ -f $R/REVIEWED ]; do sleep 60; done  # the wording review of the questions (questions_review.json) is applied
cp $Q $R/questions.json
say "answer D"; node --import ./tools/ts-resolve.mjs benchmark/life-sessions/harness/synalla.mjs answer $VA --arm D --questions $Q --out $R/answers_D.jsonl >> $R/answer_D.log 2>&1 || { say "FAILED D"; exit 1; }
say "answer A"; node --import ./tools/ts-resolve.mjs benchmark/life-sessions/harness/synalla.mjs answer $VA --arm A --questions $Q --out $R/answers_A.jsonl >> $R/answer_A.log 2>&1 || { say "FAILED A"; exit 1; }
say "build H"; (cd /c/AI/tools/src/hermes-agent && HERMES_RUNTIME_DIR='C:\AI\tools\hermes-runtime' "$HPY" -X utf8 'C:\Claude\synalla-memory\benchmark\life-sessions\harness\hermes.py' build) >> $R/build_H.log 2>&1 || { say "FAILED build H"; exit 1; }
say "answer H"; (cd /c/AI/tools/src/hermes-agent && HERMES_RUNTIME_DIR='C:\AI\tools\hermes-runtime' "$HPY" -X utf8 'C:\Claude\synalla-memory\benchmark\life-sessions\harness\hermes.py' answer --questions 'C:\Claude\synalla-memory\benchmark\life-sessions\out\questions.json' --out 'C:\Claude\synalla-memory\benchmark\life-sessions\runs\test1\answers_H.jsonl') >> $R/answer_H.log 2>&1 || { say "FAILED H"; exit 1; }
say "build O"; python -I -X utf8 benchmark/life-sessions/harness/openclaw.py build >> $R/build_O.log 2>&1 || { say "FAILED build O"; exit 1; }
say "answer O"; python -I -X utf8 benchmark/life-sessions/harness/openclaw.py answer --questions $Q --out $R/answers_O.jsonl >> $R/answer_O.log 2>&1 || { say "FAILED O"; exit 1; }
say "proactive"; node --import ./tools/ts-resolve.mjs benchmark/life-sessions/harness/proactive.mjs --out $R/proactive.jsonl >> $R/proactive.log 2>&1 || { say "FAILED proactive"; exit 1; }
python -I -X utf8 benchmark/life-sessions/harness/score_proactive.py $R/proactive.jsonl > $R/PROACTIVE.md 2>&1 || { say "FAILED proactive score"; exit 1; }
say "grade"; python -I -X utf8 benchmark/life-sessions/harness/grade.py make $R A D H O --questions $Q >> $R/grade.log 2>&1 || { say "FAILED make"; exit 1; }
python -I -X utf8 benchmark/life-sessions/harness/grade.py local $R --model fast >> $R/grade.log 2>&1 || { say "FAILED grade"; exit 1; }
python -I -X utf8 benchmark/life-sessions/harness/grade.py score $R $R/grades_local_fast.json --questions $Q >> $R/grade.log 2>&1 || { say "FAILED score"; exit 1; }
say "TEST DONE"
