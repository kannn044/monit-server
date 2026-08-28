#!/usr/bin/env bash
#
# monit-agent.sh — Lightweight server metrics collector & shipper.
#
# Design: stateless, fire-and-forget, bounded on-disk buffer, hard timeouts.
# Modes : --loop [--interval N]   (continuous)   |   (default: one-shot / cron)
#
# Requires: bash, curl, awk, df, grep, date, hostname (coreutils).
# Optional: jq (rich PM2), docker, pm2, nvidia-smi, mysql/mysqladmin, psql.
#
set -u
set -o pipefail

# ---------------------------------------------------------------------------
# Configuration (env overrides; see /etc/monit/agent.conf)
# ---------------------------------------------------------------------------
[ -f /etc/monit/agent.conf ] && . /etc/monit/agent.conf

: "${MONIT_API_URL:=https://monitor.example.com}"
: "${MONIT_SERVER_ID:=$(hostname -s 2>/dev/null || cat /etc/hostname 2>/dev/null || echo unknown)}"
: "${MONIT_API_KEY:=}"
: "${MONIT_INTERVAL:=10}"
: "${MONIT_TIMEOUT:=5}"
: "${MONIT_CONNECT_TIMEOUT:=2}"
: "${MONIT_BUFFER_DIR:=/var/lib/monit-agent/buffer}"
: "${MONIT_BUFFER_MAX:=50}"
: "${MONIT_NET_IFACES:=eth0}"
: "${MONIT_GPU:=auto}"
: "${MONIT_HTTP_CHECKS:=}"
: "${MONIT_DOCKER_MAX:=100}"
: "${CPU_SAMPLE_S:=1}"
# Optional DB monitoring (read-only credentials; leave empty to disable)
: "${MONIT_MYSQL:=0}"          # 1 = enabled (uses ~/.my.cnf or MYSQL_* envs)
: "${MONIT_PG:=0}"             # 1 = enabled (uses PG* envs / .pgpass)
# MySQL NDB Cluster (ndbd / ndb_mgmd / SQL nodes).
: "${MONIT_NDB:=auto}"         # auto = use it if ndbinfo or ndb_mgm is available
: "${MONIT_NDB_CONNECTSTRING:=}"   # e.g. 10.1.1.20:1186 — only for the ndb_mgm path

INGEST_URL="${MONIT_API_URL%/}/api/v1/ingest"

log() { printf '%s [monit-agent] %s\n' "$(date -u +%FT%TZ)" "$*"; }

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
json_escape() {
  local s=${1-}
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/ }
  s=${s//$'\t'/ }
  printf '%s' "$s"
}

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ---------------------------------------------------------------------------
# Collection functions (each prints a JSON fragment)
# ---------------------------------------------------------------------------
collect_cpu() {
  # Two /proc/stat snapshots ~CPU_SAMPLE_S apart; delta idle vs total per core.
  awk '
    FNR==NR { for (i=2;i<=8;i++) pt[$1]+=$i; pi[$1]=$5+$6; next }
    {
      dt=0; for (i=2;i<=8;i++) dt+=$i; dt-=pt[$1]
      di=($5+$6)-pi[$1]
      used=(dt>0)?100*(1-di/dt):0
      if ($1=="cpu") total=used
      else { gsub(/^cpu/,"",$1); cores=cores (cores==""?"":",") "{\"id\":\""$1"\",\"used\":"sprintf("%.2f",used)"}" }
    }
    END { printf "{\"total\":%.2f,\"cores\":[%s]}", total, cores }
  ' <(grep '^cpu' /proc/stat) <(sleep "$CPU_SAMPLE_S"; grep '^cpu' /proc/stat)
}

collect_ram() {
  awk '
    /^MemTotal:/     {t=$2}
    /^MemFree:/      {f=$2}
    /^MemAvailable:/ {a=$2}
    /^Buffers:/      {b=$2}
    /^Cached:/       {c=$2}
    /^SwapTotal:/    {st=$2}
    /^SwapFree:/     {sf=$2}
    END {
      used=(a<=t)?t-a:0
      pct=(t>0)?100*used/t:0
      printf "{\"total_kb\":%d,\"used_kb\":%d,\"free_kb\":%d,\"available_kb\":%d,\"buffers_kb\":%d,\"cached_kb\":%d,\"used_pct\":%.2f,\"swap_total_kb\":%d,\"swap_free_kb\":%d}", \
        t,used,f,a,b,c,pct,st,sf
    }
  ' /proc/meminfo
}

