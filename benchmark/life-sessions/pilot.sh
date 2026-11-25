#!/bin/bash
# write -> judge -> rewrite rejected, up to 3 rounds
cd /c/Claude/synalla-memory/benchmark/life-sessions
ONLY=${ONLY:-L01,L04,L06}; MAX=${MAX:-8}
for r in 1 2 3; do
  echo "== round $r write"; python -I -X utf8 generate.py --only $ONLY --max-sessions $MAX || exit 1
  echo "== round $r judge"; python -I -X utf8 judge.py --only $ONLY | tee judge_r$r.log || exit 1
  grep -q "JUDGE DONE: [0-9]* judged, 0 rejected" judge_r$r.log && break
done
echo "== final write"; python -I -X utf8 generate.py --only $ONLY --max-sessions $MAX
echo PILOT DONE
