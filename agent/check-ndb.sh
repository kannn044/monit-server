#!/usr/bin/env bash
#
# check-ndb.sh — verify the agent can read your NDB cluster, on the real thing.
#
# The NDB collector was written against MySQL's documented ndbinfo tables and
# `ndb_mgm -e show` output, and tested against a real MySQL server and captured
# management-client output — but not against a live NDB cluster. Run this once
# on the host you are monitoring to confirm it reads yours correctly.
#
#   sudo /opt/monit/check-ndb.sh          # as root, using /root/.my.cnf
#   sudo -u monit /opt/monit/check-ndb.sh # exactly as the agent sees it
#
set -u
OK=$'\033[32m✓\033[0m'; BAD=$'\033[31m✗\033[0m'; WARN=$'\033[33m!\033[0m'; INF=$'\033[36m▸\033[0m'
FAIL=0
say()  { printf '%s %s\n' "$1" "${*:2}"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }

[ -f /etc/monit/agent.conf ] && . /etc/monit/agent.conf 2>/dev/null
: "${MONIT_NDB:=auto}"
: "${MONIT_NDB_CONNECTSTRING:=}"

printf '\033[1mNDB cluster readability check\033[0m  (running as %s)\n' "$(id -un)"
[ "$MONIT_NDB" = "0" ] && { say "$WARN" "MONIT_NDB=0 — NDB checks are switched off in /etc/monit/agent.conf"; exit 0; }

head_ "1. Can this host see ndbinfo over SQL?"
if ! command -v mysql >/dev/null 2>&1; then
  say "$WARN" "no mysql client on this host — the SQL path is unavailable"
else
  probe=$(mysql -N -B -e "SELECT 1 FROM ndbinfo.nodes LIMIT 1;" 2>&1)
  if [ "$probe" = "1" ]; then
    say "$OK" "ndbinfo is readable"
    printf '\n   ndbinfo.nodes (data nodes currently running):\n'
    mysql -B -e "SELECT node_id, status, start_phase, uptime FROM ndbinfo.nodes ORDER BY node_id;" 2>&1 | sed 's/^/     /'
    if mysql -N -B -e "SELECT 1 FROM ndbinfo.config_nodes LIMIT 1;" >/dev/null 2>&1; then
      say "$OK" "ndbinfo.config_nodes present — a node that is DOWN can be detected"
      printf '   configured roster:\n'
      mysql -B -e "SELECT node_id, node_type, node_hostname FROM ndbinfo.config_nodes ORDER BY node_id;" 2>&1 | sed 's/^/     /'
    else
      say "$WARN" "no ndbinfo.config_nodes (needs NDB 8.0.22+)"
      echo "     Without it, ndbinfo alone cannot tell a node that is DOWN from one that"
      echo "     was never configured — a dead node simply has no row. The agent falls"
      echo "     back to ndb_mgm for the roster; make sure section 2 below passes."
    fi
  else
    say "$WARN" "cannot read ndbinfo as $(id -un)"
    printf '     %s\n' "$(printf '%s' "$probe" | head -2)"
    echo "     This host may not be an SQL node, or the user has no credentials."
    echo "     The agent reads MySQL with no explicit user, so it needs a my.cnf that"
    echo "     works for the 'monit' user, e.g. /etc/monit/my.cnf referenced from"
    echo "     ~monit/.my.cnf, granting only:  GRANT SELECT ON ndbinfo.* TO 'monit'@'localhost';"
  fi
fi

head_ "2. Can this host reach the management node?"
if ! command -v ndb_mgm >/dev/null 2>&1; then
  say "$WARN" "ndb_mgm is not installed here"
  echo "     Install the management client on at least the SQL nodes you monitor, or"
  echo "     rely on ndbinfo.config_nodes (section 1)."
else
  args=()
  [ -n "$MONIT_NDB_CONNECTSTRING" ] && args=(-c "$MONIT_NDB_CONNECTSTRING")
  out=$(timeout 10 ndb_mgm "${args[@]+"${args[@]}"}" --try-reconnect=1 -e show 2>&1)
  if printf '%s' "$out" | grep -q '\[ndbd(NDB)\]'; then
    say "$OK" "ndb_mgm answered"
    printf '%s\n' "$out" | sed 's/^/     /'
  else
    say "$BAD" "ndb_mgm could not reach a management server"; FAIL=1
    printf '     %s\n' "$(printf '%s' "$out" | head -3)"
    echo "     Set the management node explicitly:"
    echo "       sudo /opt/monit/monit-config.sh -D 10.1.1.20:1186"
  fi
fi

head_ "3. What the agent would actually report"
if [ -x /opt/monit/monit-agent.sh ]; then
  payload=$(bash /opt/monit/monit-agent.sh --print 2>/dev/null)
  block=$(printf '%s' "$payload" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("could not parse the agent payload"); raise SystemExit(1)
ndb = (d.get("databases") or {}).get("ndb")
print(json.dumps(ndb, indent=2) if ndb else "NONE")' 2>/dev/null)
  if [ -z "$block" ] || [ "$block" = "NONE" ]; then
    say "$BAD" "the agent produced no NDB block — it did not detect a cluster on this host"; FAIL=1
    echo "     Force it on to see the reason:  sudo /opt/monit/monit-config.sh -d 1"
  elif printf '%s' "$block" | grep -q '"accessible": false'; then
    say "$BAD" "the agent sees NDB but cannot read it:"; FAIL=1
    printf '%s\n' "$block" | sed 's/^/     /'
  else
    say "$OK" "the agent reads the cluster:"
    printf '%s\n' "$block" | sed 's/^/     /'
    conf=$(printf '%s' "$block" | sed -n 's/.*"data_nodes_configured": \([0-9]*\).*/\1/p')
    started=$(printf '%s' "$block" | sed -n 's/.*"data_nodes_started": \([0-9]*\).*/\1/p')
    echo
    say "$INF" "check these against 'ndb_mgm -e show' above: configured=${conf:-?} started=${started:-?}"
    printf '%s' "$block" | grep -q '"node_groups_known": false' && \
      say "$WARN" "node groups could not be resolved for every data node — the 'NDB Node Group Down' rule will be skipped (the 'NDB Node Down' rule still works)"
  fi
else
  say "$WARN" "/opt/monit/monit-agent.sh not found — run this on a host with the agent installed"
fi

echo
[ "$FAIL" = 1 ] && { say "$BAD" "something above needs attention — see docs/AGENTS.md"; exit 1; }
say "$OK" "NDB monitoring looks correct on this host"
