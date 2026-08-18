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

API_URL=${1:?usage: sudo ./install.sh <API_URL> <SERVER_ID> <API_KEY> [loop|cron]}
SERVER_ID=${2:?missing SERVER_ID}
API_KEY=${3:?missing API_KEY}
MODE=${4:-loop}
DIR=$(cd "$(dirname "$0")" && pwd)
API_URL=${API_URL%/}

info() { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root (sudo $0 …)"
command -v curl >/dev/null 2>&1 || die "curl is required"
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
ok "installed /opt/monit/monit-agent.sh"

# --- 4. config ---------------------------------------------------------------
# Pick the interface that carries the default route rather than assuming eth0 —
# on RHEL-family hosts it is usually ens192/enp0s3 and the network charts would
# otherwise stay empty.
IFACE=$(ip route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev") {print $(i+1); exit}}')
[ -z "$IFACE" ] && IFACE=$(ls /sys/class/net 2>/dev/null | grep -v '^lo$' | head -1)
: "${IFACE:=eth0}"

GPU=auto
command -v nvidia-smi >/dev/null 2>&1 && ok "nvidia-smi found — GPU metrics enabled"

if [ -f /etc/monit/agent.conf ]; then
  warn "/etc/monit/agent.conf exists — keeping it, only updating URL / ID / key"
  tmp=$(mktemp)
  grep -vE '^(MONIT_API_URL|MONIT_SERVER_ID|MONIT_API_KEY)=' /etc/monit/agent.conf > "$tmp"
  {
    printf 'MONIT_API_URL=%s\n' "$API_URL"
    printf 'MONIT_SERVER_ID=%s\n' "$SERVER_ID"
    printf 'MONIT_API_KEY=%s\n' "$API_KEY"
    cat "$tmp"
  } > /etc/monit/agent.conf
  rm -f "$tmp"
else
  cat > /etc/monit/agent.conf <<EOF
# /etc/monit/agent.conf  (root:monit, 0640)
MONIT_API_URL=$API_URL
MONIT_SERVER_ID=$SERVER_ID
MONIT_API_KEY=$API_KEY
MONIT_INTERVAL=10
MONIT_TIMEOUT=5
MONIT_CONNECT_TIMEOUT=2
MONIT_BUFFER_DIR=/var/lib/monit-agent/buffer
MONIT_BUFFER_MAX=50
MONIT_NET_IFACES="$IFACE"
MONIT_GPU=$GPU
MONIT_HTTP_CHECKS=""
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
if [ "$MODE" = "cron" ]; then
  printf '* * * * * monit /opt/monit/monit-agent.sh >> /var/log/monit-agent.log 2>&1\n' \
    > /etc/cron.d/monit-agent
  chmod 0644 /etc/cron.d/monit-agent
  ok "installed cron job (one sample per minute)"
elif command -v systemctl >/dev/null 2>&1; then
  install -m 0644 "$DIR/monit-agent.service" /etc/systemd/system/monit-agent.service
  systemctl daemon-reload
  systemctl enable --now monit-agent.service
  sleep 3
  if systemctl is-active --quiet monit-agent; then
    ok "monit-agent running (a sample every 10 s)"
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
  config:  /etc/monit/agent.conf   (restart after editing: systemctl restart monit-agent)
  payload: bash /opt/monit/monit-agent.sh --print

EOF
