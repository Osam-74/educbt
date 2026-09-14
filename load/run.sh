#!/usr/bin/env bash
# Repeatable Phase-1 load run: reset attempts -> k6 journey -> DB verify.
#
#   ./load/run.sh <candidates> [extra k6 args...]
#
# Environment (all optional):
#   BASE_URLS   comma-separated app base URLs (default http://127.0.0.1:3017)
#   THINK_SECONDS  pause between candidate actions (default 1)
#
# LOCAL/test infrastructure only - never production (load-testing
# production needs explicit approval per the pilot runbook).

set -euo pipefail
cd "$(dirname "$0")/.."

CANDIDATES="${1:?usage: ./load/run.sh <candidates> [extra k6 args...]}"
shift || true

export BASE_URLS="${BASE_URLS:-http://127.0.0.1:3017}"
export THINK_SECONDS="${THINK_SECONDS:-1}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="load/results/${STAMP}-n${CANDIDATES}"
mkdir -p "$OUT"

# Reset: drop all load-school attempts so every candidate starts clean.
set -a; . ./.env.local; set +a
psql "$DATABASE_URL_UNPOOLED" -q -c "
  DELETE FROM attempts
  WHERE school_id IN (SELECT id FROM schools WHERE subdomain LIKE 'load%');
" >/dev/null
echo "[$STAMP] attempts reset for load schools"

# DB pressure observer: samples pg_stat_activity every 5s during the run.
( for i in $(seq 1 240); do
    psql "$DATABASE_URL_UNPOOLED" -At -c "
      SELECT now()::text, count(*) FILTER (WHERE state='active'),
             count(*) FILTER (WHERE state='idle'),
             count(*) FILTER (WHERE wait_event_type='Lock'),
             coalesce(max(extract(epoch from (now()-query_start))) FILTER (WHERE state='active'), 0)::text
      FROM pg_stat_activity WHERE datname=current_database();
    " >> "$OUT/db-pressure.tsv" 2>/dev/null || true
    sleep 5
  done ) &
OBSERVER_PID=$!

# The run.
CANDIDATES="$CANDIDATES" SUMMARY_OUT="$OUT/summary.json" \
  k6 run load/k6/exam.js --summary-export "$OUT/k6-summary.json" "$@" \
  2>&1 | tee "$OUT/k6-console.txt" || true

kill "$OBSERVER_PID" 2>/dev/null || true

# Post-run verification: invariants at the DB level.
npx tsx scripts/load-verify.ts | tee "$OUT/verify.txt" || true

echo
echo "Artifacts in $OUT"
