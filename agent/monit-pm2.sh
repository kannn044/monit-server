#!/usr/bin/env bash
#
# monit-pm2.sh — read one PM2 daemon's process list on behalf of the agent.
#
# PM2 keeps its state in a per-user daemon and refuses to serve a socket it does
# not own, so the unprivileged 'monit' user cannot see apps started by root or
# by a deploy user. This helper is the *only* thing the agent is allowed to run
# through sudo, and it can do exactly one thing: `pm2 jlist` for an existing
# PM2_HOME. Installed root-owned 0755 — it must not be writable by the agent
# user, or the NOPASSWD rule would become a root shell.
#
# Usage: monit-pm2.sh <owner> <pm2_home>
#
set -u

die() { printf '%s\n' "$*" >&2; exit 1; }

[ "$#" -eq 2 ] || die "usage: $0 <owner> <pm2_home>"
OWNER=$1
PM2_HOME_DIR=$2

# The owner must be a real account, and never one that could be tricked into
# running something else: no shell metacharacters, no path.
case $OWNER in
  *[!A-Za-z0-9._-]*|'') die "invalid owner" ;;
esac
id -u "$OWNER" >/dev/null 2>&1 || die "no such user: $OWNER"

# Only an existing directory named .pm2, owned by that same user. PM2 would
# happily *create* a home it cannot find, which is how an arbitrary path could
# turn into an arbitrary write; requiring it to exist already removes that.
case $PM2_HOME_DIR in
  /*/.pm2|/*/.pm2/) ;;
  *) die "pm2 home must be an absolute path ending in /.pm2" ;;
esac
case $PM2_HOME_DIR in
  *..*) die "invalid pm2 home" ;;
esac
[ -d "$PM2_HOME_DIR" ] || die "no such directory: $PM2_HOME_DIR"
[ "$(stat -c '%U' "$PM2_HOME_DIR" 2>/dev/null)" = "$OWNER" ] \
  || die "$PM2_HOME_DIR is not owned by $OWNER"

# Locate pm2 as the owner sees it — it is very often under nvm. An explicit
# path may be pinned in /etc/monit/pm2.conf, which is written by install.sh and
# must stay root-owned: the agent user must never get to choose what root execs.
CONF_BIN=""
if [ -f /etc/monit/pm2.conf ] && [ "$(stat -c '%U' /etc/monit/pm2.conf)" = root ]; then
  # shellcheck disable=SC1091
  . /etc/monit/pm2.conf
  CONF_BIN=${MONIT_PM2_BIN:-}
fi
OWNER_HOME=$(getent passwd "$OWNER" | cut -d: -f6)
PM2_BIN=""
for c in "$CONF_BIN" /usr/local/bin/pm2 /usr/bin/pm2 \
         "$OWNER_HOME"/.nvm/versions/node/*/bin/pm2 \
         "$OWNER_HOME"/.npm-global/bin/pm2 "$OWNER_HOME"/.yarn/bin/pm2; do
  [ -n "$c" ] && [ -x "$c" ] && { PM2_BIN=$c; break; }
done
[ -z "$PM2_BIN" ] && PM2_BIN=$(command -v pm2 2>/dev/null || true)
[ -n "$PM2_BIN" ] || die "pm2 binary not found for $OWNER (set MONIT_PM2_BIN in /etc/monit/pm2.conf)"

# runuser is the systemd-friendly way to drop privileges; su is the fallback.
if command -v runuser >/dev/null 2>&1; then
  exec runuser -u "$OWNER" -- env PM2_HOME="$PM2_HOME_DIR" HOME="$OWNER_HOME" \
       "$PM2_BIN" jlist
else
  exec su -s /bin/sh "$OWNER" -c \
       "PM2_HOME=$(printf '%q' "$PM2_HOME_DIR") HOME=$(printf '%q' "$OWNER_HOME") $(printf '%q' "$PM2_BIN") jlist"
fi
