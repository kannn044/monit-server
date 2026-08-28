#!/usr/bin/env bash
#
# monit-config.sh — change the agent's settings after installation.
# Installed to /opt/monit/monit-config.sh. Run as root.
#
#   sudo /opt/monit/monit-config.sh              # show settings, then edit interactively
#   sudo /opt/monit/monit-config.sh -s           # show only
#   sudo /opt/monit/monit-config.sh -i 30        # sample every 30 s
#   sudo /opt/monit/monit-config.sh -H "http://127.0.0.1:8084/health"
#   sudo /opt/monit/monit-config.sh -k sk_agent_new…   # after rotating the key
#   sudo /opt/monit/monit-config.sh --pm2        # let the agent read another user's PM2
#
#   -i SECONDS   sample interval          -n "IF1 IF2"  network interfaces
#   -H URLS      HTTP checks (comma sep)  -u URL        central server URL
#   -k KEY       API key                  -g auto|1|0   GPU collection
#   -b N         buffer file cap          -s            show and exit
#   -d auto|1|0  NDB cluster checks       -D HOST:PORT  ndb_mgmd connectstring
#   -y           no confirmation prompt    --pm2         grant PM2 read access
#
# Every change is written to /etc/monit/agent.conf, verified with a real sample,
# and the service restarted — so a bad value is caught here, not hours later.
set -euo pipefail

CONF=/etc/monit/agent.conf
AGENT=/opt/monit/monit-agent.sh
SHOW_ONLY=0; ASSUME_YES=0
declare -A SET=()

info() { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# getopts does not do long options; pull --pm2 out first.
PM2_FIX=0
_args=()
for _a in "$@"; do
  case $_a in --pm2) PM2_FIX=1 ;; *) _args+=("$_a") ;; esac
done
set -- ${_args[@]+"${_args[@]}"}

while getopts "i:H:n:u:k:g:b:d:D:syh" opt; do
  case $opt in
    i) SET[MONIT_INTERVAL]=$OPTARG ;;   H) SET[MONIT_HTTP_CHECKS]=$OPTARG ;;
    n) SET[MONIT_NET_IFACES]=$OPTARG ;; u) SET[MONIT_API_URL]=${OPTARG%/} ;;
    k) SET[MONIT_API_KEY]=$OPTARG ;;    g) SET[MONIT_GPU]=$OPTARG ;;
    b) SET[MONIT_BUFFER_MAX]=$OPTARG ;; s) SHOW_ONLY=1 ;;
    d) SET[MONIT_NDB]=$OPTARG ;;        D) SET[MONIT_NDB_CONNECTSTRING]=$OPTARG ;;
    y) ASSUME_YES=1 ;;
    h) sed -n '3,20p' "$0"; exit 0 ;;
    *) echo "run '$0 -h' for usage" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" = 0 ] || die "run as root (sudo $0 …)"
[ -f "$CONF" ] || die "$CONF not found — run install.sh first"

get() { grep -E "^$1=" "$CONF" | head -1 | cut -d= -f2- | sed 's/^"//; s/"$//'; }

