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

# --- 4. who is actually attached to that network? ----------------------------
# Asking the network is better than starting a throwaway container to run a
# lookup: it needs no image, pulls nothing, and it is the same fact. An earlier
# version borrowed the app's image by `docker ps --format {{.Image}}`, which on a
# compose-built image yields a bare ID; `docker run <id>:latest` then failed and
# the failure text was mistaken for a successful lookup.
NET=${PG_NETWORK:-${DB_NETS[0]}}
echo
info "containers attached to '$NET'"
docker network inspect "$NET" --format '{{range .Containers}}{{.Name}} {{.IPv4Address}}{{"\n"}}{{end}}' \
  | sed '/^$/d;s/^/     /' || true

# --- 5. and is the app itself on that network? -------------------------------
echo
# Identify the app container by compose's own labels, not by name. After a
# directory rename there are usually two sets of containers whose names both
# start "monit", and `docker ps -a` returns the newest first — so a name match
# happily picks the abandoned one and reports on the wrong container.
PROJECT=$(basename "$(pwd)")
APP_CT=$(docker ps -a \
  --filter "label=com.docker.compose.project=$PROJECT" \
  --filter "label=com.docker.compose.service=app" \
  --format '{{.Names}}' | head -1)
[ -n "$APP_CT" ] && ok "app container identified by compose label (project '$PROJECT')"
if [ -z "$APP_CT" ]; then
  APP_CT=$(docker ps -a --format '{{.Names}}' | grep -E '^monit' | grep -v -- '-db$' | head -1)
  [ -n "$APP_CT" ] && warn "no compose label matched project '$PROJECT' — falling back to the name '$APP_CT'"
fi
if [ -z "$APP_CT" ]; then
  warn "no app container found (looked for a name starting 'monit')"
  echo "     docker compose -f docker-compose.app-only.yml up -d"
  exit 1
fi

STATE=$(docker inspect "$APP_CT" --format '{{.State.Status}}')
RESTARTS=$(docker inspect "$APP_CT" --format '{{.RestartCount}}')
info "app container '$APP_CT' — state: $STATE, restarts: $RESTARTS"

# A container that is not running has released its endpoints, so an empty
# network list here means nothing on its own. Say so rather than letting it read
# as "not attached".
mapfile -t APP_NETS < <(docker inspect "$APP_CT" \
  --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' | sed '/^$/d')
CFG_NET=$(docker inspect "$APP_CT" --format '{{.HostConfig.NetworkMode}}')

if [ "${#APP_NETS[@]}" -eq 0 ]; then
  warn "it is attached to nothing right now — expected while it is $STATE"
  info "the network it was created with: ${CFG_NET:-unknown}"
else
  info "attached to: ${APP_NETS[*]}"
fi

SHARED=""
for a in "${APP_NETS[@]:-}" "$CFG_NET"; do
  for d in "${DB_NETS[@]}"; do [ "$a" = "$d" ] && SHARED=$a; done
done

if [ -n "$SHARED" ]; then
  ok "app and database are both on '$SHARED'"
  echo
  if [ "$STATE" != "running" ]; then
    warn "so the network is right, and the app is still $STATE — the cause is elsewhere."
    echo "   Its last words:"
    docker logs --tail 12 "$APP_CT" 2>&1 | sed 's/^/     /'
  else
    ok "nothing to fix here."
  fi
else
  bad "the app is not on '$NET', where the database is."
  echo
  echo "   Recreate it so compose attaches it (reads PG_NETWORK from .env):"
  echo "     docker compose -p monit -f docker-compose.app-only.yml up -d --force-recreate"
  echo
  echo "   Or attach the existing container and restart it:"
  echo "     docker network connect $NET $APP_CT && docker restart $APP_CT"
  if [ "$FIX" = 1 ]; then
    echo
    info "--fix: attaching and restarting"
    docker network connect "$NET" "$APP_CT" 2>&1 | sed 's/^/     /' || true
    docker restart "$APP_CT" >/dev/null && ok "restarted $APP_CT"
    sleep 4
    echo "   Log now:"
    docker logs --tail 8 "$APP_CT" 2>&1 | sed 's/^/     /'
  fi
  exit 1
fi

# --- 6. leftovers from a previous project name -------------------------------
# Compose names containers <project>_<service>_N, and the project defaults to the
# directory name. Moving the checkout renames everything and abandons the old
# set, which keeps running, keeps its port binding, and confuses every log you
# read afterwards.
OLD=$(docker ps -a --format '{{.Names}}\t{{.Status}}' | grep -E '^monit' | grep -v "^$APP_CT" | grep -v -- '-db' || true)
if [ -n "$OLD" ]; then
  echo
  warn "other monit containers exist — probably from the directory's previous name:"
  printf '%s\n' "$OLD" | sed 's/^/     /'
  echo "   Once the new one is healthy, remove them:  docker rm -f <name>"
  echo "   To stop the name moving again, pin the project:  docker compose -p monit …"
fi

echo
