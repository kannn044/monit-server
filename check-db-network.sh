#!/usr/bin/env bash
#
# check-db-network.sh — why can't the app container reach the database?
#
#   ./check-db-network.sh              # check, explain, print the fix
#   ./check-db-network.sh --fix        # also run the fix, if it is the safe one
#
# `getaddrinfo EAI_AGAIN <host>` means DNS, not PostgreSQL: the app container
# asked Docker's resolver for a name and got nothing back. Docker only answers
# for containers that share a user-defined network, so the usual cause is that
# the two containers are on different networks — or that one of them is on the
# default `bridge`, where name resolution does not work at all.
set -uo pipefail
cd "$(dirname "$0")"

FIX=0
[ "${1:-}" = "--fix" ] && FIX=1

info() { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '\033[31m✗\033[0m %s\n' "$*"; }
die()  { bad "$*"; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker is not on this host"

# --- 1. what does the app think it should connect to? ------------------------
echo
info "reading .env in $(pwd)"
if [ ! -e .env ]; then
  die "no .env here. Compose reads it from the directory you run it in —
   if you moved the project, make sure .env moved with it, or re-run ./setup-db.sh."
fi
if [ ! -r .env ]; then
  die "$(pwd)/.env exists but this account cannot read it ($(stat -c '%U:%G %a' .env)).
   Run this as the same user that runs 'docker compose', or:  sudo $0 ${*:-}"
fi

DB_URL=$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"'')
PG_NETWORK=$(grep -E '^PG_NETWORK=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"'')
[ -n "$DB_URL" ] || die "DATABASE_URL is not set in .env — run ./setup-db.sh"

# postgres://user:pass@host:port/db  → pull out host and port without the password
NOSCHEME=${DB_URL#*://}
HOSTPORT=${NOSCHEME#*@}
DB_HOST=${HOSTPORT%%[:/]*}
rest=${HOSTPORT#"$DB_HOST"}
DB_PORT=5432
case $rest in :*) DB_PORT=${rest#:}; DB_PORT=${DB_PORT%%/*} ;; esac

ok "DATABASE_URL points at host '$DB_HOST' port $DB_PORT"
if [ -n "$PG_NETWORK" ]; then
  ok "PG_NETWORK=$PG_NETWORK"
else
  warn "PG_NETWORK is not set in .env — docker-compose.app-only.yml needs it"
fi

# --- 2. is the database container there, and where? --------------------------
echo
info "looking for the database container"
DB_CT=$(docker ps --format '{{.Names}}' | grep -Fx "$DB_HOST" || true)
if [ -z "$DB_CT" ]; then
  STOPPED=$(docker ps -a --format '{{.Names}}\t{{.Status}}' | grep -F "$DB_HOST" || true)
  if [ -n "$STOPPED" ]; then
    bad "a container named '$DB_HOST' exists but is not running:"
    printf '   %s\n' "$STOPPED"
    echo "   → docker start $DB_HOST"
    exit 1
  fi
  bad "no running container is named '$DB_HOST'."
  echo "   Containers that are running:"
  # sed, not leading spaces in --format: Docker strips them from the template.
  docker ps --format '{{.Names}}  ({{.Image}})' | sed 's/^/     /' || true
  echo
  echo "   Docker resolves a container by its NAME or a network alias. If your"
  echo "   database now runs under a different name, either rename it back:"
  echo "     docker rename <current-name> $DB_HOST"
  echo "   or point DATABASE_URL in .env at the name it actually has."
  exit 1
fi
ok "database container '$DB_CT' is running"

mapfile -t DB_NETS < <(docker inspect "$DB_CT" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' | sed '/^$/d')
ok "it is on: ${DB_NETS[*]}"

if [ "${#DB_NETS[@]}" = 1 ] && [ "${DB_NETS[0]}" = "bridge" ]; then
  echo
  bad "'$DB_CT' is on the DEFAULT bridge network."
  echo "   Docker does not do name resolution there — no container can look up"
  echo "   '$DB_HOST', whatever network it is on. Put the database on a named"
  echo "   network and both sides will resolve each other:"
  echo
  echo "     docker network create monit-net"
  echo "     docker network connect monit-net $DB_CT"
  echo "     # then in .env:  PG_NETWORK=monit-net"
  echo "     docker compose -f docker-compose.app-only.yml up -d"
  exit 1
fi

# --- 3. does the network the app is told to join actually hold the database? --
echo
if [ -n "$PG_NETWORK" ]; then
  if ! docker network inspect "$PG_NETWORK" >/dev/null 2>&1; then
    bad "the network '$PG_NETWORK' named in .env does not exist."
    echo "   The database is on: ${DB_NETS[*]}"
    echo "   → set PG_NETWORK to one of those in .env, then:"
    echo "     docker compose -f docker-compose.app-only.yml up -d"
    exit 1
  fi
  MATCH=0
  for n in "${DB_NETS[@]}"; do [ "$n" = "$PG_NETWORK" ] && MATCH=1; done
  if [ "$MATCH" = 0 ]; then
    bad "'$PG_NETWORK' exists, but '$DB_CT' is not attached to it."
    echo "   The app joins '$PG_NETWORK'; the database is on: ${DB_NETS[*]}"
    echo "   Two containers only resolve each other on a network they SHARE."
    echo
    echo "   Attach the database to it (safe, nothing restarts):"
    echo "     docker network connect $PG_NETWORK $DB_CT"
    if [ "$FIX" = 1 ]; then
      echo
      info "--fix: running that now"
      docker network connect "$PG_NETWORK" "$DB_CT" && ok "attached" || die "could not attach"
    else
      echo "   …or re-run this script with --fix"
      exit 1
    fi
  else
    ok "'$DB_CT' is attached to '$PG_NETWORK'"
  fi
fi

# --- 4. can something on that network actually resolve the name? -------------
echo
info "resolving '$DB_HOST' from inside the network"
APP_IMG=$(docker ps -a --filter 'name=monit' --format '{{.Image}}' | head -1)
NET=${PG_NETWORK:-${DB_NETS[0]}}
if [ -n "$APP_IMG" ]; then
  OUT=$(docker run --rm --network "$NET" --entrypoint sh "$APP_IMG" -c \
        "getent hosts $DB_HOST || nslookup $DB_HOST 2>/dev/null" 2>&1 | head -3)
  if [ -n "$OUT" ]; then
    ok "resolved: $(echo "$OUT" | head -1)"
  else
    bad "still cannot resolve '$DB_HOST' on network '$NET'"
    echo "   Check for a network alias rather than a plain name:"
    echo "     docker inspect $DB_CT --format '{{json .NetworkSettings.Networks}}' | tr ',' '\\n' | grep -i alias"
    exit 1
  fi
else
  warn "no monit container to borrow an image from — skipping the live lookup"
fi

# --- 5. and is the app itself on that network? -------------------------------
echo
APP_CT=$(docker ps -a --format '{{.Names}}' | grep -E '^monit(-|_|$)' | head -1)
if [ -n "$APP_CT" ]; then
  mapfile -t APP_NETS < <(docker inspect "$APP_CT" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' | sed '/^$/d')
  info "app container '$APP_CT' is on: ${APP_NETS[*]:-(none)}"
  SHARED=""
  for a in "${APP_NETS[@]:-}"; do for d in "${DB_NETS[@]}"; do [ "$a" = "$d" ] && SHARED=$a; done; done
  if [ -n "$SHARED" ]; then
    ok "app and database share '$SHARED'"
    echo
    ok "networking looks right — restart the app to pick it up:"
    echo "     docker compose -f docker-compose.app-only.yml up -d"
    echo "     docker logs -f $APP_CT"
  else
    bad "app and database share no network."
    echo "     docker network connect ${PG_NETWORK:-${DB_NETS[0]}} $APP_CT"
    echo "   or, better, fix PG_NETWORK in .env and recreate it:"
    echo "     docker compose -f docker-compose.app-only.yml up -d --force-recreate"
    exit 1
  fi
fi

echo
