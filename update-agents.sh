#!/usr/bin/env bash
#
# update-agents.sh — push a new agent to every registered server, from here.
#
#   ./update-agents.sh --list          # build/refresh agents.txt from the dashboard
#   ./update-agents.sh --plan          # show what would happen, touch nothing
#   ./update-agents.sh                 # do it
#   ./update-agents.sh --only a,b,c    # just these server IDs
#
# The list comes from the dashboard, so it cannot drift from what you are
# monitoring. The ssh login cannot: the dashboard has never been told it, and
# guessing would mean 24 machines answered by one wrong assumption. So the first
# run writes agents.txt for you to fill in, once, and every run after that reads
# it back.
#
# Only files that differ are shipped. An agent whose monit-agent.sh already
# matches this checkout is left alone rather than restarted for nothing.
set -uo pipefail
cd "$(dirname "$0")"

LIST_FILE=${MONIT_AGENTS_FILE:-agents.txt}
PARALLEL=${MONIT_PARALLEL:-4}
ONLY=""; SKIP=""; PLAN=0; MAKE_LIST=0; FORCE=0; ASSUME_YES=0

info() { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '\033[31m✗\033[0m %s\n' "$*"; }
die()  { bad "$*"; exit 1; }

usage() { sed -n '3,17p' "$0"; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case $1 in
    --list) MAKE_LIST=1 ;;
    --plan|--dry-run) PLAN=1 ;;
    --force) FORCE=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    --only) ONLY=${2:-}; shift ;;
    --skip) SKIP=${2:-}; shift ;;
    -j) PARALLEL=${2:-4}; shift ;;
    -f) LIST_FILE=${2:-agents.txt}; shift ;;
    -h|--help) usage 0 ;;
    *) bad "unknown argument '$1'"; usage 2 ;;
  esac
  shift
done

command -v ssh >/dev/null 2>&1 || die "ssh is not installed on this host"
command -v curl >/dev/null 2>&1 || die "curl is not installed on this host"

# "missing" and "present but not executable" are different problems with
# different fixes, and reporting the second as the first sends people hunting
# for a file that is sitting right there. The execute bit is lost easily: a
# file copied through a tool that does not carry modes, then committed, is
# recorded in git as 0644 and arrives that way on every clone afterwards.
[ -e ./deploy-agent.sh ] || die "no ./deploy-agent.sh here — run this from the monit-server directory (you are in $(pwd))"
[ -r ./deploy-agent.sh ] || die "./deploy-agent.sh is not readable by $(id -un)"
DEPLOY=./deploy-agent.sh
if [ ! -x ./deploy-agent.sh ]; then
  DEPLOY="bash ./deploy-agent.sh"
  warn "./deploy-agent.sh is not executable ($(stat -c '%A' ./deploy-agent.sh)) — running it through bash"
  echo "     Fix it for good, so every clone gets it too:"
  echo "       chmod +x *.sh agent/*.sh"
  echo "       git update-index --chmod=+x *.sh agent/*.sh && git commit -m 'restore exec bits' && git push"
  echo
fi
[ -f agent/monit-agent.sh ] || die "agent/monit-agent.sh is missing — wrong directory? (you are in $(pwd))"

