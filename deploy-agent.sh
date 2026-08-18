#!/usr/bin/env bash
#
# deploy-agent.sh — push the agent to a target host and install it, from here.
#
#   ./deploy-agent.sh gdata@10.1.1.175 -i api-server -k sk_agent_xxx
#   ./deploy-agent.sh root@10.1.0.101 -a -e you@company.com
#   ./deploy-agent.sh gdata@10.1.1.175 -u                  # update the agent only
#
#   -i ID     server ID to register/use (default: the target's hostname)
#   -k KEY    API key; omit to be prompted, or use -a to create one for you
#   -a        register the server on the dashboard and take the key from it,
#             so there is no key to copy by hand (needs a dashboard admin)
#   -e EMAIL  admin email for -a; the password comes from $MONIT_ADMIN_PASSWORD
#             or is prompted for. Set both to deploy without any typing.
#   -U URL    central server URL as the TARGET sees it
#             (default: read from .env / guessed from this host's IP)
#   -m MODE   loop (default) or cron
#   -u        upload the new agent files and restart; leave config alone
#   -S        stop and disable the agent (config and files stay in place)
#   -E        start it again after -S
#   -X        remove the agent completely (service, files, config, user)
#   -y        no prompts on the target
#
# The remote account does not need to be root: files are staged in the account's
# own home directory and only the install step runs through sudo. One ssh
# connection is shared for the whole run, so a password is asked for once.
set -euo pipefail

cd "$(dirname "$0")"
TARGET=${1:-}; shift || true
[ -n "$TARGET" ] || { sed -n '3,25p' "$0"; exit 2; }

SERVER_ID=""; API_KEY=""; API_URL=""; MODE="loop"; UPDATE_ONLY=0; ASSUME_YES=0; AUTO_REG=0
ADMIN_EMAIL=""; ACTION=""

while getopts "i:k:U:m:e:uaySEXh" opt; do
  case $opt in
    i) SERVER_ID=$OPTARG ;; k) API_KEY=$OPTARG ;; U) API_URL=${OPTARG%/} ;;
    m) MODE=$OPTARG ;;     u) UPDATE_ONLY=1 ;;  a) AUTO_REG=1 ;;
    e) ADMIN_EMAIL=$OPTARG ;;
    S) ACTION=stop ;;      E) ACTION=start ;;   X) ACTION=remove ;;
    y) ASSUME_YES=1 ;;
    h) sed -n '3,25p' "$0"; exit 0 ;;
    *) exit 2 ;;
  esac
done
shift $((OPTIND - 1))

info() { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# Values must be passed as flags. Accepting them positionally would mean
# silently ignoring "deploy.sh host api-server sk_agent_…" and prompting for
# things the caller already supplied.
if [ $# -gt 0 ]; then
  die "unexpected argument '$1' — values go in flags:
   $0 $TARGET -i <server-id> -k <api-key>"
fi

command -v rsync >/dev/null 2>&1 || die "rsync is not installed on this host"
command -v ssh   >/dev/null 2>&1 || die "ssh is not installed on this host"
[ -d agent ] || die "run this from the monit-server directory (no ./agent here)"

# --- one shared ssh connection for the whole run -----------------------------
# Without this every step re-authenticates; with a password-only account that
# means typing it five or six times.
CTL_DIR=$(mktemp -d /tmp/monit-deploy.XXXXXX)
CTL="$CTL_DIR/ctl"
cleanup() {
  ssh -o ControlPath="$CTL" -O exit "$TARGET" 2>/dev/null || true
  rm -rf "$CTL_DIR"
}
trap cleanup EXIT

SSH_OPTS=(-o ControlMaster=auto -o ControlPath="$CTL" -o ControlPersist=300 -o ConnectTimeout=15)
rsh()  { ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }        # no tty
rsht() { ssh "${SSH_OPTS[@]}" -t "$TARGET" "$@"; }     # tty, so sudo can prompt

rsh true || die "cannot ssh to $TARGET — check the host, user and your key/password"
ok "ssh to $TARGET works"

# --- root, or sudo? ----------------------------------------------------------
REMOTE_UID=$(rsh 'id -u' | tr -d '\r')
STAGE=$(rsh 'echo "$HOME"' | tr -d '\r')/.monit-agent-deploy
if [ "$REMOTE_UID" = "0" ]; then
  SUDO=""
  ok "connected as root"
else
  if rsh 'sudo -n true' >/dev/null 2>&1; then
    SUDO="sudo"
    ok "sudo available without a password"
  elif rsht 'sudo -v' </dev/tty; then
    SUDO="sudo"
    ok "sudo authenticated"
  else
    die "'$TARGET' is not root and sudo is not usable.
   Either deploy as root (root@…), or give this account sudo rights."
  fi
fi

# Privileged remote command. Uses a tty so a sudo password prompt is visible.
sudo_rsh() { if [ -n "$SUDO" ]; then rsht "$SUDO bash -c '$1'"; else rsh "bash -c '$1'"; fi; }

# --- stop / start / remove ---------------------------------------------------
if [ -n "$ACTION" ]; then
  case $ACTION in
    stop)
      sudo_rsh '
        if systemctl list-unit-files monit-agent.service >/dev/null 2>&1; then
          systemctl disable --now monit-agent 2>/dev/null || true
        fi
        [ -f /etc/cron.d/monit-agent ] && mv /etc/cron.d/monit-agent /etc/monit/cron.disabled 2>/dev/null || true
        pkill -f "[/]opt/monit/monit-agent[.]sh" 2>/dev/null || true
        sleep 1
        if pgrep -f "[/]opt/monit/monit-agent[.]sh" >/dev/null; then echo "STILL RUNNING"; exit 1; fi
        echo stopped'
      ok "agent stopped and disabled on $TARGET (files and config kept)"
      echo "  start it again with:  $0 $TARGET -E"
      ;;
    start)
      sudo_rsh '
        if [ -f /etc/monit/cron.disabled ]; then
          mv /etc/monit/cron.disabled /etc/cron.d/monit-agent; echo "cron re-enabled"
        elif systemctl list-unit-files monit-agent.service >/dev/null 2>&1; then
          systemctl enable --now monit-agent
          sleep 2; systemctl is-active --quiet monit-agent || { echo FAILED; exit 1; }
          echo started
        else echo "nothing installed to start"; exit 1; fi'
      ok "agent started on $TARGET"
      ;;
    remove)
      if [ "$ASSUME_YES" = 0 ] && [ -t 0 ]; then
        read -r -p "  Remove the agent completely from $TARGET? [y/N]: " yn </dev/tty || yn=""
        case "${yn:-n}" in [Yy]*) ;; *) echo "  cancelled"; exit 0 ;; esac
      fi
      sudo_rsh '
        systemctl disable --now monit-agent 2>/dev/null || true
        rm -f /etc/systemd/system/monit-agent.service /etc/cron.d/monit-agent /etc/monit/cron.disabled
        systemctl daemon-reload 2>/dev/null || true
        pkill -f "[/]opt/monit/monit-agent[.]sh" 2>/dev/null || true
        rm -rf /opt/monit /opt/monit-agent /etc/monit /var/lib/monit-agent
        userdel monit 2>/dev/null || true
        echo removed'
      rsh "rm -rf '$STAGE'" || true
      ok "agent removed from $TARGET"
      warn "the server still exists in the dashboard — delete it there to stop 'offline' alerts"
      ;;
  esac
  exit 0
fi

# --- where should the agent send data? ---------------------------------------
if [ -z "$API_URL" ]; then
  BASE=""
  # `|| true` on each: with `set -o pipefail` a grep that matches nothing fails
  # the whole pipeline, and `set -e` would kill the script on the assignment.
  [ -f .env ] && BASE=$(grep -E '^VITE_BASE=' .env | head -1 | cut -d= -f2- | sed 's#/$##' || true)
  PORT=$(grep -E '^APP_PORT=' .env 2>/dev/null | head -1 | cut -d= -f2- | awk -F: '{print $NF}' || true)
  MYIP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}')
  [ -z "$MYIP" ] && MYIP=$(hostname -I 2>/dev/null | awk '{print $1}')
  if [ -n "$BASE" ]; then
    API_URL="http://${MYIP}${BASE}"          # behind nginx on :80
  else
    API_URL="http://${MYIP}:${PORT:-8080}"   # straight to the app
  fi
  info "central URL for the target: $API_URL  (override with -U)"
fi

