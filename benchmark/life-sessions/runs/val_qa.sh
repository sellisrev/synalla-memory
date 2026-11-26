#!/bin/bash
# Validation people (never tuned on): extraction v1 vs v2, answered by A (passages), D (v1 facts), D2 (v2 facts),
# graded blind by Gemma. Waits for the val questions (gen2.sh writes them when val generation is done).
cd /c/Claude/synalla-memory
export LIFE_SET=val
R=benchmark/life-sessions/runs/val1; Q=benchmark/life-sessions/out_val/questions.json
mkdir -p $R
until [ -f $Q ]; do sleep 60; done
echo "== build v1 $(date -Is)"
node --import ./tools/ts-resolve.mjs benchmark/life-sessions/harness/synalla.mjs build >> $R/build_v1.log 2>&1 || { echo "FAILED build v1"; exit 1; }
echo "== build v2 $(date -Is)"
node --import ./tools/ts-resolve.mjs benchmark/life-sessions/harness/synalla.mjs build --variant v2 >> $R/build_v2.log 2>&1 || { echo "FAILED build v2"; exit 1; }
for arm in A D D2; do
  echo "== answer $arm $(date -Is)"
  if [ $arm = D2 ]; then a="--variant v2 --arm D"; else a="--arm $arm"; fi
  node --import ./tools/ts-resolve.mjs benchmark/life-sessions/harness/synalla.mjs answer $a --questions $Q --out $R/answers_$arm.jsonl >> $R/answer_$arm.log 2>&1 || { echo "FAILED answer $arm"; exit 1; }
done
echo "== grade $(date -Is)"
python -I -X utf8 benchmark/life-sessions/harness/grade.py make $R A D D2 --questions $Q >> $R/grade.log 2>&1 || { echo "FAILED make"; exit 1; }
python -I -X utf8 benchmark/life-sessions/harness/grade.py local $R --model fast >> $R/grade.log 2>&1 || { echo "FAILED grade"; exit 1; }
python -I -X utf8 benchmark/life-sessions/harness/grade.py score $R $R/grades_local_fast.json --questions $Q >> $R/grade.log 2>&1 || { echo "FAILED score"; exit 1; }
echo "VAL QA DONE $(date -Is)"