# --- where is the dashboard, and who are we? ---------------------------------
# Local first: this script runs on the central server, so the app is on
# localhost even when the public URL goes through nginx and TLS.
api_port() {
  # Initialised, not just declared: under `set -u` an unreadable .env left this
  # unset and the script died on the very next line.
  local raw=""
  [ -r .env ] && raw=$(grep -E '^APP_PORT=' .env | head -1 | cut -d= -f2- || true)
  raw=${raw##*:}
  [[ $raw =~ ^[0-9]+$ ]] && { printf '%s' "$raw"; return; }
  printf '8080'
}
API=${MONIT_API:-http://127.0.0.1:$(api_port)}

login() {
  local email=${MONIT_ADMIN_EMAIL:-} pass=${MONIT_ADMIN_PASSWORD:-}
  # Say whose login this is and why. A bare "dashboard email:" prompt does not
  # tell someone whether it wants their Linux account, a service account, or the
  # web login — and the wrong guess just fails with "could not sign in".
  if [ -z "$email" ] || [ -z "$pass" ]; then
    echo "  The server list comes from the dashboard, so this needs the account you"
    echo "  sign in to the web page with — at $API."
    echo "  Any role can read the list; it is not used for anything else."
    echo "  Set MONIT_ADMIN_EMAIL and MONIT_ADMIN_PASSWORD to skip this."
    echo
  fi
  [ -z "$email" ] && { read -r -p "  email: " email </dev/tty; }
  [ -z "$pass" ] && { read -r -s -p "  password: " pass </dev/tty; echo; }
  TOKEN=$(curl -s -X POST "$API/api/v1/auth/login" -H 'Content-Type: application/json' \
          -d "{\"email\":\"$email\",\"password\":\"$pass\"}" \
          | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
  [ -n "$TOKEN" ] || die "could not sign in to $API — check the credentials, or set MONIT_API"
}

# --- build the list ----------------------------------------------------------
make_list() {
  login
  local json
  json=$(curl -s "$API/api/v1/servers" -H "Authorization: Bearer $TOKEN")
  [ -n "$json" ] || die "no answer from $API/api/v1/servers"

  # Keep any ssh logins already filled in, so refreshing the list is not
  # destructive — the whole point of the file is the part you typed.
  local tmp; tmp=$(mktemp)
  MONIT_EXISTING=$LIST_FILE python3 - "$json" > "$tmp" <<'PY'
import json, os, sys, re
rows = json.loads(sys.argv[1]).get('servers', [])
known = {}
path = os.environ.get('MONIT_EXISTING', '')
if path and os.path.exists(path):
    for line in open(path):
        line = line.split('#', 1)[0].strip()
        if not line: continue
        parts = line.split()
        if len(parts) >= 2: known[parts[0]] = parts[1]
print("# server_id            ssh_target            # health / last seen")
print("#")
print("# Fill in ssh_target as user@host, e.g. adminmop@10.1.0.222")
print("# A line starting with # is skipped. Re-run --list to refresh; what you")
print("# typed here is kept.")
print()
w = max([len(r['id']) for r in rows] + [20])
for r in sorted(rows, key=lambda r: r['id']):
    if r.get('archived_at'): continue
    sid = r['id']
    tgt = known.get(sid) or (f"root@{r['ip']}" if r.get('ip') else "")
    note = f"{r.get('health','?')}"
    if r.get('last_seen'): note += f", last seen {r['last_seen'][:19].replace('T',' ')}Z"
    if tgt:
        print(f"{sid.ljust(w)}  {tgt.ljust(22)}# {note}")
    else:
        # No IP recorded and nothing typed yet: comment it out so a half-filled
        # file cannot silently skip a machine you meant to include.
        print(f"# {sid.ljust(w-2)}  <user>@<host>         # {note} — no IP in the dashboard")
PY
  mv "$tmp" "$LIST_FILE"
  local n blank
  n=$(grep -cve '^\s*#' -e '^\s*$' "$LIST_FILE" || true)
  blank=$(grep -c '<user>@<host>' "$LIST_FILE" || true)
  ok "wrote $LIST_FILE — $n ready, $blank need an ssh login"
  [ "$blank" -gt 0 ] && warn "edit the commented lines, then run: $0"
}

[ "$MAKE_LIST" = 1 ] && { make_list; exit 0; }
[ -f "$LIST_FILE" ] || { warn "$LIST_FILE does not exist yet — building it"; make_list; exit 0; }

# --- read the list -----------------------------------------------------------
declare -a IDS TARGETS
in_csv() { case ",$1," in *",$2,"*) return 0 ;; *) return 1 ;; esac; }

while read -r sid target _rest; do
  [ -z "${sid:-}" ] && continue
  case $sid in \#*) continue ;; esac
  [ -z "${target:-}" ] && { warn "$sid has no ssh login in $LIST_FILE — skipped"; continue; }
  case $target in '<user>@<host>') warn "$sid still says <user>@<host> — skipped"; continue ;; esac
  [ -n "$ONLY" ] && ! in_csv "$ONLY" "$sid" && continue
  [ -n "$SKIP" ] && in_csv "$SKIP" "$sid" && continue
  IDS+=("$sid"); TARGETS+=("$target")
done < <(sed 's/#.*$//' "$LIST_FILE")

[ "${#IDS[@]}" -gt 0 ] || die "nothing to do — no usable lines in $LIST_FILE"

LOCAL_SUM=$(sha256sum agent/monit-agent.sh | cut -d' ' -f1)
info "${#IDS[@]} host(s); local agent ${LOCAL_SUM:0:12}…; $PARALLEL at a time"
echo

RUNDIR=$(mktemp -d /tmp/monit-update.XXXXXX)
trap 'rm -rf "$RUNDIR"' EXIT