# --- server ID ---------------------------------------------------------------
[ -z "$SERVER_ID" ] && SERVER_ID=$(rsh 'hostname -s 2>/dev/null || hostname' | tr -d '\r')
[[ $SERVER_ID =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid server ID '$SERVER_ID' — pass a clean one with -i"

# --- optionally register it on the dashboard and grab the key ----------------
if [ "$AUTO_REG" = 1 ] && [ -z "$API_KEY" ]; then
  # APP_PORT may be "8080" or "127.0.0.1:8080" — take whatever follows the colon.
  APP_PORT_RAW=$(grep -E '^APP_PORT=' .env 2>/dev/null | head -1 | cut -d= -f2- || true)
  LOCAL_PORT=${APP_PORT_RAW##*:}
  [[ $LOCAL_PORT =~ ^[0-9]+$ ]] || LOCAL_PORT=8080
  LOCAL_URL="http://127.0.0.1:${LOCAL_PORT}"

  ADM=$ADMIN_EMAIL
  [ -z "$ADM" ] && { read -r -p "  dashboard admin email: " ADM </dev/tty; }
  ADMPW=${MONIT_ADMIN_PASSWORD:-}
  [ -z "$ADMPW" ] && { read -r -s -p "  password: " ADMPW </dev/tty; echo; }
  [ -n "$ADM" ] && [ -n "$ADMPW" ] || die "admin email and password are required for -a"
  TOK=$(curl -s -X POST "$LOCAL_URL/api/v1/auth/login" -H 'Content-Type: application/json' \
        -d "{\"email\":\"$ADM\",\"password\":\"$ADMPW\"}" \
        | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
  [ -n "$TOK" ] || die "could not sign in to $LOCAL_URL as '$ADM' — check the credentials, or that the app is on port $LOCAL_PORT"
  RESP=$(curl -s -X POST "$LOCAL_URL/api/v1/servers" -H "Authorization: Bearer $TOK" \
         -H 'Content-Type: application/json' \
         -d "{\"id\":\"$SERVER_ID\",\"name\":\"$SERVER_ID\"}")
  API_KEY=$(printf '%s' "$RESP" | sed -n 's/.*"api_key":"\([^"]*\)".*/\1/p')
  if [ -z "$API_KEY" ]; then
    warn "'$SERVER_ID' is already registered; rotating its key"
    API_KEY=$(curl -s -X POST "$LOCAL_URL/api/v1/servers/$SERVER_ID/keys/rotate" \
              -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{}' \
              | sed -n 's/.*"api_key":"\([^"]*\)".*/\1/p')
    [ -n "$API_KEY" ] || die "could not obtain a key for '$SERVER_ID'"
  fi
  ok "registered '$SERVER_ID' and obtained a key"
fi

# --- copy the agent into the account's own home ------------------------------
# /opt is root-owned, so staging there fails for an ordinary user. Everything
# lands somewhere always writable and is installed from there with sudo.
info "copying agent → $TARGET:$STAGE/"
rsh "mkdir -p '$STAGE'"
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
  agent/monit-agent.sh agent/monit-agent.service agent/install.sh \
  agent/monit-config.sh agent/agent.conf.example \
  "$TARGET:$STAGE/"
rsh "chmod +x '$STAGE'/*.sh"
ok "files staged in $STAGE"

# --- update-only: swap the script and restart --------------------------------
if [ "$UPDATE_ONLY" = 1 ]; then
  sudo_rsh "
    install -m 0755 $STAGE/monit-agent.sh /opt/monit/monit-agent.sh
    install -m 0755 $STAGE/monit-config.sh /opt/monit/monit-config.sh 2>/dev/null || true
    if systemctl list-unit-files monit-agent.service >/dev/null 2>&1; then
      systemctl restart monit-agent && systemctl is-active --quiet monit-agent \
        && echo restarted || { echo FAILED; exit 1; }
    else echo \"cron mode — next run uses the new agent\"; fi"
  ok "agent updated on $TARGET (config untouched)"
  exit 0
fi

# --- install -----------------------------------------------------------------
if [ -z "$API_KEY" ]; then
  echo
  echo "  Register '$SERVER_ID' in the dashboard (Projects → Register a server)"
  echo "  and paste the API key here. Or re-run with -a to do it automatically."
  read -r -p "  API key: " API_KEY </dev/tty
  [ -n "$API_KEY" ] || die "no API key given"
fi

info "installing on $TARGET …"
rsht "cd '$STAGE' && ${SUDO:+$SUDO }./install.sh '$API_URL' '$SERVER_ID' '$API_KEY' '$MODE'"

echo
ok "'$SERVER_ID' deployed"
cat <<EOF

  change settings later:  ssh $TARGET '${SUDO:+sudo }/opt/monit/monit-config.sh'
  update the agent only:  $0 $TARGET -u
  stop it:                $0 $TARGET -S
  logs:                   ssh $TARGET 'journalctl -u monit-agent -f'

EOF
