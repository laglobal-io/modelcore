#!/usr/bin/env bash
# Spins up a throwaway Postgres, applies migrations on top of a Supabase auth stub, runs SQL tests.
# Usage: bash supabase/tests/run.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
DATA="$(mktemp -d)"
PORT="${PGPORT_TEST:-54329}"
SOCK="$DATA/sock"; mkdir -p "$SOCK"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA/db" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DATA"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA/db" -U postgres -A trust >/dev/null
"$PGBIN/pg_ctl" -D "$DATA/db" -o "-p $PORT -k $SOCK -c listen_addresses=''" -l "$DATA/log" start >/dev/null
PSQL=(psql -h "$SOCK" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)

"${PSQL[@]}" -f "$ROOT/supabase/tests/00_supabase_stub.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "migrate: $(basename "$f")"
  "${PSQL[@]}" -f "$f"
done
for f in "$ROOT"/supabase/tests/*.test.sql; do
  echo "test: $(basename "$f")"
  "${PSQL[@]}" -f "$f"
done