# --- PM2 access ---------------------------------------------------------------
# PM2 keeps its state in a per-user daemon and refuses to serve a socket it does
# not own, so the 'monit' user reaches an empty daemon of its own and the
# dashboard shows "0 online". Grant a narrow NOPASSWD rule for one helper that
# can only run `pm2 jlist`.
grant_pm2() {
  local daemons owner home foreign=0 bin owner_home
  daemons=$(ps -eo user:32,args 2>/dev/null | awk '
    /God Daemon/ && !/awk/ {
      if (match($0, /\(([^)]*\.pm2[^)]*)\)/))
        printf "%s\t%s\n", $1, substr($0, RSTART + 1, RLENGTH - 2)
    }' | sort -u)
  [ -n "$daemons" ] || die "no PM2 daemon is running on this host.
   start your apps first (pm2 list), then re-run: sudo $0 --pm2"

  while IFS=$'\t' read -r owner home; do
    [ -z "$owner" ] && continue
    ok "found PM2 daemon: $owner ($home)"
    [ "$owner" = monit ] && continue
    foreign=1
    if [ -z "${bin:-}" ]; then
      owner_home=$(getent passwd "$owner" | cut -d: -f6)
      for c in /usr/local/bin/pm2 /usr/bin/pm2 \
               "$owner_home"/.nvm/versions/node/*/bin/pm2 \
               "$owner_home"/.npm-global/bin/pm2 "$owner_home"/.yarn/bin/pm2; do
        [ -x "$c" ] && { bin=$c; break; }
      done
      [ -z "${bin:-}" ] && bin=$(command -v pm2 2>/dev/null || true)
    fi
  done <<< "$daemons"

  if [ "$foreign" = 0 ]; then
    ok "PM2 already belongs to 'monit' — no extra access needed"
    return 0
  fi

  [ -x /opt/monit/monit-pm2.sh ] || die "/opt/monit/monit-pm2.sh is missing.
   update the agent first:  ./deploy-agent.sh <target> -u     (from the central server)"
  chown root:root /opt/monit/monit-pm2.sh; chmod 0755 /opt/monit/monit-pm2.sh

  if [ -n "${bin:-}" ]; then
    printf '# written by monit-config.sh — root-owned on purpose\nMONIT_PM2_BIN=%s\n' "$bin" \
      > /etc/monit/pm2.conf
    chown root:root /etc/monit/pm2.conf; chmod 0644 /etc/monit/pm2.conf
    ok "pinned pm2 binary: $bin"
  fi

  command -v sudo >/dev/null 2>&1 || die "sudo is not installed — cannot grant PM2 access"
  cat > /etc/sudoers.d/monit-agent <<'SUDO'
# Lets the monit agent read PM2 state owned by another user.
# The helper is root-owned 0755 and can only run `pm2 jlist`.
monit ALL=(root) NOPASSWD: /opt/monit/monit-pm2.sh
SUDO
  chmod 0440 /etc/sudoers.d/monit-agent
  if command -v visudo >/dev/null 2>&1 && ! visudo -cf /etc/sudoers.d/monit-agent >/dev/null 2>&1; then
    rm -f /etc/sudoers.d/monit-agent
    die "the sudoers rule did not validate and was removed"
  fi
  ok "granted 'monit' read-only access to PM2"

  # sudo is setuid; NoNewPrivileges=true forbids that, so the helper would
  # silently return nothing. Everything else in the unit stays hardened.
  local unit=/etc/systemd/system/monit-agent.service
  if [ -f "$unit" ] && grep -q '^NoNewPrivileges=true' "$unit"; then
    sed -i 's/^NoNewPrivileges=true$/# disabled: the PM2 helper runs through sudo\nNoNewPrivileges=false/' "$unit"
    systemctl daemon-reload 2>/dev/null || true
    warn "NoNewPrivileges disabled in monit-agent.service so sudo can run"
  fi

  if systemctl list-unit-files monit-agent.service >/dev/null 2>&1; then
    systemctl restart monit-agent || true
  fi

  info "checking what the agent can now see…"
  local seen
  seen=$(runuser -u monit -- bash "$AGENT" --print 2>/dev/null \
         | tr ',' '\n' | grep -m1 '"online"' || true)
  if printf '%s' "$seen" | grep -q 'null'; then
    warn "PM2 is still unreadable — check: sudo -u monit sudo -n /opt/monit/monit-pm2.sh <owner> <pm2_home>"
  else
    ok "PM2 is readable now (${seen:-no output})"
  fi
  exit 0
}

[ "$PM2_FIX" = 1 ] && grant_pm2


show() {
  echo
  echo "  ── current settings ($CONF) ──────────────────────────────────"
  printf '    %-16s %s\n' \
    "server ID:"   "$(get MONIT_SERVER_ID)" \
    "central URL:" "$(get MONIT_API_URL)" \
    "API key:"     "$(get MONIT_API_KEY | cut -c1-16)…" \
    "interval:"    "$(get MONIT_INTERVAL)s" \
    "interfaces:"  "$(get MONIT_NET_IFACES)" \
    "HTTP checks:" "$(get MONIT_HTTP_CHECKS || echo none)" \
    "GPU:"         "$(get MONIT_GPU)" \
    "buffer cap:"  "$(get MONIT_BUFFER_MAX) files" \
    "NDB cluster:" "$(get MONIT_NDB || echo auto)"
  if systemctl list-unit-files monit-agent.service >/dev/null 2>&1; then
    printf '    %-16s %s\n' "service:" "$(systemctl is-active monit-agent 2>/dev/null || echo inactive)"
  elif [ -f /etc/cron.d/monit-agent ]; then
    printf '    %-16s %s\n' "service:" "cron (once a minute)"
  fi
  echo
}

show
[ "$SHOW_ONLY" = 1 ] && exit 0

# --- interactive when no flags were given ------------------------------------
ask() {
  local prompt=$1 default=$2 __var=$3 reply
  read -r -p "  $prompt [$default]: " reply </dev/tty || reply=""
  printf -v "$__var" '%s' "${reply:-$default}"
}

if [ ${#SET[@]} -eq 0 ]; then
  [ -t 0 ] || { warn "nothing to change"; exit 0; }
  echo "  Press Enter to keep a value unchanged."
  echo
  ask "Sample interval (seconds)" "$(get MONIT_INTERVAL)" v; SET[MONIT_INTERVAL]=$v
  ask "Network interface(s)"      "$(get MONIT_NET_IFACES)" v; SET[MONIT_NET_IFACES]=$v
  ask "HTTP checks (comma sep)"   "$(get MONIT_HTTP_CHECKS)" v; SET[MONIT_HTTP_CHECKS]=$v
  ask "Central server URL"        "$(get MONIT_API_URL)" v; SET[MONIT_API_URL]=${v%/}
  ask "API key (blank = keep)"    "$(get MONIT_API_KEY)" v; SET[MONIT_API_KEY]=$v
  echo
fi

# --- validate ----------------------------------------------------------------
if [ -n "${SET[MONIT_INTERVAL]:-}" ]; then
  [[ ${SET[MONIT_INTERVAL]} =~ ^[0-9]+$ ]] && [ "${SET[MONIT_INTERVAL]}" -ge 5 ] \
    || die "interval must be a whole number of at least 5 seconds"
  # The dashboard marks a server offline after 3 × SAMPLE_INTERVAL_S (10 s by
  # default), so a slower agent looks permanently down until the central server
  # is told about it too.
  # In cron mode the loop never runs, so the interval is inert.
  if [ -f /etc/cron.d/monit-agent ] && ! systemctl is-active --quiet monit-agent 2>/dev/null; then
    warn "this host runs in cron mode — samples are sent once a minute and MONIT_INTERVAL is ignored."
    warn "  To sample faster, reinstall in loop mode:  sudo ./install.sh <URL> <ID> <KEY> loop"
  fi
  if [ "${SET[MONIT_INTERVAL]}" -gt 10 ]; then
    warn "interval ${SET[MONIT_INTERVAL]}s is slower than the dashboard's default expectation (10 s)."
    warn "  On the central server set SAMPLE_INTERVAL_S=${SET[MONIT_INTERVAL]} in .env and restart,"
    warn "  otherwise this host will be reported offline between samples."
  fi
fi
[ -n "${SET[MONIT_GPU]:-}" ] && case "${SET[MONIT_GPU]}" in auto|1|0) ;; *) die "GPU must be auto, 1 or 0" ;; esac
[ -n "${SET[MONIT_BUFFER_MAX]:-}" ] && { [[ ${SET[MONIT_BUFFER_MAX]} =~ ^[0-9]+$ ]] || die "buffer cap must be a number"; }

# --- confirm -----------------------------------------------------------------
CHANGED=0
for k in "${!SET[@]}"; do
  cur=$(get "$k")
  [ "${SET[$k]}" = "$cur" ] && continue
  CHANGED=1
  if [ "$k" = MONIT_API_KEY ]; then
    printf '    %s: %s… → %s…\n' "$k" "$(printf '%s' "$cur" | cut -c1-12)" "$(printf '%s' "${SET[$k]}" | cut -c1-12)"
  else
    printf '    %s: %s → %s\n' "$k" "${cur:-<empty>}" "${SET[$k]:-<empty>}"
  fi
done
[ "$CHANGED" = 0 ] && { ok "nothing changed"; exit 0; }

if [ "$ASSUME_YES" = 0 ] && [ -t 0 ]; then
  echo
  read -r -p "  Apply? [Y/n]: " yn </dev/tty || yn=""
  case "${yn:-y}" in [Yy]*) ;; *) echo "  cancelled"; exit 0 ;; esac
fi

# --- write (keeping a backup) ------------------------------------------------
BACKUP="$CONF.$(date +%Y%m%d%H%M%S).bak"
cp -p "$CONF" "$BACKUP"

fmt_line() {  # quote the values that may contain spaces
  case $1 in
    MONIT_NET_IFACES|MONIT_HTTP_CHECKS) printf '%s="%s"' "$1" "$2" ;;
    *) printf '%s=%s' "$1" "$2" ;;
  esac
}

# Rewrite in pure bash — no sed/awk/python substitution, so nothing in a value
# (slashes, ampersands, quotes) can corrupt the file. Comments and unrelated
# keys keep their place and order.
tmp=$(mktemp)
declare -A written=()
while IFS= read -r line || [ -n "$line" ]; do
  key=${line%%=*}
  if [[ $line == *=* ]] && [ -n "${SET[$key]+x}" ]; then
    fmt_line "$key" "${SET[$key]}" >> "$tmp"; printf '\n' >> "$tmp"
    written[$key]=1
  else
    printf '%s\n' "$line" >> "$tmp"
  fi
done < "$CONF"
for k in "${!SET[@]}"; do
  [ -n "${written[$k]:-}" ] || { fmt_line "$k" "${SET[$k]}" >> "$tmp"; printf '\n' >> "$tmp"; }
done
cat "$tmp" > "$CONF"
rm -f "$tmp"
chown root:monit "$CONF"; chmod 0640 "$CONF"
ok "updated $CONF  (backup: $BACKUP)"

# --- verify with a real sample -----------------------------------------------
URL=$(get MONIT_API_URL); KEY=$(get MONIT_API_KEY)
info "sending a test sample…"
PAYLOAD=$(runuser -u monit -- bash "$AGENT" --print 2>/dev/null \
          || sudo -u monit bash "$AGENT" --print 2>/dev/null) \
  || { cp -p "$BACKUP" "$CONF"; die "the agent could not build a payload — config rolled back"; }

CODE=$(printf '%s' "$PAYLOAD" | curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
        -X POST "$URL/api/v1/ingest" -H "Authorization: Bearer $KEY" \
        -H 'Content-Type: application/json' --data-binary @-)

if [ "$CODE" != "202" ]; then
  cp -p "$BACKUP" "$CONF"; chown root:monit "$CONF"; chmod 0640 "$CONF"
  die "the central server answered HTTP $CODE — config rolled back to the previous values.
   401 = wrong key · 403 = server ID does not match the key · 000 = URL unreachable"
fi
ok "sample accepted (HTTP 202)"

# --- restart ------------------------------------------------------------------
if systemctl list-unit-files monit-agent.service >/dev/null 2>&1; then
  systemctl restart monit-agent
  sleep 2
  systemctl is-active --quiet monit-agent \
    && ok "monit-agent restarted" \
    || die "the service did not come back — systemctl status monit-agent"
else
  ok "cron mode — the next run picks the new settings up automatically"
fi
show
