#!/usr/bin/env bash
#
# migrate-db-to-native.sh — move the monit database out of its Docker container
# into a PostgreSQL installed on the host, on the same machine.
#
#   ./migrate-db-to-native.sh --check     # what would move, and what would stop it
#   ./migrate-db-to-native.sh --dump      # dump only (app keeps running)
#   ./migrate-db-to-native.sh --cutover   # stop app, final dump, restore, verify
#
# Nothing is deleted. The container and its volume are left exactly as they are,
# so the way back is to put the old DATABASE_URL in .env and start the app again.
set -uo pipefail
cd "$(dirname "$0")"

CONTAINER=${MONIT_DB_CONTAINER:-postgres-db}
DB=${MONIT_DB_NAME:-monit}
# The two names need not match. A database created ahead of time is often called
# something else — monit_server, say — and assuming one name for both sides made
# the script insist on creating a database that already existed under another.
TARGET_DB=${MONIT_TARGET_DB:-$DB}
DBUSER=${MONIT_DB_USER:-monit}
TARGET_HOST=${MONIT_TARGET_HOST:-127.0.0.1}
TARGET_PORT=${MONIT_TARGET_PORT:-5432}
OUTDIR=${MONIT_DUMP_DIR:-/var/backups/monit}
COMPOSE_FILE=${MONIT_COMPOSE_FILE:-docker-compose.app-only.yml}
PROJECT=${MONIT_COMPOSE_PROJECT:-}

MODE=""
while [ $# -gt 0 ]; do
  case $1 in
    --check) MODE=check ;;
    --dump) MODE=dump ;;
    --cutover) MODE=cutover ;;
    --verify) MODE=verify ;;
    -h|--help) sed -n '3,12p' "$0"; exit 0 ;;
    *) echo "unknown argument '$1'"; sed -n '3,12p' "$0"; exit 2 ;;
  esac
  shift
done
[ -n "$MODE" ] || { sed -n '3,12p' "$0"; exit 2; }

info() { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '\033[31m✗\033[0m %s\n' "$*"; }
die()  { bad "$*"; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker is not on this host"
docker inspect "$CONTAINER" >/dev/null 2>&1 || die "no container named '$CONTAINER' (set MONIT_DB_CONTAINER)"

# Everything here reads the source through `docker exec`, which needs the
# container RUNNING. Stopping it to free a port is the one move that makes the
# data unreachable — and it is the obvious thing to try, so say so precisely.
if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != true ]; then
  bad "container '$CONTAINER' is not running, so its data cannot be read."
  echo "     Nothing is lost — the rows are in its volume. Start it again:"
  echo "       docker start $CONTAINER"
  echo
  echo "     If you stopped it to free port $TARGET_PORT for the native server:"
  echo "       the two only collide when the container PUBLISHES that port."
  echo "       Check with:  docker port $CONTAINER"
  echo "       Nothing listed = no collision; run both and carry on."
  echo "       Otherwise, take the dump FIRST, then stop the container, then"
  echo "       start the native server on $TARGET_PORT."
  exit 1
fi

# A published port is the only reason the two servers cannot coexist.
PUBLISHED=$(docker port "$CONTAINER" 2>/dev/null | tr -d '\r')

# Run psql/pg_dump INSIDE the container. Its client version matches the server
# it is dumping, which is the pairing that always works — and it needs no
# published port, so nothing has to be exposed to the network for this.
csql() { docker exec -i "$CONTAINER" psql -U "$DBUSER" -d "$DB" -Atc "$1" 2>/dev/null | tr -d '\r'; }

# docker writes some failures ("executable file not found") to stdout, so an
# emptiness test is not enough — it happily accepted an error message as a
# version string. Validate the shape of what came back.
csql_num() {
  local out; out=$(csql "$1")
  # A real server answers "16.3 (Debian 16.3-1.pgdg120+1)", so the whole string
  # is not numeric and must not be required to be — take the leading number and
  # check THAT. Demanding digits end to end rejected every genuine answer.
  case ${out%% *} in
    ''|*[!0-9.]*) return 1 ;;
    *) printf '%s' "${out%% *}" ;;
  esac
}

