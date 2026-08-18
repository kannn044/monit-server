#!/usr/bin/env bash
#
# setup-db.sh — point monit at a PostgreSQL that already runs as a Docker
# container, in one command.
#
# It will:
#   1. find your PostgreSQL container and the Docker network it is on
#   2. create the `monit` role and database inside it (never touching yours)
#   3. write .env (DATABASE_URL, PG_NETWORK, APP_PORT)
#   4. run the schema migrations
#   5. print the single command that starts the app
#
# Safe to re-run: every step checks before it creates, and existing .env values
# are kept.
#
# Usage:
#   ./setup-db.sh                          # interactive, detects what it can
#   ./setup-db.sh -c my-postgres -u postgres -d monit -p 8080
#
#   -c  PostgreSQL container name        -u  superuser role inside it (default: postgres)
#   -d  database to create (monit)       -w  password for the new monit role
#   -n  Docker network to join           -p  host port for the dashboard (8080)
#   -y  no prompts (fail if something must be guessed)

set -euo pipefail

CONTAINER=""; PGSUPER="postgres"; DBNAME="monit"; DBUSER="monit"
DBPASS=""; NETWORK=""; APP_PORT="8080"; ASSUME_YES=0
cd "$(dirname "$0")"

while getopts "c:u:d:w:n:p:yh" opt; do
  case $opt in
    c) CONTAINER=$OPTARG ;; u) PGSUPER=$OPTARG ;; d) DBNAME=$OPTARG ;;
    w) DBPASS=$OPTARG ;;   n) NETWORK=$OPTARG ;; p) APP_PORT=$OPTARG ;;
    y) ASSUME_YES=1 ;;
    h) sed -n '3,25p' "$0"; exit 0 ;;
    *) echo "run '$0 -h' for usage" >&2; exit 2 ;;
  esac
done

info()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()    { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[33m!\033[0m %s\n' "$*"; }
die()   { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker not found on PATH"
docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon (try sudo, or start Docker)"

# --- 1. locate the PostgreSQL container ------------------------------------
if [ -z "$CONTAINER" ]; then
  info "looking for a PostgreSQL container…"
  mapfile -t FOUND < <(docker ps --format '{{.Names}}\t{{.Image}}' \
    | awk -F'\t' 'tolower($2) ~ /postgres|timescale/ {print $1}')
  case ${#FOUND[@]} in
    0) die "no running PostgreSQL container found. Pass it explicitly: $0 -c <container-name>" ;;
    1) CONTAINER=${FOUND[0]}; ok "found container: $CONTAINER" ;;
    *)
      [ "$ASSUME_YES" = 1 ] && die "several PostgreSQL containers found; choose one with -c"
      echo "Several PostgreSQL containers are running:"
      select c in "${FOUND[@]}"; do [ -n "${c:-}" ] && CONTAINER=$c && break; done
      ;;
  esac
else
  docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" \
    || die "container '$CONTAINER' is not running"
  ok "using container: $CONTAINER"
fi

# --- 2. figure out which network to join ------------------------------------
if [ -z "$NETWORK" ]; then
  mapfile -t NETS < <(docker inspect "$CONTAINER" \
    -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' | sed '/^$/d')
  case ${#NETS[@]} in
    0) die "container '$CONTAINER' is on no Docker network — cannot reach it" ;;
    1) NETWORK=${NETS[0]} ;;
    *)
      if [ "$ASSUME_YES" = 1 ]; then NETWORK=${NETS[0]}
      else
        echo "'$CONTAINER' is on several networks — pick the one to join:"
        select n in "${NETS[@]}"; do [ -n "${n:-}" ] && NETWORK=$n && break; done
      fi
      ;;
  esac
fi
ok "network: $NETWORK"

psql_super() { docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PGSUPER" -d postgres "$@"; }

psql_super -tAc 'SELECT 1' >/dev/null 2>&1 \
  || die "cannot run psql in '$CONTAINER' as role '$PGSUPER' — pass the right one with -u"

PGVER=$(psql_super -tAc 'SHOW server_version;' | cut -d. -f1)
ok "PostgreSQL $PGVER"
[ "$PGVER" -lt 13 ] 2>/dev/null && warn "PostgreSQL < 13: the pgcrypto extension must be installable for gen_random_uuid()"

# --- 3. create the role and database ----------------------------------------
if [ -z "$DBPASS" ]; then
  EXISTING_URL=$(grep -E '^DATABASE_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- || true)
  if [ -n "$EXISTING_URL" ]; then
    DBPASS=$(printf '%s' "$EXISTING_URL" | sed -E 's|^postgres(ql)?://[^:]+:([^@]+)@.*|\2|')
    [ -n "$DBPASS" ] && info "reusing the password already in .env"
  fi
  # hex keeps the password safe to embed in a URL without escaping
  [ -z "$DBPASS" ] && DBPASS=$(openssl rand -hex 20)
fi

info "creating role '$DBUSER' and database '$DBNAME' in $CONTAINER…"
psql_super >/dev/null <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$DBUSER') THEN
    CREATE ROLE $DBUSER LOGIN PASSWORD '$DBPASS';
  ELSE
    ALTER ROLE $DBUSER WITH LOGIN PASSWORD '$DBPASS';
  END IF;
END
\$\$;
SQL
if psql_super -tAc "SELECT 1 FROM pg_database WHERE datname='$DBNAME'" | grep -q 1; then
  ok "database '$DBNAME' already exists — leaving its contents alone"
  psql_super -c "ALTER DATABASE $DBNAME OWNER TO $DBUSER" >/dev/null
else
  psql_super -c "CREATE DATABASE $DBNAME OWNER $DBUSER" >/dev/null
  ok "database '$DBNAME' created"
fi

DATABASE_URL="postgres://$DBUSER:$DBPASS@$CONTAINER:5432/$DBNAME"

# --- 4. write .env (keeping anything already set) ---------------------------
touch .env; chmod 600 .env
set_env() {
  local key=$1 val=$2
  if grep -qE "^${key}=" .env; then
    # only overwrite the keys this script owns
    case $key in DATABASE_URL|PG_NETWORK|APP_PORT)
      sed -i.bak -E "s|^${key}=.*|${key}=${val}|" .env && rm -f .env.bak ;;
    esac
  else
    printf '%s=%s\n' "$key" "$val" >> .env
  fi
}
set_env DATABASE_URL "$DATABASE_URL"
set_env PG_NETWORK   "$NETWORK"
set_env APP_PORT     "$APP_PORT"
ok "wrote .env"

# --- 5. verify connectivity the way the app will see it ---------------------
info "testing the connection from inside the network…"
docker run --rm --network "$NETWORK" postgres:16-alpine \
  psql "$DATABASE_URL" -tAc 'SELECT 1' >/dev/null 2>&1 \
  || die "the app's network cannot reach $CONTAINER:5432 as '$DBUSER'.
   Check that '$CONTAINER' is on network '$NETWORK' and its pg_hba allows password auth."
ok "connection works"

# --- 6. run the migrations --------------------------------------------------
info "building the image and running migrations…"
docker compose -f docker-compose.app-only.yml build app >/dev/null
docker compose -f docker-compose.app-only.yml run --rm --no-deps app node src/db/migrate.js

printf '\n\033[32m✓ database ready\033[0m\n\nStart the app with:\n\n    docker compose -f docker-compose.app-only.yml up -d --build\n    docker compose -f docker-compose.app-only.yml logs -f app\n\nThe admin password is printed in that log, once.\nDashboard: http://<this-server-ip>:%s\n\n' "$APP_PORT"
