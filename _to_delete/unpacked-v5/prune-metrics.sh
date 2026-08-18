#!/usr/bin/env bash
#
# prune-metrics.sh — delete metric samples older than N days.
#
# Needed when running without TimescaleDB, where there is no retention policy
# and system_metrics grows forever (~30 MB per monitored server per day at a
# 10 s interval).
#
# Meant for cron. It is quiet on success apart from a one-line summary, exits
# non-zero on failure so cron mails you, and deletes in batches so it never
# holds a long transaction against a table the ingest API is writing to.
#
# Examples:
#   ./prune-metrics.sh                      # keep 14 days (default)
#   ./prune-metrics.sh -d 30                # keep 30 days
#   ./prune-metrics.sh -N                   # dry run — count only, delete nothing
#   ./prune-metrics.sh -d 30 -V             # prune, then VACUUM to return disk
#
#   -d DAYS      retention in days (default 14)
#   -l DAYS      also prune notification_log older than this (default 90)
#   -i DAYS      also prune resolved incidents older than this (default 365)
#   -b ROWS      rows per batch (default 50000)
#   -c NAME      PostgreSQL container name (default: auto-detect)
#   -n DBNAME    database name (default: monit)
#   -U ROLE      role to connect as inside the container (default: postgres)
#   -L           local mode: use psql on this host with DATABASE_URL
#   -N           dry run
#   -V           VACUUM the table afterwards
#   -q           quiet: only print on error
#
# Suggested crontab (03:30 daily, log to a file):
#   30 3 * * * /opt/monit-server/prune-metrics.sh -d 14 >> /var/log/monit-prune.log 2>&1

set -euo pipefail

DAYS=14; LOG_DAYS=90; INC_DAYS=365; BATCH=50000
CONTAINER=""; DBNAME="monit"; DBROLE="postgres"
LOCAL=0; DRYRUN=0; DOVACUUM=0; QUIET=0
cd "$(dirname "$0")"

while getopts "d:l:i:b:c:n:U:LNVqh" opt; do
  case $opt in
    d) DAYS=$OPTARG ;;      l) LOG_DAYS=$OPTARG ;;  i) INC_DAYS=$OPTARG ;;
    b) BATCH=$OPTARG ;;     c) CONTAINER=$OPTARG ;; n) DBNAME=$OPTARG ;;
    U) DBROLE=$OPTARG ;;    L) LOCAL=1 ;;           N) DRYRUN=1 ;;
    V) DOVACUUM=1 ;;        q) QUIET=1 ;;
    h) sed -n '3,32p' "$0"; exit 0 ;;
    *) echo "run '$0 -h' for usage" >&2; exit 2 ;;
  esac
done

check_num() {  # $1 = flag, $2 = value
  [[ $2 =~ ^[0-9]+$ ]] || { echo "✗ -$1 must be a whole number, got '$2'" >&2; exit 2; }
}
check_num d "$DAYS"; check_num l "$LOG_DAYS"
check_num i "$INC_DAYS"; check_num b "$BATCH"
[ "$BATCH" -ge 1 ] || { echo "✗ -b must be at least 1" >&2; exit 2; }

ts()   { date '+%Y-%m-%d %H:%M:%S'; }
say()  { [ "$QUIET" = 1 ] || printf '%s %s\n' "$(ts)" "$*"; }
die()  { printf '%s ✗ %s\n' "$(ts)" "$*" >&2; exit 1; }

# --- how do we reach the database? ------------------------------------------
if [ "$LOCAL" = 0 ] && [ -z "$CONTAINER" ] && command -v docker >/dev/null 2>&1 \
   && docker info >/dev/null 2>&1; then
  CONTAINER=$(docker ps --format '{{.Names}}\t{{.Image}}' \
    | awk -F'\t' 'tolower($2) ~ /postgres|timescale/ {print $1; exit}')
fi

if [ -n "$CONTAINER" ] && [ "$LOCAL" = 0 ]; then
  docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" \
    || die "container '$CONTAINER' is not running"
  # Connects over the container's local socket, so no password is needed.
  psql_run() { docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U "$DBROLE" -d "$DBNAME" -tAc "$1"; }
  SOURCE="container '$CONTAINER', database '$DBNAME'"
else
  command -v psql >/dev/null 2>&1 || die "no PostgreSQL container found and psql is not installed"
  if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
    DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)
  fi
  [ -n "${DATABASE_URL:-}" ] || die "set DATABASE_URL (or put it in .env) for local mode"
  psql_run() { psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -tAc "$1"; }
  SOURCE="DATABASE_URL"
fi

psql_run 'SELECT 1' >/dev/null 2>&1 || die "cannot connect via $SOURCE"

table_size() { psql_run "SELECT pg_size_pretty(pg_total_relation_size('$1'))" 2>/dev/null || echo '?'; }

# --- report ------------------------------------------------------------------
CUTOFF="now() - INTERVAL '$DAYS days'"
OLD=$(psql_run "SELECT count(*) FROM system_metrics WHERE time < $CUTOFF")
TOTAL=$(psql_run "SELECT count(*) FROM system_metrics")
SIZE_BEFORE=$(table_size system_metrics)

say "system_metrics: $TOTAL rows, $SIZE_BEFORE — $OLD older than $DAYS days ($SOURCE)"

if [ "$DRYRUN" = 1 ]; then
  say "dry run — nothing deleted"
  exit 0
fi

# --- delete in batches -------------------------------------------------------
# One statement per batch keeps transactions short, so ingest writes are never
# blocked behind a multi-million-row delete.
deleted=0
if [ "$OLD" -gt 0 ]; then
  while :; do
    n=$(psql_run "WITH doomed AS (
           SELECT ctid FROM system_metrics WHERE time < $CUTOFF LIMIT $BATCH
         )
         DELETE FROM system_metrics m USING doomed d WHERE m.ctid = d.ctid
         RETURNING 1" | grep -c '^1$' || true)
    [ "${n:-0}" -eq 0 ] && break
    deleted=$((deleted + n))
    [ "$deleted" -ge "$OLD" ] && break
  done
fi

# --- companion tables (they grow far more slowly) ----------------------------
log_del=$(psql_run "WITH d AS (DELETE FROM notification_log
            WHERE created_at < now() - INTERVAL '$LOG_DAYS days' RETURNING 1)
          SELECT count(*) FROM d")
inc_del=$(psql_run "WITH d AS (DELETE FROM incidents
            WHERE status = 'resolved' AND resolved_at < now() - INTERVAL '$INC_DAYS days' RETURNING 1)
          SELECT count(*) FROM d")

if [ "$DOVACUUM" = 1 ]; then
  say "vacuuming…"
  psql_run 'VACUUM (ANALYZE) system_metrics' >/dev/null
fi

SIZE_AFTER=$(table_size system_metrics)
say "deleted $deleted samples, $log_del notification_log rows, $inc_del resolved incidents"
if [ "$DOVACUUM" = 1 ]; then
  say "size $SIZE_BEFORE → $SIZE_AFTER"
elif [ "$deleted" -gt 0 ]; then
  # DELETE marks rows dead; the file only shrinks after VACUUM. Autovacuum will
  # reuse the space for new samples, so the table plateaus instead of growing —
  # pass -V only when you actually need the disk back.
  say "on-disk size unchanged ($SIZE_AFTER) — freed space is reused by new samples; pass -V to reclaim it"
fi
