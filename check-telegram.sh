#!/usr/bin/env bash
#
# check-telegram.sh — find out why Telegram alerts are not arriving.
#
# Run this on the central server. It checks, in the order things actually go
# wrong, and prints what to do about each:
#
#   1. is there an enabled telegram channel, and is its config complete?
#   2. is the bot token valid, and can the bot post to that chat id?
#   3. do any alert rules actually reference the channel?          <- usual cause
#   4. can the app container reach api.telegram.org at all?
#   5. what does the notification log say about recent attempts?
#
# Nothing is modified unless -t is given, which sends a real test message.
#
#   ./check-telegram.sh              # diagnose only
#   ./check-telegram.sh -t           # diagnose, then send a test message
#   ./check-telegram.sh -f           # also offer to attach the channel to silent rules
#
#   -c NAME   PostgreSQL container name (default: auto-detect)
#   -a NAME   app container name (default: auto-detect)
#   -n DBNAME database name (default: monit)
#   -U ROLE   role to connect as inside the container (default: postgres)
#   -L        local mode: use psql on this host with DATABASE_URL
#   -t        send a test message through each enabled telegram channel
#   -f        attach the first enabled telegram channel to every rule that has none
#
set -euo pipefail

CONTAINER=""; APP=""; DBNAME="monit"; DBROLE="postgres"
LOCAL=0; SEND_TEST=0; FIX=0
cd "$(dirname "$0")"

while getopts "c:a:n:U:Ltfh" opt; do
  case $opt in
    c) CONTAINER=$OPTARG ;; a) APP=$OPTARG ;;  n) DBNAME=$OPTARG ;;
    U) DBROLE=$OPTARG ;;   L) LOCAL=1 ;;       t) SEND_TEST=1 ;;
    f) FIX=1 ;;
    h) sed -n '3,29p' "$0"; exit 0 ;;
    *) echo "run '$0 -h' for usage" >&2; exit 2 ;;
  esac
done

C_OK=$'\033[32m✓\033[0m'; C_BAD=$'\033[31m✗\033[0m'; C_WARN=$'\033[33m!\033[0m'
C_INF=$'\033[36m▸\033[0m'
ok()   { printf '%s %s\n' "$C_OK" "$*"; }
bad()  { printf '%s %s\n' "$C_BAD" "$*"; FAILED=1; }
warn() { printf '%s %s\n' "$C_WARN" "$*"; }
info() { printf '%s %s\n' "$C_INF" "$*"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die()  { printf '%s %s\n' "$C_BAD" "$*" >&2; exit 1; }
FAILED=0

# --- database access ---------------------------------------------------------
if [ "$LOCAL" = 0 ] && [ -z "$CONTAINER" ] && command -v docker >/dev/null 2>&1 \
   && docker info >/dev/null 2>&1; then
  CONTAINER=$(docker ps --format '{{.Names}}\t{{.Image}}' \
    | awk -F'\t' 'tolower($2) ~ /postgres|timescale/ {print $1; exit}')
fi

if [ -n "$CONTAINER" ] && [ "$LOCAL" = 0 ]; then
  docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" || die "container '$CONTAINER' is not running"
  psql_run() { docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U "$DBROLE" -d "$DBNAME" -tAF'|' -c "$1"; }
  DBSRC="container '$CONTAINER', database '$DBNAME'"
else
  command -v psql >/dev/null 2>&1 || die "no PostgreSQL container found and psql is not installed"
  if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
    DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)
  fi
  [ -n "${DATABASE_URL:-}" ] || die "set DATABASE_URL, or pass -c <postgres container>"
  psql_run() { psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -tAF'|' -c "$1"; }
  DBSRC="DATABASE_URL"
fi
psql_run 'SELECT 1' >/dev/null 2>&1 || die "cannot query the database ($DBSRC)"

# --- app container (used for the network + Telegram API checks) ---------------
if [ -z "$APP" ] && command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  APP=$(docker ps --format '{{.Names}}\t{{.Image}}' \
    | awk -F'\t' 'tolower($1 $2) ~ /monit/ && tolower($2) !~ /postgres|timescale/ {print $1; exit}')
