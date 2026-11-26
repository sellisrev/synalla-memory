#!/bin/bash
# Dev QA (tuning people only): Synalla A and D on the dev questions, graded by Gemma, scored.
cd /c/Claude/synalla-memory
export LIFE_SET=dev
R=benchmark/life-sessions/runs/dev1; Q=benchmark/life-sessions/out_dev/questions.json
mkdir -p $R
for arm in D A; do
  echo "== answer $arm $(date -Is)"
  node --import ./tools/ts-resolve.mjs benchmark/life-sessions/harness/synalla.mjs answer --arm $arm --questions $Q --out $R/answers_$arm.jsonl >> $R/answer_$arm.log 2>&1 || { echo "FAILED $arm"; exit 1; }
done
echo "== grade $(date -Is)"
python -I -X utf8 benchmark/life-sessions/harness/grade.py make $R A D --questions $Q >> $R/grade.log 2>&1 || { echo "FAILED make"; exit 1; }
python -I -X utf8 benchmark/life-sessions/harness/grade.py local $R --model fast >> $R/grade.log 2>&1 || { echo "FAILED grade"; exit 1; }
python -I -X utf8 benchmark/life-sessions/harness/grade.py score $R $R/grades_local_fast.json --questions $Q >> $R/grade.log 2>&1 || { echo "FAILED score"; exit 1; }
echo "DEV QA DONE $(date -Is)"
