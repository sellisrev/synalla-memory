#!/bin/bash
# Full generation (Serge's go, 25 Nov 2026): tuning people (dev) first, then the test people.
# Per set: write -> judge -> rewrite rejected, up to 4 rounds, then a last write; then the questions.
cd /c/Claude/synalla-memory/benchmark/life-sessions
for SET in dev test; do
  export LIFE_SET=$SET
  for r in 1 2 3 4; do
    echo "== $SET round $r write $(date -Is)"; python -I -X utf8 generate.py || { echo "FAILED write $SET"; exit 1; }
    echo "== $SET round $r judge $(date -Is)"; python -I -X utf8 judge.py > judge_${SET}_r$r.log 2>&1 || { echo "FAILED judge $SET"; exit 1; }
    tail -1 judge_${SET}_r$r.log
    grep -q "JUDGE DONE: [0-9]* judged, 0 rejected" judge_${SET}_r$r.log && break
  done
  echo "== $SET final write $(date -Is)"; python -I -X utf8 generate.py || { echo "FAILED final write $SET"; exit 1; }
  python -I -X utf8 questions.py || { echo "FAILED questions $SET"; exit 1; }
  echo "== $SET DONE $(date -Is)"
done
echo "GEN DONE $(date -Is)"