fi

# Runs a snippet of JS from the same place the notifier runs, so the network path
# tested is the one that matters. Falls back to this host if there is no
# container — the result is then only indicative.
# Only the last line is kept: Node prints warnings (TLS, experimental flags) on
# stderr, and a stray warning must not be mistaken for the API's reply.
node_run() {
  local out
  if [ -n "$APP" ]; then out=$(docker exec -i "$APP" node -e "$1" 2>&1)
  elif command -v node >/dev/null 2>&1; then out=$(node -e "$1" 2>&1)
  else echo "SKIP no node available"; return; fi
  printf '%s\n' "$out" | grep -E '^(200|4[0-9]{2}|5[0-9]{2}|NETFAIL) ' | tail -1 \
    || printf '%s\n' "$out" | tail -1
}

printf '\033[1mTelegram delivery check\033[0m  (%s)\n' "$DBSRC"
[ -n "$APP" ] && info "app container: $APP" || warn "no app container found — network checks run on this host instead"

# --- 1. channels -------------------------------------------------------------
head_ "1. Notification channels"
# The token itself is never printed — only facts about it. A malformed token is
# the difference between Telegram answering 404 (cannot parse it) and 401 (parsed
# but wrong), so these flags decide the whole diagnosis.
CHANNELS=$(psql_run "
  SELECT name, enabled,
         COALESCE(config->>'bot_token',''), COALESCE(config->>'chat_id',''),
         length(COALESCE(config->>'bot_token','')),
         CASE WHEN COALESCE(config->>'bot_token','') ~ '^[0-9]{5,16}:[A-Za-z0-9_-]{30,}\$'
              THEN 'ok' ELSE 'malformed' END,
         CASE WHEN COALESCE(config->>'bot_token','') ~ '\s' THEN 'yes' ELSE 'no' END,
         CASE WHEN lower(COALESCE(config->>'bot_token','')) LIKE 'bot%' THEN 'yes' ELSE 'no' END,
         CASE WHEN COALESCE(config->>'bot_token','') ~ '[^\x20-\x7E]' THEN 'yes' ELSE 'no' END,
         CASE WHEN COALESCE(config->>'chat_id','') ~ '\s' THEN 'yes' ELSE 'no' END
    FROM notify_channels WHERE type = 'telegram' ORDER BY name")

if [ -z "$CHANNELS" ]; then
  bad "no telegram channel exists — Settings → Add channel (type Telegram)"
  echo "   see docs/TELEGRAM.md steps 1–3"
  exit 1
fi

ACTIVE=""
TOKEN_BAD=0
while IFS='|' read -r name enabled token chat tlen tshape twhite tbotpfx tnonascii cwhite; do
  [ -z "$name" ] && continue
  if [ "$enabled" != "t" ]; then warn "$name — DISABLED (Settings → Enabled column)"; continue; fi
  if [ -z "$token" ] || [ -z "$chat" ]; then
    bad "$name — missing $( [ -z "$token" ] && printf 'bot_token '; [ -z "$chat" ] && printf 'chat_id' )"
    continue
  fi

  # A real token is <5-16 digits>:<35 chars of A-Za-z0-9_->, exactly 45-46 long.
  if [ "$tshape" = ok ]; then
    ok "$name — bot_token looks well formed (${tlen} chars)"
  else
    TOKEN_BAD=1
    bad "$name — bot_token is MALFORMED (${tlen} chars; expected about 46, shaped 1234567890:AAH9xQ…)"
    [ "$tbotpfx"  = yes ] && echo "   → it starts with 'bot'. The URL already adds that prefix; store only the token itself."
    [ "$twhite"   = yes ] && echo "   → it contains a SPACE or tab. Delete every space, including a trailing one."
    [ "$tnonascii" = yes ] && echo "   → it contains a non-ASCII character — retype it instead of pasting."
    if [ "$twhite" = no ] && [ "$tbotpfx" = no ] && [ "$tnonascii" = no ]; then
      echo "   → it is probably truncated or missing part after the colon. Re-copy the whole line from @BotFather."
    fi
  fi
  [ "$cwhite" = yes ] && { TOKEN_BAD=1; bad "$name — chat_id contains whitespace; remove it"; }

  case $chat in
    -100*) ok "$name — enabled, chat_id $chat (supergroup)" ;;
    -*)    ok "$name — enabled, chat_id $chat (group)" ;;
    [0-9]*) ok "$name — enabled, chat_id $chat (private chat)" ;;
    @*)    warn "$name — chat_id '$chat' is a @username; that only works for public channels, not private chats" ;;
    *)     bad  "$name — chat_id '$chat' is not a number; re-read it from getUpdates" ;;
  esac
  [ -z "$ACTIVE" ] && ACTIVE=$name
  LAST_TOKEN=$token; LAST_CHAT=$chat
