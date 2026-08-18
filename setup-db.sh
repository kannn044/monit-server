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

# Percent-encode everything that is not unreserved, so any password is safe
# inside a connection string.
urlencode() {
  local s=$1 out="" i c
  for (( i=0; i<${#s}; i++ )); do
    c=${s:i:1}
    case $c in [a-zA-Z0-9.~_-]) out+=$c ;; *) out+=$(printf '%%%02X' "'$c") ;; esac
  done
  printf '%s' "$out"
}

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
# A fresh password every run, unless one was passed with -w. We reset the role's
# password below anyway, so there is nothing to preserve — and picking it apart
# from an existing DATABASE_URL with a regex was fragile enough to corrupt the
# connection string. Hex only, so it never needs escaping inside a URL.
[ -z "$DBPASS" ] && DBPASS=$(openssl rand -hex 20)

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

# --- 4. find a hostname the app container can actually reach ----------------
# The container name is not always the right DNS name: Compose registers the
# *service* name as the network alias, and a container renamed with
# `container_name:` will not match it. So collect every candidate and test them.
# Read the port, then REJECT anything that is not purely numeric. Do not try to
# salvage digits out of a bad value: "1HiRA3yIfNitr2dQ" would become "132", a
# plausible-looking port that is simply wrong. A junk value here lands in the
# port slot of the connection string and surfaces as psql's confusing
# "invalid integer value … for connection option port".
PGPORT_RAW=$(psql_super -tAc 'SHOW port;' 2>/dev/null | head -1 | tr -d '[:space:]')
if [[ $PGPORT_RAW =~ ^[0-9]+$ ]]; then
  PGPORT=$PGPORT_RAW
else
  [ -n "$PGPORT_RAW" ] && warn "unexpected value when reading the port ('$PGPORT_RAW') — using 5432"
  PGPORT=5432
fi
[ "$PGPORT" != "5432" ] && info "database listens on port $PGPORT inside the network"

mapfile -t ALIASES < <(docker inspect "$CONTAINER" \
  -f "{{with index .NetworkSettings.Networks \"$NETWORK\"}}{{range .Aliases}}{{.}}{{\"\n\"}}{{end}}{{end}}" 2>/dev/null | sed '/^$/d')
PGIP=$(docker inspect "$CONTAINER" \
  -f "{{with index .NetworkSettings.Networks \"$NETWORK\"}}{{.IPAddress}}{{end}}" 2>/dev/null)

CANDIDATES=()
for h in "$CONTAINER" "${ALIASES[@]}" "$PGIP"; do
  [ -z "$h" ] && continue
  case " ${CANDIDATES[*]} " in *" $h "*) ;; *) CANDIDATES+=("$h") ;; esac
done

# Use the database's own image as the psql client: it is already pulled, so this
# works on a host with no registry access.
CLIENT_IMAGE=$(docker inspect "$CONTAINER" -f '{{.Config.Image}}' 2>/dev/null)
docker image inspect "$CLIENT_IMAGE" >/dev/null 2>&1 || CLIENT_IMAGE="postgres:16-alpine"

info "testing the connection from inside network '$NETWORK' (user=$DBUSER db=$DBNAME port=$PGPORT)…"
DBHOST=""; LAST_ERR=""
for h in "${CANDIDATES[@]}"; do
  # Discrete flags rather than a URI: nothing here can be mis-parsed, whatever
  # characters the password happens to contain.
  if out=$(docker run --rm --network "$NETWORK" -e PGPASSWORD="$DBPASS" "$CLIENT_IMAGE" \
             psql -h "$h" -p "$PGPORT" -U "$DBUSER" -d "$DBNAME" -tAc 'SELECT 1' 2>&1); then
    DBHOST=$h; ok "reachable as '$h:$PGPORT'"; break
  fi
  LAST_ERR=$out
  printf '  · %s — %s\n' "$h" "$(printf '%s' "$out" | grep -iE 'error|fatal|could not' | head -1)"
done

if [ -z "$DBHOST" ]; then
  echo
  echo "Full error from the last attempt:" >&2
  printf '%s\n' "$LAST_ERR" | sed 's/^/    /' >&2
  echo >&2
  case "$LAST_ERR" in
    *"could not translate host name"*|*"Name or service not known"*|*"Temporary failure in name resolution"*)
      echo "  → DNS: none of these names resolve on '$NETWORK': ${CANDIDATES[*]}" >&2
      echo "    Check the network is right:  docker inspect $CONTAINER -f '{{json .NetworkSettings.Networks}}'" >&2 ;;
    *"Connection refused"*)
      echo "  → Reached the host but nothing is listening on port $PGPORT." >&2
      echo "    Check listen_addresses:  docker exec $CONTAINER psql -U $PGSUPER -c 'SHOW listen_addresses'" >&2 ;;
    *"no pg_hba.conf entry"*)
      echo "  → pg_hba.conf has no rule for this client. Add inside the database container:" >&2
      echo "      host  $DBNAME  $DBUSER  0.0.0.0/0  scram-sha-256" >&2
      echo "    then:  docker exec $CONTAINER psql -U $PGSUPER -c 'SELECT pg_reload_conf()'" >&2 ;;
    *"password authentication failed"*)
      echo "  → The password was rejected. Re-run with an explicit one:  $0 -c $CONTAINER -w '<password>'" >&2 ;;
    *"does not exist"*)
      echo "  → The role or database is missing — unexpected here; re-run the script." >&2 ;;
    *"Unable to find image"*|*"pull access denied"*|*"manifest unknown"*)
      echo "  → Could not get a psql client image ('$CLIENT_IMAGE'). Pull one, or pass -w to skip." >&2 ;;
    *)
      echo "  → See the error above; it came straight from psql." >&2 ;;
  esac
  exit 1
fi

DATABASE_URL="postgres://$(urlencode "$DBUSER"):$(urlencode "$DBPASS")@$DBHOST:$PGPORT/$DBNAME"

# --- 5. write .env (keeping anything already set) ---------------------------
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
ok "wrote .env  (DATABASE_URL=postgres://$DBUSER:****@$DBHOST:$PGPORT/$DBNAME)"

# --- 6. run the migrations --------------------------------------------------
info "building the image and running migrations…"
docker compose -f docker-compose.app-only.yml build app >/dev/null
docker compose -f docker-compose.app-only.yml run --rm --no-deps app node src/db/migrate.js

printf '\n\033[32m✓ database ready\033[0m\n\nStart the app with:\n\n    docker compose -f docker-compose.app-only.yml up -d --build\n    docker compose -f docker-compose.app-only.yml logs -f app\n\nThe admin password is printed in that log, once.\nDashboard: http://<this-server-ip>:%s\n\n' "$APP_PORT"