# --- one host ----------------------------------------------------------------
# Result goes to a file per host rather than stdout: several run at once and
# interleaved output would be unreadable.
do_host() {
  local sid=$1 target=$2 logf="$RUNDIR/$1.log" res="$RUNDIR/$1.res"
  local remote_sum
  remote_sum=$(ssh -o ConnectTimeout=10 -o BatchMode=yes "$target" \
      'sha256sum /opt/monit/monit-agent.sh 2>/dev/null | cut -d" " -f1' 2>>"$logf" | tr -d '\r')

  if [ -z "$remote_sum" ]; then
    # Either ssh failed, or the agent is not installed there. Tell them apart —
    # one is a credentials problem, the other means this host was never onboarded.
    if ssh -o ConnectTimeout=10 -o BatchMode=yes "$target" true 2>>"$logf"; then
      echo "MISSING no agent installed at /opt/monit — use deploy-agent.sh to install it" > "$res"
    else
      echo "UNREACHABLE ssh to $target failed (see log; BatchMode means keys only)" > "$res"
    fi
    return
  fi

  if [ "$remote_sum" = "$LOCAL_SUM" ] && [ "$FORCE" = 0 ]; then
    echo "SAME already on this version" > "$res"
    return
  fi

  if [ "$PLAN" = 1 ]; then
    echo "WOULD ${remote_sum:0:12}… -> ${LOCAL_SUM:0:12}…" > "$res"
    return
  fi

  if $DEPLOY "$target" -u >>"$logf" 2>&1; then
    # -u swaps the files and restarts; confirm the service actually came back
    # rather than trusting the exit code.
    # cron mode is a legitimate install, so "no systemd unit" is not a failure —
    # look for the cron job before calling it broken.
    local active
    active=$(ssh -o ConnectTimeout=10 -o BatchMode=yes "$target" '
        if command -v systemctl >/dev/null 2>&1 \
           && systemctl list-unit-files monit-agent.service >/dev/null 2>&1; then
          systemctl is-active monit-agent 2>/dev/null || echo inactive
        elif [ -f /etc/cron.d/monit-agent ]; then echo cron
        else echo unknown; fi' 2>>"$logf" | tr -d '\r')
    if [ "$active" = active ] || [ "$active" = cron ]; then
      echo "UPDATED ${remote_sum:0:12}… -> ${LOCAL_SUM:0:12}…" > "$res"
    else
      echo "FAILED files updated but the service is '$active'" > "$res"
    fi
  else
    echo "FAILED $(tail -3 "$logf" | tr '\n' ' ' | sed 's/\x1b\[[0-9;]*m//g' | cut -c1-120)" > "$res"
  fi
}

# --- run, bounded -------------------------------------------------------------
# BatchMode=yes throughout: a password prompt from one of 24 parallel jobs would
# hang the run with no indication of which host is waiting. Keys or nothing.
running=0
for i in "${!IDS[@]}"; do
  do_host "${IDS[$i]}" "${TARGETS[$i]}" &
  running=$((running + 1))
  if [ "$running" -ge "$PARALLEL" ]; then wait -n 2>/dev/null || wait; running=$((running - 1)); fi
done
wait

# --- report -------------------------------------------------------------------
declare -i n_up=0 n_same=0 n_fail=0 n_miss=0 n_unreach=0 n_would=0
printf '%-24s %-11s %s\n' "SERVER" "RESULT" "DETAIL"
printf '%s\n' "----------------------------------------------------------------------------"
for sid in "${IDS[@]}"; do
  read -r status detail < <(cat "$RUNDIR/$sid.res" 2>/dev/null || echo "FAILED no result")
  case $status in
    UPDATED)     n_up+=1;      printf '\033[32m%-24s %-11s\033[0m %s\n' "$sid" "updated" "$detail" ;;
    SAME)        n_same+=1;    printf '%-24s %-11s %s\n' "$sid" "unchanged" "$detail" ;;
    WOULD)       n_would+=1;   printf '\033[36m%-24s %-11s\033[0m %s\n' "$sid" "would update" "$detail" ;;
    MISSING)     n_miss+=1;    printf '\033[33m%-24s %-11s\033[0m %s\n' "$sid" "no agent" "$detail" ;;
    UNREACHABLE) n_unreach+=1; printf '\033[33m%-24s %-11s\033[0m %s\n' "$sid" "unreachable" "$detail" ;;
    *)           n_fail+=1;    printf '\033[31m%-24s %-11s\033[0m %s\n' "$sid" "FAILED" "$detail" ;;
  esac
done
echo
if [ "$PLAN" = 1 ]; then
  info "plan only — nothing was changed. $n_would to update, $n_same already current."
else
  ok "$n_up updated, $n_same unchanged"
fi
[ "$n_miss" -gt 0 ]    && warn "$n_miss host(s) have no agent installed — onboard them from the dashboard"
[ "$n_unreach" -gt 0 ] && warn "$n_unreach host(s) unreachable over ssh — check the login in $LIST_FILE"
if [ "$n_fail" -gt 0 ]; then
  bad "$n_fail failed. Full output per host:"
  for sid in "${IDS[@]}"; do
    grep -q '^FAILED' "$RUNDIR/$sid.res" 2>/dev/null && echo "    $sid: $RUNDIR/$sid.log"
  done
  # Keep the logs when something went wrong — they are the only record.
  trap - EXIT
  echo "    (logs kept in $RUNDIR)"
  exit 1
fi