done <<< "$CHANNELS"

[ -n "$ACTIVE" ] || { bad "no usable telegram channel"; exit 1; }

# --- 2. does Telegram accept the token and the chat? -------------------------
head_ "2. Telegram API"
GETME=$(node_run "
const t=process.env.T||'$LAST_TOKEN';
fetch('https://api.telegram.org/bot'+t+'/getMe')
 .then(r=>r.text().then(b=>console.log(r.status+' '+b.slice(0,300))))
 .catch(e=>console.log('NETFAIL '+e.message));")

case $GETME in
  200*)
    BOTNAME=$(printf '%s' "$GETME" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')
    ok "bot token is valid — @${BOTNAME:-unknown}"
    ;;
  401*) bad "bot token rejected (401 Unauthorized) — the token is well formed but wrong or revoked.
   re-copy it from @BotFather: /mybots → your bot → API Token" ;;
  404*)
    bad "Telegram answered 404 Not Found — it could not parse the token at all"
    echo "   404 is NOT 'wrong password'. It means the token is malformed, so the API URL"
    echo "   /bot<token>/getMe is not a valid route. Almost always one of:"
    echo "     · a stray SPACE inside or at the end of the token (most common when pasting)"
    echo "     · the value was saved with a 'bot' prefix — store only 1234567890:AAH9xQ…"
    echo "     · only part of the token was copied"
    echo "   Fix: Settings → delete the telegram channel → add it again, pasting the token"
    echo "   in one go from @BotFather (/mybots → API Token), with nothing before or after."
    ;;
  NETFAIL*|SKIP*)
    bad "cannot reach api.telegram.org from the app container"
    echo "   ${GETME#NETFAIL }"
    echo "   the CENTRAL SERVER makes this call, not the agents — open outbound 443 to api.telegram.org"
    ;;
  *) warn "unexpected reply from getMe: $GETME" ;;
esac

if [ "$SEND_TEST" = 1 ] && [[ $GETME == 200* ]]; then
  SEND=$(node_run "
  fetch('https://api.telegram.org/bot$LAST_TOKEN/sendMessage',{method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({chat_id:'$LAST_CHAT',text:'check-telegram.sh: delivery path is working'})})
   .then(r=>r.text().then(b=>console.log(r.status+' '+b.slice(0,300))))
   .catch(e=>console.log('NETFAIL '+e.message));")
  case $SEND in
    200*) ok "test message delivered to chat $LAST_CHAT — look in Telegram" ;;
    400*chat*not*found*|400*chat_id*)
      bad "chat not found — the id is wrong, or the bot has never been messaged in that chat"
      echo "   private chat: open the bot, press Start, send any message, then:"
      echo "   curl -s 'https://api.telegram.org/bot<TOKEN>/getUpdates' | python3 -m json.tool" ;;
    403*)
      bad "forbidden — the bot was blocked or removed from that chat"
      echo "   private chat: you may have pressed Stop/Block on the bot. Open it and press Start again." ;;
    *) bad "send failed: $SEND" ;;
  esac
fi