collect_disk() {
  local items
  items=$(df -kP 2>/dev/null | awk '
    NR>1 && $1 !~ /^(tmpfs|devtmpfs|overlay|shm|udev|none|squashfs)/ {
      src=$1; size=$2; used=$3; avail=$4; pct=$5; sub(/%/,"",pct)
      if (size !~ /^[0-9]+$/) next
      m=$6; for (i=7;i<=NF;i++) m=m" "$i
      gsub(/\\/,"\\\\",m);  gsub(/"/,"\\\"",m)
      gsub(/\\/,"\\\\",src);gsub(/"/,"\\\"",src)
      printf "%s{\"mount\":\"%s\",\"device\":\"%s\",\"size_kb\":%s,\"used_kb\":%s,\"avail_kb\":%s,\"used_pct\":%s}", (n++?",":""), m, src, size, used, avail, pct
    }')
  printf '[%s]' "$items"
}

collect_net() {
  local out="" iface line rx tx
  for iface in $MONIT_NET_IFACES; do
    [ -z "$iface" ] && continue
    line=$(awk -v IF="$iface" 'NR>2 { name=$1; sub(/:$/,"",name); if (name==IF) print $2, $10 }' /proc/net/dev 2>/dev/null)
    [ -z "$line" ] && continue
    read -r rx tx <<< "$line"
    out="${out}${out:+,}{\"iface\":\"$(json_escape "$iface")\",\"rx_bytes\":${rx:-0},\"tx_bytes\":${tx:-0}}"
  done
  printf '[%s]' "$out"
}

collect_load() {
  local l1 l5 l15 cores
  read -r l1 l5 l15 _ < /proc/loadavg
  cores=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)
  printf '{"1m":%s,"5m":%s,"15m":%s,"cores":%s}' "$l1" "$l5" "$l15" "$cores"
}

collect_uptime() { awk '{printf "%.0f", $1}' /proc/uptime 2>/dev/null || echo 0; }

collect_gpu() {
  if [ "$MONIT_GPU" = "0" ] || ! command -v nvidia-smi >/dev/null 2>&1; then
    printf '[]'; return 0
  fi
  local items
  items=$(nvidia-smi \
      --query-gpu=index,name,utilization.gpu,memory.total,memory.used,memory.free,temperature.gpu,power.draw \
      --format=csv,noheader,nounits 2>/dev/null | awk -F',' '
    function num(x){ gsub(/^[ \t]+|[ \t]+$/,"",x); if (x ~ /^[0-9.]+$/) return x+0; return 0 }
    NF>=8 {
      name=$2; gsub(/^[ \t]+|[ \t]+$/,"",name)
      gsub(/\\/,"\\\\",name); gsub(/"/,"\\\"",name)
      printf "%s{\"id\":%d,\"name\":\"%s\",\"util_pct\":%s,\"mem_total_mb\":%s,\"mem_used_mb\":%s,\"mem_free_mb\":%s,\"temp_c\":%s,\"power_w\":%s}", \
        (n++?",":""), num($1), name, num($3), num($4), num($5), num($6), num($7), num($8)
    }')
  printf '[%s]' "$items"
}

collect_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    printf '{"present":false,"accessible":true,"total":0,"running":0,"exited":0,"containers":[]}'; return 0
  fi
  # Distinguish "no containers" from "cannot talk to the daemon". Both used to
  # print running:0, which reads as an outage — and makes service_down fire.
  local out err rc
  err=$(mktemp 2>/dev/null || echo /tmp/monit-docker-err.$$)
  out=$(docker ps -a --format '{{.Names}}\t{{.State}}\t{{.Status}}' 2>"$err"); rc=$?
  if [ "$rc" -ne 0 ]; then
    local why
    why=$(head -c 200 "$err" 2>/dev/null | tr -d '\r' | head -1)
    rm -f "$err"
    printf '{"present":true,"accessible":false,"total":null,"running":null,"exited":null,"containers":[],"reason":"%s"}' \
      "$(json_escape "${why:-docker ps failed}")"
    return 0
  fi
  rm -f "$err"
  local total=0 running=0 exited=0 items="" name state status
  while IFS=$'\t' read -r name state status; do
    [ -z "$name" ] && continue
    total=$((total+1))
    case "$state" in
      running) running=$((running+1)) ;;
      exited)  exited=$((exited+1)) ;;
    esac
    if [ "$total" -le "$MONIT_DOCKER_MAX" ]; then
      items="${items}${items:+,}{\"name\":\"$(json_escape "$name")\",\"state\":\"$(json_escape "$state")\",\"status\":\"$(json_escape "$status")\"}"
    fi
  done <<< "$out"
  printf '{"present":true,"accessible":true,"total":%d,"running":%d,"exited":%d,"containers":[%s]}' \
    "$total" "$running" "$exited" "$items"
}

