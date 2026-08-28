#!/usr/bin/env bash
#
# install.sh — install monit-agent on a Linux host. Run as root.
#
#   sudo ./install.sh <API_URL> <SERVER_ID> <API_KEY> [loop|cron]
#
#   API_URL     base URL of the central server, e.g. http://10.1.0.50/monit
#               (no /api/v1/ingest — the agent appends that itself)
#   SERVER_ID   must match the ID registered in the dashboard
#   API_KEY     shown once when the server was registered
#   loop|cron   systemd loop every 10 s (default), or a one-shot cron minute
#
# Checks connectivity and sends one real sample before enabling anything, so a
# wrong URL, ID or key fails here rather than silently later.
set -euo pipefail

API_URL=${1:-}
SERVER_ID=${2:-}
API_KEY=${3:-}
MODE=${4:-}
DIR=$(cd "$(dirname "$0")" && pwd)

info() { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root (sudo $0 …)"
command -v curl >/dev/null 2>&1 || die "curl is required"

# Sensible defaults offered by the prompts -----------------------------------
DEF_IFACE=$(ip route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev") {print $(i+1); exit}}')
[ -z "$DEF_IFACE" ] && DEF_IFACE=$(ls /sys/class/net 2>/dev/null | grep -v '^lo$' | head -1)
: "${DEF_IFACE:=eth0}"
DEF_ID=$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo server-01)
INTERVAL=10
HTTP_CHECKS=""
IFACE=""

# Re-use answers from a previous install where possible.
if [ -f /etc/monit/agent.conf ]; then
  # shellcheck disable=SC1091
  . /etc/monit/agent.conf 2>/dev/null || true
  [ -n "${MONIT_API_URL:-}" ]     && DEF_URL=$MONIT_API_URL
  [ -n "${MONIT_SERVER_ID:-}" ]   && DEF_ID=$MONIT_SERVER_ID
  [ -n "${MONIT_INTERVAL:-}" ]    && INTERVAL=$MONIT_INTERVAL
  [ -n "${MONIT_NET_IFACES:-}" ]  && DEF_IFACE=$MONIT_NET_IFACES
  [ -n "${MONIT_HTTP_CHECKS:-}" ] && HTTP_CHECKS=$MONIT_HTTP_CHECKS
fi

ask() {  # ask <prompt> <default> <varname>
  local prompt=$1 default=$2 __var=$3 reply
  if [ -n "$default" ]; then
    read -r -p "  $prompt [$default]: " reply </dev/tty || reply=""
    reply=${reply:-$default}
  else
    read -r -p "  $prompt: " reply </dev/tty || reply=""
  fi
  printf -v "$__var" '%s' "$reply"
}

# Interactive when anything essential is missing ------------------------------
if [ -z "$API_URL" ] || [ -z "$SERVER_ID" ] || [ -z "$API_KEY" ]; then
  [ -t 0 ] || die "not a terminal — pass arguments instead:
   sudo $0 <API_URL> <SERVER_ID> <API_KEY> [loop|cron]"

  echo
  echo "  ── monit agent setup ─────────────────────────────────────────"
  echo "  Press Enter to accept the value in brackets."
  echo

  [ -z "$API_URL" ] && ask "Central server URL (include any sub-path, e.g. http://10.1.0.50/monit)" "${DEF_URL:-}" API_URL
  [ -z "$SERVER_ID" ] && ask "Server ID (must match the dashboard)" "$DEF_ID" SERVER_ID
  while [ -z "$API_KEY" ]; do
    ask "API key (shown once when the server was registered)" "" API_KEY
    [ -z "$API_KEY" ] && warn "the API key cannot be empty"
  done
  ask "Sample interval in seconds" "$INTERVAL" INTERVAL
  ask "Network interface(s) to report, space separated" "$DEF_IFACE" IFACE
  ask "Local HTTP health checks, comma separated (blank = none)" "$HTTP_CHECKS" HTTP_CHECKS
  ask "Run mode: loop (systemd, every ${INTERVAL}s) or cron (once a minute)" "${MODE:-loop}" MODE

  echo
  echo "  ── summary ───────────────────────────────────────────────────"
  printf '    %-14s %s\n' "URL:" "$API_URL" "ID:" "$SERVER_ID" \
         "key:" "${API_KEY:0:16}…" "interval:" "${INTERVAL}s" \
         "interface:" "$IFACE" "http checks:" "${HTTP_CHECKS:-none}" "mode:" "$MODE"
  echo
  read -r -p "  Proceed? [Y/n]: " yn </dev/tty || yn=""
  case "${yn:-y}" in [Yy]*) ;; *) echo "  cancelled"; exit 0 ;; esac
  echo