TARGET_PSQL=(psql -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$DBUSER")

# ---------------------------------------------------------------------------
# check
# ---------------------------------------------------------------------------
# $1 = "source-only" to skip the target checks. Taking the dump must not depend
# on the native server existing yet — when the container publishes the port, the
# dump is exactly what you do BEFORE that server can start.
do_check() {
  local scope=${1:-full}
  local fatal=0

  info "source: container '$CONTAINER', database '$DB'"
  local sver
  if ! sver=$(csql_num "show server_version"); then
    bad "cannot read a version from '$CONTAINER'. What came back:"
    local raw; raw=$(csql "show server_version")
    printf '%s\n' "${raw:-(nothing on stdout — psql wrote only to stderr)}" | sed 's/^/     /' | head -3
    echo "     · is psql on PATH in that container?   docker exec $CONTAINER which psql"
    echo "     · is the user right?                   MONIT_DB_USER=… (now: $DBUSER)"
    echo "     · is the database right?               MONIT_DB_NAME=… (now: $DB)"
    exit 1
  fi
  ok "source PostgreSQL $sver"

  local size
  size=$(csql "select pg_size_pretty(pg_database_size('$DB'))")
  ok "database size: $size"

  # Extensions decide whether this is a plain dump/restore or a special case.
  local exts
  exts=$(csql "select string_agg(extname, ' ' order by extname) from pg_extension")
  info "extensions: ${exts:-none}"
  case " $exts " in
    *" timescaledb "*)
      bad "TimescaleDB is installed on the source."
      echo "     A plain dump/restore does NOT carry hypertables. The target needs the"
      echo "     timescaledb package installed and the restore has to be wrapped in"
      echo "     timescaledb_pre_restore() / timescaledb_post_restore()."
      echo "     Stop here and do that deliberately — this script will not guess."
      fatal=1 ;;
  esac
  case " $exts " in
    *" pgcrypto "*)
      # gen_random_uuid() lives here on older servers; the target must have the
      # package available or the restore fails on CREATE EXTENSION.
      info "pgcrypto is used — the target needs the contrib package (postgresql-contrib)" ;;
  esac

  # `pg_%` would also match "pgboss" — the underscore is a LIKE wildcard.
  local schemas
  schemas=$(csql "select string_agg(nspname, ' ' order by nspname) from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema'")
  info "schemas to carry: $schemas"
  case " $schemas " in
    *" pgboss "*) info "  pgboss is the job queue — it comes along, so queued notifications survive" ;;
  esac

  echo
  if [ -z "$PUBLISHED" ]; then
    ok "the container publishes no host ports — it cannot collide with a native server"
    echo "     Both can run at the same time. Do not stop it."
  else
    info "the container publishes: $(echo "$PUBLISHED" | tr '\n' ' ')"
    if echo "$PUBLISHED" | grep -q ":${TARGET_PORT}\$"; then
      warn "it holds host port $TARGET_PORT, which the native server also wants."
      echo "     Do NOT stop the container to free it — that is what makes the data"
      echo "     unreadable. Either:"
      echo "       · give the native server another port for now"
      echo "         (MONIT_TARGET_PORT=5433 $0 --check), or"
      echo "       · run $0 --dump first, then stop the container,"
      echo "         then start the native server on $TARGET_PORT and restore."
    fi
  fi

  if [ "$scope" = source-only ]; then
    echo
    [ "$fatal" = 0 ] && { ok "source is readable — taking the dump"; return 0; } || die "fix the above first"
  fi

  echo
  info "target: $TARGET_HOST:$TARGET_PORT, database '$TARGET_DB'"
  local terr
  terr=$("${TARGET_PSQL[@]}" -d postgres -Atc 'select 1' 2>&1 >/dev/null)
  if [ -n "$terr" ]; then
    bad "cannot connect to the target as '$DBUSER'. psql said:"
    printf '%s\n' "$terr" | sed 's/^/     /' | head -4
    echo
    # Every one of these needs -p: psql and its friends default to 5432, so on a
    # server running anywhere else they fail with a confusing socket error that
    # has nothing to do with the real problem.
    echo "     The port is not optional — these tools all default to 5432:"
    echo "       sudo -u postgres psql -p $TARGET_PORT -c '\\du'          # does the role exist?"
    echo "       sudo -u postgres psql -p $TARGET_PORT -c '\\l'           # what databases are there?"
    echo
    echo "     Create them if they are missing:"
    echo "       sudo -u postgres createuser -p $TARGET_PORT --pwprompt $DBUSER"
    echo "       sudo -u postgres createdb   -p $TARGET_PORT -O $DBUSER $TARGET_DB"
    echo
    echo "     If the role exists, it is the password or pg_hba.conf:"
    echo "       export PGPASSWORD='…'   (or put it in ~/.pgpass)"
    echo "       sudo -u postgres psql -p $TARGET_PORT -c \"ALTER ROLE $DBUSER PASSWORD '…'\""
    fatal=1
  else
    local tver
    tver=$("${TARGET_PSQL[@]}" -d postgres -Atc 'show server_version')
    tver=${tver%% *}
    ok "target PostgreSQL $tver"
    # Restoring into an OLDER server is the case that breaks; the other way is fine.
    if [ "${tver%%.*}" -lt "${sver%%.*}" ]; then
      bad "the target ($tver) is older than the source ($sver) — a dump from $sver may not restore"
      fatal=1
    fi
    if "${TARGET_PSQL[@]}" -d "$TARGET_DB" -Atc 'select 1' >/dev/null 2>&1; then
      local n
      n=$("${TARGET_PSQL[@]}" -d "$TARGET_DB" -Atc "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')")
      if [ "${n:-0}" -gt 0 ]; then
        bad "the target database '$TARGET_DB' already has $n table(s) — refusing to restore over it"
        echo "     Drop and recreate it, or set MONIT_TARGET_DB to an empty one."
        fatal=1
      else
        ok "target database '$TARGET_DB' exists and is empty"
      fi
    else
      warn "target database '$TARGET_DB' does not exist yet — create it:"
      echo "       sudo -u postgres createdb -p $TARGET_PORT -O $DBUSER $TARGET_DB"
      fatal=1
    fi
  fi

  echo
  local avail
  avail=$(df -Pk "$(dirname "$OUTDIR")" 2>/dev/null | awk 'NR==2{print $4}')
  info "dump directory: $OUTDIR ($((${avail:-0} / 1024)) MB free on that filesystem)"

  echo
  [ "$fatal" = 0 ] && ok "ready — next: $0 --dump (safe to run while the app is up)" \
    || die "fix the above first"
}