# --- PM2 -------------------------------------------------------------------
# PM2 state lives in a per-user daemon, and PM2 refuses to talk to a socket it
# does not own. The agent runs as the unprivileged 'monit' user, so a plain
# `pm2 jlist` reaches a brand-new empty daemon of its own and honestly reports
# nothing — which used to be published as "0 online / 0 stopped" and read as
# "your apps are down". Never report a count we could not actually read.
#
# The God Daemon puts its PM2_HOME in its process title:
#     PM2 v7.0.3: God Daemon (/root/.pm2)
# which every user can see. That gives us discovery without privileges; reading
# it still needs to run as the owner, via the sudo helper install.sh sets up.

# Prints "user<TAB>pm2_home" per running daemon.
pm2_daemons() {
  ps -eo user:32,args 2>/dev/null | awk '
    /God Daemon/ && !/awk/ {
      if (match($0, /\(([^)]*\.pm2[^)]*)\)/)) {
        home = substr($0, RSTART + 1, RLENGTH - 2)
        printf "%s\t%s\n", $1, home
      }
    }' | sort -u
}

# pm2 is frequently installed under nvm, which is not on a system user's PATH.
pm2_bin_for() {
  local owner=$1 home_dir bin
  if [ -n "${MONIT_PM2_BIN:-}" ] && [ -x "$MONIT_PM2_BIN" ]; then
    printf '%s' "$MONIT_PM2_BIN"; return 0
  fi
  bin=$(command -v pm2 2>/dev/null) && [ -n "$bin" ] && { printf '%s' "$bin"; return 0; }
  home_dir=$(getent passwd "$owner" 2>/dev/null | cut -d: -f6)
  for bin in /usr/local/bin/pm2 /usr/bin/pm2 \
             "$home_dir"/.nvm/versions/node/*/bin/pm2 \
             "$home_dir"/.npm-global/bin/pm2 "$home_dir"/node_modules/.bin/pm2; do
    [ -x "$bin" ] && { printf '%s' "$bin"; return 0; }
  done
  return 1
}

# Emits the jlist JSON for one daemon, or nothing if it cannot be read.
pm2_jlist() {
  local owner=$1 home=$2 bin out
  bin=$(pm2_bin_for "$owner") || return 1
  if [ "$owner" = "$(id -un 2>/dev/null)" ]; then
    out=$(PM2_HOME="$home" "$bin" jlist 2>/dev/null) || return 1
  elif [ -x /opt/monit/monit-pm2.sh ] && command -v sudo >/dev/null 2>&1; then
    # Narrow NOPASSWD rule installed by install.sh; the helper only ever runs
    # `pm2 jlist` against an existing PM2_HOME.
    out=$(sudo -n /opt/monit/monit-pm2.sh "$owner" "$home" 2>/dev/null) || return 1
  else
    return 1
  fi
  case $out in '['*) printf '%s' "$out" ;; *) return 1 ;; esac
}

collect_pm2() {
  local daemons owner home lists="" owners="" blocked="" bin_missing=0
  daemons=$(pm2_daemons)

  if [ -z "$daemons" ]; then
    # No daemon running. If the binary exists the host does use PM2, it just has
    # nothing up right now — that is a real 0, and worth reporting as one.
    if command -v pm2 >/dev/null 2>&1; then
      printf '{"present":true,"accessible":true,"online":0,"stopped":0,"processes":[]}'
    else
      printf '{"present":false,"accessible":true,"online":0,"stopped":0,"processes":[]}'
    fi
    return 0
  fi

  while IFS=$'\t' read -r owner home; do
    [ -z "$owner" ] && continue
    owners="${owners}${owners:+,}$(json_escape "$owner")"
    local one
    if one=$(pm2_jlist "$owner" "$home"); then
      lists="${lists}${lists:+$'\n'}${one}"
    else
      blocked="${blocked}${blocked:+, }${owner} (${home})"
      pm2_bin_for "$owner" >/dev/null 2>&1 || bin_missing=1
    fi
  done <<< "$daemons"

  if [ -z "$lists" ]; then
    # Detected but unreadable: report the fact, not a fabricated zero.
    local why
    if [ "$bin_missing" = 1 ]; then
      why="the pm2 binary is not on \$PATH for user $(id -un) — set MONIT_PM2_BIN in /etc/monit/agent.conf"
    else
      why="the agent runs as $(id -un) and PM2 only answers its owner — run: sudo /opt/monit/monit-config.sh --pm2"
    fi
    printf '{"present":true,"accessible":false,"online":null,"stopped":null,"processes":[],"owners":[%s],"reason":"%s"}' \
      "${owners:+\"${owners//,/\",\"}\"}" "$(json_escape "$why")"
    return 0
  fi

  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$lists" | jq -sc '
      [ .[] | .[] ] as $all
      | { present:true, accessible:true,
          online:  ([$all[] | select(.pm2_env.status=="online")] | length),
          stopped: ([$all[] | select(.pm2_env.status!="online")] | length),
          processes:[$all[] | {name:.name, status:.pm2_env.status, pid:(.pid // .pm2_env.pid // 0),
                               memory:(.monit.memory // 0), cpu:(.monit.cpu // 0),
                               restarts:(.pm2_env.restart_time // 0),
                               owner:(.pm2_env.username // "")}] }' 2>/dev/null && return 0
  fi

  # jq-less fallback: count "status":"online" occurrences in the raw jlist.
  local online stopped total
  online=$(printf '%s' "$lists" | grep -o '"status":"online"' | wc -l | tr -d ' ')
  total=$(printf '%s' "$lists" | grep -o '"status":"[a-z]*"' | wc -l | tr -d ' ')
  stopped=$(( total > online ? total - online : 0 ))
  printf '{"present":true,"accessible":true,"online":%d,"stopped":%d,"processes":[]}' \
    "${online:-0}" "${stopped:-0}"
}

collect_http() {
  local out="" url code lat
  [ -z "$MONIT_HTTP_CHECKS" ] && { printf '[]'; return 0; }
  local url_list=${MONIT_HTTP_CHECKS//,/ }
  for url in $url_list; do
    [ -z "$url" ] && continue
    local resp
    resp=$(curl -s -o /dev/null -w '%{http_code} %{time_total}' \
        --max-time 3 --connect-timeout 2 "$url" 2>/dev/null) || resp="0 0"
    code=${resp%% *}
    lat=${resp##* }
    # NOTE: force base-10 integer — curl returns "000" on connection failure,
    # and a leading zero would be invalid JSON.
    code=$((10#${code:-0}))
    out="${out}${out:+,}{\"url\":\"$(json_escape "$url")\",\"status_code\":${code},\"latency_ms\":$(awk -v t="${lat:-0}" 'BEGIN{printf "%.0f", t*1000}')}"
  done
  printf '[%s]' "$out"
}

# --- MySQL NDB Cluster -------------------------------------------------------
# "Is any node down" cannot be answered by the live-node list alone: NDB drops
# the row for a data node that is not running, so a dead node simply vanishes.
# The configured roster has to come from somewhere else —
#   · ndbinfo.config_nodes  (NDB 8.0.22+), read over SQL from any SQL node
#   · ndb_mgm -e show       always lists configured nodes, including
#                           "not connected", and works on a host with no mysqld
# so both are implemented and whichever can answer is used.
#
# Data memory is reported too, because an NDB cluster stops accepting writes
# when DataMemory fills — it is as much an outage as a missing node.

ndb_sql() {  # $1 = SQL; prints tab-separated rows, empty on any failure
  mysql -N -B -e "$1" 2>/dev/null || true
}

# Parses `ndb_mgm -e show`. Format is stable across 7.x/8.x:
#   [ndbd(NDB)]     2 node(s)
#   id=1    @10.1.1.21  (mysql-8.0.36 ndb-8.0.36, Nodegroup: 0, *)
#   id=2 (not connected, accepting connect from 10.1.1.22)
ndb_parse_mgm() {
  awk '
    /^\[ndbd\(NDB\)\]/      { sect="NDB";  next }
    /^\[ndb_mgmd\(MGM\)\]/  { sect="MGM";  next }
    /^\[mysqld\(API\)\]/    { sect="API";  next }
    /^id=/ {
      if (sect == "") next
      line = $0
      id = line; sub(/^id=/, "", id); sub(/[^0-9].*$/, "", id)
      host = ""; group = ""; state = "STARTED"
      if (line ~ /not connected/) {
        state = "MISSING"
        if (match(line, /accepting connect from [^)]*/)) {
          host = substr(line, RSTART + 23, RLENGTH - 23)
          if (host == "any host") host = ""
        }
      } else {
        if (match(line, /@[0-9a-zA-Z_.:-]+/)) host = substr(line, RSTART + 1, RLENGTH - 1)
        if (line ~ /, starting/ || line ~ /\(starting/) state = "STARTING"
        if (line ~ /, shutting down/) state = "STOPPING"
        if (match(line, /Nodegroup: [0-9]+/)) {
          group = substr(line, RSTART + 11, RLENGTH - 11)
        } else if (line ~ /no nodegroup/) {
          group = "none"
        }
      }
      printf "%s\t%s\t%s\t%s\t%s\n", sect, id, host, state, group
    }' 
}

