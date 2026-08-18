#!/usr/bin/env bash
# Installs monit-agent on a Linux host (run as root).
# Usage: sudo ./install.sh <API_URL> <SERVER_ID> <API_KEY> [loop|cron]
set -euo pipefail

API_URL=${1:?usage: install.sh <API_URL> <SERVER_ID> <API_KEY> [loop|cron]}
SERVER_ID=${2:?missing SERVER_ID}
API_KEY=${3:?missing API_KEY}
MODE=${4:-loop}
DIR=$(cd "$(dirname "$0")" && pwd)

id -u monit >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin monit

mkdir -p /opt/monit /etc/monit /var/lib/monit-agent/buffer
install -m 0755 "$DIR/monit-agent.sh" /opt/monit/monit-agent.sh
chown -R monit:monit /var/lib/monit-agent

if [ ! -f /etc/monit/agent.conf ]; then
  sed -e "s|^MONIT_API_URL=.*|MONIT_API_URL=${API_URL}|" \
      -e "s|^MONIT_SERVER_ID=.*|MONIT_SERVER_ID=${SERVER_ID}|" \
      -e "s|^MONIT_API_KEY=.*|MONIT_API_KEY=${API_KEY}|" \
      "$DIR/agent.conf.example" > /etc/monit/agent.conf
  chown root:monit /etc/monit/agent.conf
  chmod 0640 /etc/monit/agent.conf
  echo "wrote /etc/monit/agent.conf"
fi

if [ "$MODE" = "cron" ]; then
  echo "* * * * * monit /opt/monit/monit-agent.sh >> /var/log/monit-agent.log 2>&1" > /etc/cron.d/monit-agent
  chmod 0644 /etc/cron.d/monit-agent
  echo "installed cron job (every minute, one-shot mode)"
else
  install -m 0644 "$DIR/monit-agent.service" /etc/systemd/system/monit-agent.service
  systemctl daemon-reload
  systemctl enable --now monit-agent.service
  echo "installed + started systemd service (loop mode)"
fi

echo "test payload:"
sudo -u monit env $(grep -v '^#' /etc/monit/agent.conf | xargs) bash /opt/monit/monit-agent.sh --print | head -c 600
echo
echo "done."
