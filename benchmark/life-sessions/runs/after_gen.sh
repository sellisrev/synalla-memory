#!/bin/bash
# After generation: the final write's sessions were never judged. Judge them once (a rejected one is deleted and its
# storylines are not asked), rebuild the questions, then start the test chain.
cd /c/Claude/synalla-memory/benchmark/life-sessions
export LIFE_SET=test
until grep -q "== test DONE" gen.log; do sleep 60; done
echo "== final judge $(date -Is)"
python -I -X utf8 judge.py > judge_test_final.log 2>&1 || { echo "FAILED final judge"; exit 1; }
tail -1 judge_test_final.log
python -I -X utf8 questions.py || { echo "FAILED questions"; exit 1; }
echo "== start test chain $(date -Is)"
bash runs/test_runs.sh v2 >> runs/test_runs.log 2>&1