fi

MODE=${MODE:-loop}
API_URL=${API_URL%/}
[[ $INTERVAL =~ ^[0-9]+$ ]] && [ "$INTERVAL" -ge 5 ] \
  || die "interval must be a whole number of at least 5 seconds, got '$INTERVAL'"
[[ $SERVER_ID =~ ^[A-Za-z0-9._-]+$ ]] \
  || die "server ID may only contain letters, digits, dot, underscore and hyphen — got '$SERVER_ID'"
case "$MODE" in loop|cron) ;; *) die "mode must be 'loop' or 'cron', got '$MODE'" ;; esac

# --- 1. can we reach the central server at all? ------------------------------
info "checking $API_URL …"
HEALTH=$(curl -fsS --max-time 10 "$API_URL/api/v1/health" 2>&1) || {
  echo "$HEALTH" | sed 's/^/    /' >&2
  die "cannot reach $API_URL/api/v1/health from this host.
   · behind nginx? the URL needs the sub-path, e.g. http://host/monit
   · firewall open on the central server?
   · try:  curl -v $API_URL/api/v1/health"
}
ok "central server reachable"

# --- 2. system user ----------------------------------------------------------
# nologin lives in different places across distributions.
NOLOGIN=$(command -v nologin || true)
[ -z "$NOLOGIN" ] && for p in /usr/sbin/nologin /sbin/nologin /bin/false; do
  [ -x "$p" ] && NOLOGIN=$p && break
done
: "${NOLOGIN:=/bin/false}"

if id -u monit >/dev/null 2>&1; then
  ok "user 'monit' exists"
else
  useradd --system --no-create-home --shell "$NOLOGIN" monit
  ok "created system user 'monit' (shell $NOLOGIN)"
fi

# --- 3. files ----------------------------------------------------------------
mkdir -p /opt/monit /etc/monit /var/lib/monit-agent/buffer
install -m 0755 "$DIR/monit-agent.sh" /opt/monit/monit-agent.sh
chown -R monit:monit /var/lib/monit-agent
[ -f "$DIR/monit-config.sh" ] && install -m 0755 "$DIR/monit-config.sh" /opt/monit/monit-config.sh
[ -f "$DIR/check-ndb.sh" ] && install -m 0755 "$DIR/check-ndb.sh" /opt/monit/check-ndb.sh
ok "installed /opt/monit/monit-agent.sh"

# --- 4. config ---------------------------------------------------------------
# Pick the interface that carries the default route rather than assuming eth0 —
# on RHEL-family hosts it is usually ens192/enp0s3 and the network charts would
# otherwise stay empty.
: "${IFACE:=$DEF_IFACE}"

GPU=auto
command -v nvidia-smi >/dev/null 2>&1 && ok "nvidia-smi found — GPU metrics enabled"

if [ -f /etc/monit/agent.conf ]; then
  warn "/etc/monit/agent.conf exists — keeping it, only updating URL / ID / key"
  tmp=$(mktemp)
  grep -vE '^(MONIT_API_URL|MONIT_SERVER_ID|MONIT_API_KEY|MONIT_INTERVAL|MONIT_NET_IFACES|MONIT_HTTP_CHECKS)=' \
    /etc/monit/agent.conf > "$tmp"
  {
    printf 'MONIT_API_URL=%s\n'      "$API_URL"
    printf 'MONIT_SERVER_ID=%s\n'    "$SERVER_ID"
    printf 'MONIT_API_KEY=%s\n'      "$API_KEY"
    printf 'MONIT_INTERVAL=%s\n'     "$INTERVAL"
    printf 'MONIT_NET_IFACES="%s"\n' "$IFACE"
    printf 'MONIT_HTTP_CHECKS="%s"\n' "$HTTP_CHECKS"
    cat "$tmp"
  } > /etc/monit/agent.conf
  rm -f "$tmp"
else
  cat > /etc/monit/agent.conf <<EOF