# ---------------------------------------------------------------------------
# dump
# ---------------------------------------------------------------------------
dump_now() {
  mkdir -p "$OUTDIR" || die "cannot create $OUTDIR"
  chmod 700 "$OUTDIR"
  DUMP="$OUTDIR/${DB}-$(date +%Y%m%d-%H%M%S).dump"
  info "dumping → $DUMP"
  # -Fc: the custom format, so pg_restore can parallelise and report per object.
  # --no-owner/--no-acl: the target's role set is its own; ownership is set by
  # restoring as $DBUSER rather than by replaying grants that may not exist.
  if ! docker exec "$CONTAINER" pg_dump -U "$DBUSER" -d "$DB" -Fc --no-owner --no-acl > "$DUMP" 2>/tmp/monit-dump.err; then
    sed 's/^/     /' /tmp/monit-dump.err >&2
    rm -f "$DUMP"
    die "pg_dump failed"
  fi
  [ -s "$DUMP" ] || { rm -f "$DUMP"; die "the dump is empty"; }
  # A truncated dump is worse than none: pg_restore -l fails on one, and it is
  # cheap to find out now rather than during the cutover.
  pg_restore -l "$DUMP" >/dev/null 2>&1 || die "the dump is unreadable — pg_restore cannot list it"
  ok "dump written: $(du -h "$DUMP" | cut -f1), $(pg_restore -l "$DUMP" | grep -c '^[0-9]') objects"
  printf '%s\n' "$DUMP" > "$OUTDIR/.latest"
}