# --- 3. rules -> channels (the usual culprit) --------------------------------
head_ "3. Alert rules referencing a channel"
SILENT=$(psql_run "
  SELECT name FROM alert_rules
   WHERE enabled AND (channels IS NULL OR jsonb_array_length(channels) = 0)
   ORDER BY name")
WIRED=$(psql_run "
  SELECT name, channels::text FROM alert_rules
   WHERE enabled AND jsonb_array_length(channels) > 0 ORDER BY name")

if [ -n "$WIRED" ]; then
  while IFS='|' read -r n ch; do [ -n "$n" ] && ok "$n → $ch"; done <<< "$WIRED"
fi
if [ -n "$SILENT" ]; then
  echo
  while IFS='|' read -r n; do [ -n "$n" ] && bad "$n → no channel (opens incidents, notifies nobody)"; done <<< "$SILENT"
  echo "   fix in the dashboard: Alert rules → Edit → Notification channels → $ACTIVE → Save"
  echo "   or re-run this script with -f to attach '$ACTIVE' to all of them"
fi
if printf '%s' "$SILENT" | grep -qx 'Server Offline'; then
  echo
  warn "'Server Offline' is one of them — that is exactly the alert you were expecting."
fi

if [ "$FIX" = 1 ] && [ -n "$SILENT" ]; then
  head_ "Attaching '$ACTIVE' to every rule that has no channel"
  psql_run "
    UPDATE alert_rules SET channels = to_jsonb(ARRAY['$ACTIVE']::text[]), updated_at = now()
     WHERE enabled AND (channels IS NULL OR jsonb_array_length(channels) = 0)" >/dev/null
  psql_run "SELECT name, channels::text FROM alert_rules WHERE enabled ORDER BY name" \
    | while IFS='|' read -r n ch; do [ -n "$n" ] && ok "$n → $ch"; done
  echo
  info "takes effect on the next alert tick (~30 s); no restart needed"
fi

# --- 4. what happened recently ----------------------------------------------
head_ "4. Recent delivery attempts (notification_log)"
LOG=$(psql_run "
  SELECT to_char(created_at,'MM-DD HH24:MI'), channel, event,
         CASE WHEN success THEN 'sent' ELSE 'FAILED' END,
         COALESCE(left(response::text,120),'')
    FROM notification_log ORDER BY created_at DESC LIMIT 10")
if [ -z "$LOG" ]; then
  warn "empty — nothing has ever been sent through any channel"
  INC=$(psql_run "SELECT count(*) FROM incidents WHERE started_at > now() - interval '1 day'")
  if [ "${INC:-0}" -gt 0 ]; then
    bad "$INC incidents were raised in the last 24 h and none produced a notification"
    echo "   that combination means the rules are not referencing a channel — see section 3"
  fi
else
  while IFS='|' read -r t ch ev res detail; do
    [ -z "$t" ] && continue
    if [ "$res" = sent ]; then ok  "$t  $ch  $ev"
    else                       bad "$t  $ch  $ev  $detail"; fi
  done <<< "$LOG"
fi

DEAD=$(psql_run "SELECT count(*) FROM notification_dead_letter")
[ "${DEAD:-0}" -gt 0 ] && warn "$DEAD notifications gave up after retrying (notification_dead_letter)"

# --- 5. current state --------------------------------------------------------
head_ "5. Servers currently offline"
OFFLINE=$(psql_run "
  SELECT id, COALESCE(to_char(last_seen,'MM-DD HH24:MI'),'never')
    FROM servers
   WHERE archived_at IS NULL
     AND (last_seen IS NULL OR last_seen < now() - interval '60 seconds')
   ORDER BY id")
if [ -z "$OFFLINE" ]; then
  ok "none — every server is reporting"
else
  while IFS='|' read -r id seen; do
    [ -n "$id" ] && info "$id — last seen $seen"
  done <<< "$OFFLINE"
fi

echo
if [ "$FAILED" = 1 ]; then
  printf '%s something above needs fixing — see docs/TELEGRAM.md\n' "$C_BAD"
  exit 1
fi
ok "no problems found"