# /etc/monit/agent.conf  (root:monit, 0640)
MONIT_API_URL=$API_URL
MONIT_SERVER_ID=$SERVER_ID
MONIT_API_KEY=$API_KEY
MONIT_INTERVAL=$INTERVAL
MONIT_TIMEOUT=5
MONIT_CONNECT_TIMEOUT=2
MONIT_BUFFER_DIR=/var/lib/monit-agent/buffer
MONIT_BUFFER_MAX=50
MONIT_NET_IFACES="$IFACE"
MONIT_GPU=$GPU
MONIT_HTTP_CHECKS="$HTTP_CHECKS"
MONIT_DOCKER_MAX=100
# Local database monitoring — needs a read-only login, see docs/OPERATIONS.md
MONIT_MYSQL=0
MONIT_PG=0
EOF
  ok "wrote /etc/monit/agent.conf (interface: $IFACE)"
fi
chown root:monit /etc/monit/agent.conf
chmod 0640 /etc/monit/agent.conf

# --- 5. docker access (optional) ---------------------------------------------
if command -v docker >/dev/null 2>&1 && getent group docker >/dev/null 2>&1; then
  if id -nG monit 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
    ok "'monit' already in the docker group"
  else
    usermod -aG docker monit
    ok "added 'monit' to the docker group (container metrics)"
  fi
fi