# ---------------------------------------------------------------------------
# counts, for comparing the two sides
# ---------------------------------------------------------------------------
COUNT_SQL="select 'servers='||(select count(*) from servers)
  ||' users='||(select count(*) from users)
  ||' api_keys='||(select count(*) from api_keys)
  ||' projects='||(select count(*) from projects)
  ||' alert_rules='||(select count(*) from alert_rules)
  ||' incidents='||(select count(*) from incidents)
  ||' app_settings='||(select count(*) from app_settings)
  ||' system_metrics='||(select count(*) from system_metrics)"

do_verify() {
  local src tgt
  src=$(csql "$COUNT_SQL")
  tgt=$("${TARGET_PSQL[@]}" -d "$TARGET_DB" -Atc "$COUNT_SQL" 2>/dev/null | tr -d '\r')
  echo "  container : $src"
  echo "  native    : $tgt"
  if [ -n "$tgt" ] && [ "$src" = "$tgt" ]; then
    ok "row counts match"
    return 0
  fi
  bad "row counts DIFFER — do not switch the app over"
  return 1
}

# ---------------------------------------------------------------------------
# cutover
# ---------------------------------------------------------------------------
do_cutover() {
  do_check || exit 1
  echo
  # The app must be down for the final dump, or rows written between dump and
  # switch are simply lost. Agents buffer locally (MONIT_BUFFER_MAX samples), so
  # a few minutes of downtime costs no data.
  info "stopping the app so nothing is written during the copy"
  if [ -n "$PROJECT" ]; then
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" stop app || warn "could not stop via compose"
  else
    docker compose -f "$COMPOSE_FILE" stop app || warn "could not stop via compose — stop it by hand"
  fi
  sleep 2

  dump_now
  local dump; dump=$(cat "$OUTDIR/.latest")

  info "restoring into $TARGET_HOST:$TARGET_PORT/$TARGET_DB"
  # --single-transaction so a failure leaves the target empty rather than half
  # populated; --exit-on-error so it stops at the first real problem.
  if ! pg_restore -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$DBUSER" -d "$TARGET_DB" \
       --no-owner --no-acl --single-transaction --exit-on-error "$dump" 2>/tmp/monit-restore.err; then
    sed 's/^/     /' /tmp/monit-restore.err >&2
    die "restore failed — the app is still stopped and the container still holds the data"
  fi
  ok "restored"

  echo
  info "comparing both sides"
  do_verify || die "stopping here; the container is untouched, put the old DATABASE_URL back and start the app"

  echo
  ok "the data is on the native server. The app is still STOPPED, on purpose."
  cat <<EOF

  Now point the app at it and start it again:

  1. Edit .env — DATABASE_URL must be reachable FROM INSIDE THE CONTAINER.
     "127.0.0.1" there means the container itself, not this host. Use the
     host's address on the docker bridge:

       DATABASE_URL=postgres://$DBUSER:PASSWORD@172.17.0.1:$TARGET_PORT/$TARGET_DB

     (check it: docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')
     or this machine's LAN address, e.g. 10.1.1.171.

  2. Let PostgreSQL accept it — as postgres, on this host:

       listen_addresses = '*'                       # postgresql.conf
       host  $TARGET_DB  $DBUSER  172.17.0.0/16  scram-sha-256   # pg_hba.conf
       sudo systemctl reload postgresql

  3. Start the app and watch it come up:

       docker compose -f $COMPOSE_FILE up -d app
       docker logs -f \$(docker compose -f $COMPOSE_FILE ps -q app)

  4. When the dashboard is healthy and agents are reporting, and not before,
     retire the old database. The container still has every row until you do.

EOF
}

case $MODE in
  check)   do_check ;;
  dump)    do_check source-only && dump_now ;;
  verify)  do_verify ;;
  cutover) do_cutover ;;
esac
