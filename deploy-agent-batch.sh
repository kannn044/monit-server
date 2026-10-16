#!/usr/bin/env bash
# Deploy the monit agent to a TSV inventory using one SSH password prompt.
# Credentials are read interactively and never written to the inventory/logs.
set -o pipefail

cd "$(dirname "$0")"

INVENTORY="$(dirname "$0")/deploy-agent-batch.tsv"
API_URL=""
ADMIN_EMAIL="${MONIT_ADMIN_EMAIL:-}"
JOBS=5
DRY_RUN=0
RETRY_FROM=""

usage() {
  cat <<'EOF'
Usage: ./deploy-agent-batch.sh -U <agent-url> [-e <dashboard-admin-email>] [-f <inventory.tsv>] [-j <parallelism>]

Example:
  ./deploy-agent-batch.sh -U http://10.1.1.171:8080 -e admin@example.com
  ./deploy-agent-batch.sh --dry-run
  ./deploy-agent-batch.sh -U http://10.1.1.171:8080 -e admin@example.com --retry-failed-from /tmp/monit-agent-batch.ABC123

Inventory format: server_id<TAB>ip. Dashboard-existing IDs are skipped safely.
Use --retry-failed-from with a prior log directory to retry only its failures.
SSH and dashboard passwords are prompted once; neither is stored in a file.
EOF
}

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
contains() { local needle=$1 item; shift; for item in "$@"; do [[ "$item" == "$needle" ]] && return 0; done; return 1; }
while (($#)); do
  case "$1" in
    -f) (($# >= 2)) || die "-f needs an inventory path"; INVENTORY=$2; shift 2 ;;
    -U) (($# >= 2)) || die "-U needs the URL agents can reach"; API_URL=${2%/}; shift 2 ;;
    -e) (($# >= 2)) || die "-e needs an admin email"; ADMIN_EMAIL=$2; shift 2 ;;
    -j) (($# >= 2)) || die "-j needs a positive number"; JOBS=$2; shift 2 ;;
    --retry-failed-from) (($# >= 2)) || die "--retry-failed-from needs a log directory"; RETRY_FROM=$2; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (use --help)" ;;
  esac
done

[[ -f "$INVENTORY" ]] || die "inventory not found: $INVENTORY"
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || die "parallelism must be a positive integer"
[[ -z "$RETRY_FROM" || -d "$RETRY_FROM" ]] || die "retry log directory not found: $RETRY_FROM"
[[ "$DRY_RUN" = 1 || -n "$API_URL" ]] || die "provide -U with the agent-facing URL"

declare -a IDS=() IPS=() SEEN_IDS=() SEEN_IPS=()
while IFS=$'\t ' read -r id ip _ || [[ -n "${id:-}${ip:-}" ]]; do
  [[ -z "${id:-}" || "$id" == \#* ]] && continue
  [[ -n "${ip:-}" ]] || die "inventory row has no IP: $id"
  [[ "$id" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid server ID in inventory: $id"
  [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "invalid IPv4 address in inventory: $ip"
  IFS=. read -r a b c d <<< "$ip"
  for octet in "$a" "$b" "$c" "$d"; do ((10#$octet <= 255)) || die "invalid IPv4 address in inventory: $ip"; done
  contains "$id" "${SEEN_IDS[@]}" && die "duplicate server ID in inventory: $id"
  contains "$ip" "${SEEN_IPS[@]}" && die "duplicate IP in inventory: $ip"
  SEEN_IDS+=("$id"); SEEN_IPS+=("$ip")
  IDS+=("$id"); IPS+=("$ip")
done < "$INVENTORY"

((${#IDS[@]} > 0)) || die "inventory has no servers"
printf 'Inventory: %s hosts\n' "${#IDS[@]}"
for i in "${!IDS[@]}"; do printf '  %-22s %s\n' "${IDS[$i]}" "${IPS[$i]}"; done
if [[ "$DRY_RUN" = 1 ]]; then exit 0; fi

for cmd in ssh rsync curl python3; do command -v "$cmd" >/dev/null 2>&1 || die "$cmd is required on this server"; done
command -v sshpass >/dev/null 2>&1 || die "sshpass is required for password-based SSH (install it once on this server)"
[[ -x ./deploy-agent.sh ]] || die "./deploy-agent.sh is missing or not executable"

# Match deploy-agent.sh's own local API port selection without sourcing .env.
APP_PORT_RAW=""
[[ -r .env ]] && APP_PORT_RAW=$(grep -E '^APP_PORT=' .env | head -1 | cut -d= -f2- || true)
LOCAL_PORT=${APP_PORT_RAW##*:}
[[ "$LOCAL_PORT" =~ ^[0-9]+$ ]] || LOCAL_PORT=8080
LOCAL_URL="http://127.0.0.1:${LOCAL_PORT}"
[[ -n "$ADMIN_EMAIL" ]] || { read -r -p 'Dashboard admin email: ' ADMIN_EMAIL </dev/tty; }
[[ -n "$ADMIN_EMAIL" ]] || die "dashboard admin email is required"
if [[ -z "${MONIT_ADMIN_PASSWORD:-}" ]]; then
  read -r -s -p 'Dashboard admin password: ' MONIT_ADMIN_PASSWORD </dev/tty; echo
fi
[[ -n "${MONIT_ADMIN_PASSWORD:-}" ]] || die "dashboard admin password is required"
export MONIT_ADMIN_PASSWORD

# Authenticate once and get every active and archived ID. Existing IDs are
# skipped, so a batch never silently revokes a key belonging to a live agent.
EXISTING_IDS=$(MONIT_ADMIN_EMAIL="$ADMIN_EMAIL" MONIT_LOCAL_URL="$LOCAL_URL" python3 - <<'PY'
import json, os, sys, urllib.error, urllib.request

base = os.environ['MONIT_LOCAL_URL']
email = os.environ['MONIT_ADMIN_EMAIL']
password = os.environ['MONIT_ADMIN_PASSWORD']

def request(path, method='GET', payload=None, token=None):
    data = None if payload is None else json.dumps(payload).encode()
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=12) as response:
        return json.load(response)

try:
    login = request('/api/v1/auth/login', 'POST', {'email': email, 'password': password})
    token = login['access_token']
    result = request('/api/v1/servers?archived=all', token=token)
    for server in result.get('servers', []):
        print(server['id'])
except Exception as exc:
    print(f'Could not check existing server IDs at {base}: {exc}', file=sys.stderr)
    sys.exit(1)
PY
) || die "could not check existing IDs; no hosts were changed"
declare -a EXISTING=()
while IFS= read -r id; do [[ -n "$id" ]] && EXISTING+=("$id"); done <<< "$EXISTING_IDS"

declare -a PENDING_IDS=() PENDING_IPS=() PENDING_RETRY=()
local_skipped=0
retry_count=0
for i in "${!IDS[@]}"; do
  id=${IDS[$i]}; ip=${IPS[$i]}
  previous_rc=""
  if [[ -n "$RETRY_FROM" && -f "$RETRY_FROM/$id.exit" ]]; then
    previous_rc=$(cat "$RETRY_FROM/$id.exit")
  fi
  if [[ -n "$RETRY_FROM" && "$previous_rc" =~ ^[1-9][0-9]*$ ]]; then
    printf 'RETRY %-21s %s (failed in previous run; key may be reissued)\n' "$id" "$ip"
    PENDING_IDS+=("$id"); PENDING_IPS+=("$ip"); PENDING_RETRY+=(1)
    ((retry_count += 1))
  elif contains "$id" "${EXISTING[@]}"; then
    printf 'SKIP %-22s %s (ID already exists; key not rotated)\n' "$id" "$ip"
    ((local_skipped += 1))
  else
    PENDING_IDS+=("$id"); PENDING_IPS+=("$ip"); PENDING_RETRY+=(0)
  fi
done
((${#PENDING_IDS[@]} > 0)) || { printf 'Nothing to deploy (%s existing IDs skipped).\n' "$local_skipped"; exit 0; }

if [[ -z "${SSHPASS:-}" ]]; then
  read -r -s -p 'Root SSH password (same for all targets): ' SSHPASS </dev/tty; echo
fi
[[ -n "${SSHPASS:-}" ]] || die "root SSH password is required"
export SSHPASS
export MONIT_SSH_ACCEPT_NEW=1

LOG_DIR=$(mktemp -d /tmp/monit-agent-batch.XXXXXX)
chmod 700 "$LOG_DIR"
trap 'unset SSHPASS MONIT_ADMIN_PASSWORD' EXIT
printf '\nDeploying %s new hosts; parallel jobs: %s\nLogs: %s\n\n' "${#PENDING_IDS[@]}" "$JOBS" "$LOG_DIR"

ok_count=0
fail_count=0
for ((start=0; start<${#PENDING_IDS[@]}; start+=JOBS)); do
  pids=(); batch_ids=(); batch_ips=(); batch_logs=(); batch_codes=()
  end=$((start + JOBS))
  ((end > ${#PENDING_IDS[@]})) && end=${#PENDING_IDS[@]}
  for ((i=start; i<end; i++)); do
    id=${PENDING_IDS[$i]}; ip=${PENDING_IPS[$i]}; log="$LOG_DIR/$id.log"; codefile="$LOG_DIR/$id.exit"
    (
      rc=0
      if [[ "${PENDING_RETRY[$i]}" == 1 ]]; then
        MONIT_SSH_ACCEPT_NEW=1 ./deploy-agent.sh "root@$ip" -i "$id" -a -e "$ADMIN_EMAIL" -U "$API_URL" -y >"$log" 2>&1 || rc=$?
      else
        MONIT_SSH_ACCEPT_NEW=1 ./deploy-agent.sh "root@$ip" -i "$id" -a -N -e "$ADMIN_EMAIL" -U "$API_URL" -y >"$log" 2>&1 || rc=$?
      fi
      printf '%s\n' "$rc" > "$codefile"
    ) &
    pids+=("$!"); batch_ids+=("$id"); batch_ips+=("$ip"); batch_logs+=("$log"); batch_codes+=("$codefile")
  done
  for j in "${!pids[@]}"; do
    wait "${pids[$j]}" || true
    rc=$(cat "${batch_codes[$j]}" 2>/dev/null || echo 1)
    if [[ "$rc" == 0 ]]; then
      printf 'OK   %-22s %s\n' "${batch_ids[$j]}" "${batch_ips[$j]}"
      ((ok_count += 1))
    else
      printf 'FAIL %-22s %s (see %s)\n' "${batch_ids[$j]}" "${batch_ips[$j]}" "${batch_logs[$j]}"
      tail -n 12 "${batch_logs[$j]}" >&2
      ((fail_count += 1))
    fi
  done
done

unset SSHPASS MONIT_ADMIN_PASSWORD
printf '\nComplete: %s succeeded, %s failed, %s existing IDs skipped.\nLogs: %s\n' \
  "$ok_count" "$fail_count" "$local_skipped" "$LOG_DIR"
((fail_count == 0))