# --- 5b. pm2 access (optional) -----------------------------------------------
# PM2 state lives in a per-user daemon and PM2 will not serve a socket it does
# not own, so 'monit' cannot see apps started by root or a deploy user — it gets
# an empty daemon of its own and the dashboard shows "0 online". The daemon
# advertises its PM2_HOME in its process title, so we can find it and install a
# narrow NOPASSWD rule for one helper that only ever runs `pm2 jlist`.
setup_pm2_access() {
  local daemons owner home foreign=0 bin owner_home
  daemons=$(ps -eo user:32,args 2>/dev/null | awk '
    /God Daemon/ && !/awk/ {
      if (match($0, /\(([^)]*\.pm2[^)]*)\)/))
        printf "%s\t%s\n", $1, substr($0, RSTART + 1, RLENGTH - 2)
    }' | sort -u)

  if [ -z "$daemons" ]; then
    command -v pm2 >/dev/null 2>&1 && \
      warn "pm2 is installed but no daemon is running — nothing to monitor yet"
    return 0
  fi

  while IFS=$'\t' read -r owner home; do
    [ -z "$owner" ] && continue
    [ "$owner" = monit ] && continue
    foreign=1
    ok "found PM2 daemon: $owner ($home)"
    # Pin the binary the way the owner sees it — pm2 is usually under nvm and
    # would not be on root's PATH inside the helper.
    if [ -z "${PM2_BIN:-}" ]; then
      owner_home=$(getent passwd "$owner" | cut -d: -f6)
      for bin in /usr/local/bin/pm2 /usr/bin/pm2 \
                 "$owner_home"/.nvm/versions/node/*/bin/pm2 \
                 "$owner_home"/.npm-global/bin/pm2 "$owner_home"/.yarn/bin/pm2; do
        [ -x "$bin" ] && { PM2_BIN=$bin; break; }
      done
      [ -z "${PM2_BIN:-}" ] && PM2_BIN=$(command -v pm2 2>/dev/null || true)
    fi
  done <<< "$daemons"

  [ "$foreign" = 1 ] || return 0

  if [ ! -f "$DIR/monit-pm2.sh" ]; then
    warn "monit-pm2.sh is missing from the agent directory — PM2 will show as unreadable"
    return 0
  fi
  install -m 0755 -o root -g root "$DIR/monit-pm2.sh" /opt/monit/monit-pm2.sh

  if [ -n "${PM2_BIN:-}" ]; then
    printf '# written by monit install.sh — root-owned on purpose\nMONIT_PM2_BIN=%s\n' "$PM2_BIN" \
      > /etc/monit/pm2.conf
    chown root:root /etc/monit/pm2.conf; chmod 0644 /etc/monit/pm2.conf
    ok "pinned pm2 binary: $PM2_BIN"
  fi

  if ! command -v sudo >/dev/null 2>&1; then
    warn "sudo is not installed — PM2 belonging to another user cannot be read"
    return 0
  fi
  cat > /etc/sudoers.d/monit-agent <<'SUDO'
# Lets the monit agent read PM2 state owned by another user.
# The helper is root-owned 0755 and can only run `pm2 jlist`.
monit ALL=(root) NOPASSWD: /opt/monit/monit-pm2.sh
SUDO
  chmod 0440 /etc/sudoers.d/monit-agent
  if command -v visudo >/dev/null 2>&1 && ! visudo -cf /etc/sudoers.d/monit-agent >/dev/null 2>&1; then
    rm -f /etc/sudoers.d/monit-agent
    warn "the sudoers rule did not validate and was removed — PM2 will show as unreadable"
    return 0
  fi
  ok "granted 'monit' read-only access to PM2 (sudoers.d/monit-agent)"
  # sudo is setuid, which NoNewPrivileges forbids — the unit is written without
  # it when this path is in use.
  PM2_SUDO=1
}
setup_pm2_access

# --- 6. send one real sample before enabling anything ------------------------
info "sending a test sample…"
PAYLOAD=$(runuser -u monit -- bash /opt/monit/monit-agent.sh --print 2>/dev/null \
          || sudo -u monit bash /opt/monit/monit-agent.sh --print 2>/dev/null) \
  || die "the agent could not build a payload — run: bash /opt/monit/monit-agent.sh --print"

CODE=$(printf '%s' "$PAYLOAD" | curl -s -o /dev/null -w '%{http_code}' \
        --max-time 15 -X POST "$API_URL/api/v1/ingest" \
        -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
        --data-binary @-)

case "$CODE" in
  202) ok "sample accepted (HTTP 202)" ;;
  401) die "HTTP 401 — the API key is wrong or was revoked. Rotate it in the dashboard and re-run." ;;
  403) die "HTTP 403 — this key belongs to a different server.
   MONIT_SERVER_ID is '$SERVER_ID'; it must match the ID registered in the dashboard." ;;
  429) warn "HTTP 429 — rate limited; another agent may already be reporting as '$SERVER_ID'" ;;
  400) die "HTTP 400 — the server rejected the payload. Inspect it with:
   bash /opt/monit/monit-agent.sh --print" ;;
  *)   die "unexpected HTTP $CODE from $API_URL/api/v1/ingest" ;;
esac

# --- 7. enable ---------------------------------------------------------------
# Each mode disables the other. Leaving both enabled would report the host
# twice — double the traffic, and rate-limit rejections on the central server.
if [ "$MODE" = "cron" ]; then
  if systemctl list-unit-files monit-agent.service >/dev/null 2>&1; then
    systemctl disable --now monit-agent 2>/dev/null || true
    rm -f /etc/systemd/system/monit-agent.service
    systemctl daemon-reload 2>/dev/null || true
    warn "switched from the systemd loop to cron — the service was removed"
  fi
  printf '* * * * * monit /opt/monit/monit-agent.sh >> /var/log/monit-agent.log 2>&1\n' \
    > /etc/cron.d/monit-agent
  chmod 0644 /etc/cron.d/monit-agent
  ok "installed cron job (one sample per minute — MONIT_INTERVAL does not apply)"
elif command -v systemctl >/dev/null 2>&1; then
  if [ -f /etc/cron.d/monit-agent ]; then
    rm -f /etc/cron.d/monit-agent
    warn "switched from cron to the systemd loop — the cron job was removed"
  fi
  rm -f /etc/monit/cron.disabled
  if [ "${PM2_SUDO:-0}" = 1 ]; then
    # sudo is setuid, and NoNewPrivileges=true makes every setuid exec fail — the
    # PM2 helper would silently return nothing. Everything else stays hardened.
    sed 's/^NoNewPrivileges=true$/# NoNewPrivileges disabled: the PM2 helper runs through sudo\nNoNewPrivileges=false/' \
      "$DIR/monit-agent.service" > /etc/systemd/system/monit-agent.service
    chmod 0644 /etc/systemd/system/monit-agent.service
    warn "NoNewPrivileges disabled so the agent can read PM2 through sudo"
  else
    install -m 0644 "$DIR/monit-agent.service" /etc/systemd/system/monit-agent.service
  fi
  systemctl daemon-reload
  systemctl enable --now monit-agent.service
  sleep 3
  if systemctl is-active --quiet monit-agent; then
    ok "monit-agent running (a sample every ${INTERVAL}s)"
  else
    systemctl status monit-agent --no-pager -l | tail -15
    die "the service failed to start — see the status above"
  fi
else
  die "systemd not found; re-run with 'cron' as the last argument"
fi

cat <<EOF

$(ok "done — '$SERVER_ID' should show as online in the dashboard within ~30 s")

  logs:    journalctl -u monit-agent -f
  change:  sudo /opt/monit/monit-config.sh          (interval, checks, key — restarts for you)
  payload: bash /opt/monit/monit-agent.sh --print

EOF