collect_ndb() {
  local have_sql=0 have_mgm=0
  [ "$MONIT_NDB" = "0" ] && { printf ''; return 0; }

  # Probe cheaply: one row from ndbinfo means this host is an NDB SQL node.
  if command -v mysql >/dev/null 2>&1; then
    [ -n "$(ndb_sql "SELECT 1 FROM ndbinfo.nodes LIMIT 1;")" ] && have_sql=1
  fi
  command -v ndb_mgm >/dev/null 2>&1 && have_mgm=1

  if [ "$have_sql" = 0 ] && [ "$have_mgm" = 0 ]; then
    [ "$MONIT_NDB" = "1" ] && \
      printf '{"present":true,"accessible":false,"reason":"%s"}' \
        "$(json_escape "MONIT_NDB=1 but neither ndbinfo (via mysql) nor ndb_mgm is available on this host")"
    return 0
  fi

  local roster="" live="" mem="" memberships="" arb_connected="" src=""

  if [ "$have_sql" = 1 ]; then
    src="ndbinfo"
    # config_nodes exists from 8.0.22; without it a missing node is invisible.
    roster=$(ndb_sql "SELECT node_id, node_type, node_hostname FROM ndbinfo.config_nodes ORDER BY node_id;")
    live=$(ndb_sql "SELECT node_id, status, uptime FROM ndbinfo.nodes ORDER BY node_id;")
    memberships=$(ndb_sql "SELECT node_id, group_id FROM ndbinfo.membership ORDER BY node_id;")
    arb_connected=$(ndb_sql "SELECT arb_connected FROM ndbinfo.membership LIMIT 1;")
    mem=$(ndb_sql "SELECT node_id, memory_type, used, total FROM ndbinfo.memoryusage;")
  fi

  # Use the management client when it can add the configured roster the SQL
  # path lacks, or when there is no SQL node here at all.
  local mgm=""
  if [ "$have_mgm" = 1 ] && { [ "$have_sql" = 0 ] || [ -z "$roster" ]; }; then
    local args=()
    [ -n "$MONIT_NDB_CONNECTSTRING" ] && args=(-c "$MONIT_NDB_CONNECTSTRING")
    mgm=$(timeout "${MONIT_TIMEOUT:-5}" ndb_mgm "${args[@]+"${args[@]}"}" --try-reconnect=1 -e show 2>/dev/null | ndb_parse_mgm || true)
    [ -n "$mgm" ] && src="${src:+$src+}ndb_mgm"
  fi

  if [ -z "$roster" ] && [ -z "$mgm" ] && [ -z "$live" ]; then
    printf '{"present":true,"accessible":false,"reason":"%s"}' \
      "$(json_escape "NDB is present but neither ndbinfo nor ndb_mgm returned anything — check the mysql credentials, or set MONIT_NDB_CONNECTSTRING to the management node")"
    return 0
  fi

  # Merge every source into one node list. awk keeps this to a single pass and
  # avoids a bash loop per node.
  printf '%s' "$(
    { printf 'ROSTER\n%s\n' "$roster"
      printf 'LIVE\n%s\n'   "$live"
      printf 'GROUP\n%s\n'  "$memberships"
      printf 'MEM\n%s\n'    "$mem"
      printf 'MGM\n%s\n'    "$mgm"
      printf 'ARB\n%s\n'    "$arb_connected"
      printf 'SRC\n%s\n'    "$src"
    } | awk -F'\t' '
      function esc(x) { gsub(/\\/, "\\\\", x); gsub(/"/, "\\\"", x); return x }
      /^ROSTER$/ { m="R"; next } /^LIVE$/ { m="L"; next } /^GROUP$/ { m="G"; next }
      /^MEM$/    { m="M"; next } /^MGM$/  { m="X"; next } /^ARB$/   { m="A"; next }
      /^SRC$/    { m="S"; next }
      $0 == "" { next }
      m == "R" { id=$1+0; seen[id]=1; type[id]=$2; if ($3 != "" && $3 != "NULL") host[id]=$3; next }
      m == "L" { id=$1+0; seen[id]=1; if (type[id]=="") type[id]="NDB"; status[id]=$2; uptime[id]=$3+0; next }
      m == "G" { id=$1+0; if ($2 != "" && $2 != "NULL") grp[id]=$2+0; next }
      m == "M" { id=$1+0; if ($2 ~ /^Data/) { dused[id]=$3+0; dtot[id]=$4+0 }
                          if ($2 ~ /^Index/) { iused[id]=$3+0; itot[id]=$4+0 } next }
      m == "X" { id=$2+0; seen[id]=1
                 if (type[id]=="") type[id]=$1
                 if (host[id]=="" && $3!="") host[id]=$3
                 # ndb_mgm is authoritative about "not connected"
                 if ($4=="MISSING" || status[id]=="") status[id]=$4
                 if ($5 != "" && $5 != "none") grp[id]=$5+0
                 next }
      m == "A" { arb=$1; next }
      m == "S" { src=$0; next }
      END {
        n=0; ndb_conf=0; ndb_started=0; unhealthy=0
        dmax=0; imax=0
        for (id in seen) {
          t = (type[id]=="" ? "NDB" : type[id])
          st = status[id]
          if (st == "") st = (t=="NDB" ? "MISSING" : "CONNECTED")
          ok = (st=="STARTED" || st=="CONNECTED")
          if (t=="NDB") {
            ndb_conf++
            if (st=="STARTED") { ndb_started++; if (id in grp) live_in_group[grp[id]]++ }
            else unhealthy++
            # ndb_mgm does not print a Nodegroup for a node that is not
            # connected, so a dead node cannot always be attributed to a group.
            if (!(id in grp)) unknown_group++
          }
          if (id in grp) group_seen[grp[id]]=1
          if (dtot[id] > 0) { p = 100*dused[id]/dtot[id]; if (p > dmax) dmax=p }
          if (itot[id] > 0) { p = 100*iused[id]/itot[id]; if (p > imax) imax=p }
          items[n++] = sprintf("{\"id\":%d,\"type\":\"%s\",\"host\":\"%s\",\"status\":\"%s\"%s%s}",
                        id, esc(t), esc(host[id]), esc(st),
                        (id in grp)    ? sprintf(",\"group\":%d", grp[id]) : "",
                        (uptime[id]>0) ? sprintf(",\"uptime_s\":%d", uptime[id]) : "")
        }
        groups_total=0; groups_down=0
        for (g in group_seen) { groups_total++; if (live_in_group[g]+0 == 0) groups_down++ }
        # Sort by node id so the dashboard order is stable between samples.
        for (i=0;i<n;i++) for (j=i+1;j<n;j++) {
          ai=items[i]; aj=items[j]
          sub(/^\{"id":/,"",ai); sub(/,.*$/,"",ai)
          sub(/^\{"id":/,"",aj); sub(/,.*$/,"",aj)
          if (aj+0 < ai+0) { t2=items[i]; items[i]=items[j]; items[j]=t2 }
        }
        body=""
        for (i=0;i<n;i++) body = body (i?",":"") items[i]
        printf "{\"present\":true,\"accessible\":true,\"source\":\"%s\"", esc(src)
        printf ",\"data_nodes_configured\":%d,\"data_nodes_started\":%d,\"unhealthy\":%d",
               ndb_conf, ndb_started, unhealthy
        # Only claim a node-group verdict when every data node group is known.
        # Reporting 0 groups down while some group is unknown would be a
        # false all-clear on the one condition that takes the cluster offline.
        if (unknown_group+0 == 0)
          printf ",\"node_groups_total\":%d,\"node_groups_down\":%d", groups_total, groups_down
        else
          printf ",\"node_groups_known\":false"
        if (dmax > 0) printf ",\"data_memory_pct\":%.1f", dmax
        if (imax > 0) printf ",\"index_memory_pct\":%.1f", imax
        if (arb != "") printf ",\"arbitrator_connected\":%s", (arb==1 || arb=="1" || arb=="YES" ? "true" : "false")
        printf ",\"nodes\":[%s]}", body
      }')"
}

collect_databases() {
  local mysql_json="" pg_json=""
  if [ "$MONIT_MYSQL" = "1" ] && command -v mysql >/dev/null 2>&1; then
    local m_total m_active m_max
    m_total=$(mysql -N -e "SELECT COUNT(*) FROM information_schema.processlist;" 2>/dev/null || echo "")
    m_active=$(mysql -N -e "SELECT COUNT(*) FROM information_schema.processlist WHERE COMMAND <> 'Sleep';" 2>/dev/null || echo "")
    m_max=$(mysql -N -e "SHOW VARIABLES LIKE 'max_connections';" 2>/dev/null | awk '{print $2}' || echo "")
    if [ -n "$m_total" ]; then
      mysql_json="\"mysql\":{\"present\":true,\"reachable\":true,\"total\":${m_total},\"active\":${m_active:-0},\"max\":${m_max:-0}}"
    else
      mysql_json="\"mysql\":{\"present\":true,\"reachable\":false,\"total\":0,\"active\":0,\"max\":0}"
    fi
  fi
  if [ "$MONIT_PG" = "1" ] && command -v psql >/dev/null 2>&1; then
    local p_line p_active p_idle p_total p_max
    p_line=$(psql -tA -F' ' -c "SELECT count(*) FILTER (WHERE state='active'), count(*) FILTER (WHERE state='idle'), count(*) FROM pg_stat_activity;" 2>/dev/null || echo "")
    p_max=$(psql -tA -c "SHOW max_connections;" 2>/dev/null || echo "")
    if [ -n "$p_line" ]; then
      read -r p_active p_idle p_total <<< "$p_line"
      pg_json="\"postgres\":{\"present\":true,\"reachable\":true,\"total\":${p_total:-0},\"active\":${p_active:-0},\"idle\":${p_idle:-0},\"max\":${p_max:-0}}"
    else
      pg_json="\"postgres\":{\"present\":true,\"reachable\":false,\"total\":0,\"active\":0,\"max\":0}"
    fi
  fi
  local ndb_json=""
  local ndb_body
  ndb_body=$(collect_ndb)
  [ -n "$ndb_body" ] && ndb_json="\"ndb\":${ndb_body}"

  local body=""
  for part in "$mysql_json" "$pg_json" "$ndb_json"; do
    [ -n "$part" ] && body="${body}${body:+,}${part}"
  done
  printf '{%s}' "$body"
}

# ---------------------------------------------------------------------------
# Assemble the full payload
# ---------------------------------------------------------------------------
build_payload() {
  local os
  os=$(uname -srm 2>/dev/null | tr -s ' ')
  cat <<EOF
{
  "server_id":  "$(json_escape "$MONIT_SERVER_ID")",
  "timestamp":  "$(now_iso)",
  "hostname":   "$(json_escape "$(hostname 2>/dev/null || echo unknown)")",
  "os":         "$(json_escape "$os")",
  "uptime_s":   $(collect_uptime),
  "cpu":        $(collect_cpu),
  "ram":        $(collect_ram),
  "disk":       $(collect_disk),
  "network":    $(collect_net),
  "load":       $(collect_load),
  "gpu":        $(collect_gpu),
  "docker":     $(collect_docker),
  "pm2":        $(collect_pm2),
  "http":       $(collect_http),
  "databases":  $(collect_databases)
}
EOF
}

# ---------------------------------------------------------------------------
# Transport
# ---------------------------------------------------------------------------
curl_send() {
  local payload=$1
  [ -z "$MONIT_API_KEY" ] && return 1
  curl -fsS -o /dev/null \
    --max-time "$MONIT_TIMEOUT" \
    --connect-timeout "$MONIT_CONNECT_TIMEOUT" \
    -H "Authorization: Bearer ${MONIT_API_KEY}" \
    -H "Content-Type: application/json" \
    --data-binary "$payload" \
    "$INGEST_URL" 2>/dev/null
}

buffer_payload() {
  local payload=$1 ts f count
  mkdir -p "$MONIT_BUFFER_DIR" 2>/dev/null || return 1
  # %N is GNU date; fall back to $RANDOM for portability
  ts=$(date +%Y%m%d%H%M%S%N 2>/dev/null || echo "$(date +%Y%m%d%H%M%S)$RANDOM")
  f="$MONIT_BUFFER_DIR/${ts}_$(json_escape "$MONIT_SERVER_ID").json"
  printf '%s' "$payload" > "$f" 2>/dev/null || return 1
  count=$(ls -1 "$MONIT_BUFFER_DIR"/*.json 2>/dev/null | wc -l)
  if [ "$count" -gt "$MONIT_BUFFER_MAX" ]; then
    ls -1tr "$MONIT_BUFFER_DIR"/*.json | head -n "$((count - MONIT_BUFFER_MAX))" | xargs -r rm -f
  fi
}

# Drain a bounded backlog — only called when a fresh send just SUCCEEDED
# (i.e., the central endpoint is reachable), so these calls are normally fast.
#
# Bounded by TIME as well as by count: ten uploads that each hit the 5 s curl
# timeout would block the loop for the better part of a minute, and with no
# fresh sample going out in that window the server would report this host
# offline. Half the sample interval is the most we are willing to spend.
flush_buffer() {
  [ -d "$MONIT_BUFFER_DIR" ] || return 0
  local f n=0 deadline
  deadline=$(( $(date +%s) + (MONIT_INTERVAL / 2) + 1 ))
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    [ "$(date +%s)" -ge "$deadline" ] && break   # out of time; the rest waits
    if curl_send "$(cat "$f" 2>/dev/null)"; then
      rm -f "$f"
    else
      break   # central went down mid-drain; stop to avoid wasting time
    fi
    n=$((n+1))
    [ "$n" -ge 10 ] && break   # cap per-run drain
  done < <(ls -1tr "$MONIT_BUFFER_DIR"/*.json 2>/dev/null | head -n 10)
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
run_once() {
  local payload
  payload=$(build_payload)
  if curl_send "$payload"; then
    flush_buffer
  else
    buffer_payload "$payload"
  fi
}

main() {
  local mode="${1:-}" interval="$MONIT_INTERVAL"
  if [ "$mode" = "--loop" ]; then
    [ "${2:-}" = "--interval" ] && interval="${3:-$MONIT_INTERVAL}"
    trap 'log "received signal, exiting"; exit 0' INT TERM
    log "starting loop mode, interval=${interval}s, target=${INGEST_URL}"
    while :; do
      run_once
      sleep "$interval"
    done
  elif [ "$mode" = "--print" ]; then
    build_payload           # debug: print the payload without sending
  else
    run_once                # one-shot (cron); buffer is drained on success
  fi
}

main "$@"
