# Rolling out and maintaining agents

Three scripts cover the whole lifecycle:

| Script | Runs on | For |
|---|---|---|
| `deploy-agent.sh` | central server | push + install on a target over ssh |
| `agent/install.sh` | target | first install, asks step by step |
| `/opt/monit/monit-config.sh` | target | change settings afterwards |

## Adding a host, from the central server

```bash
cd /opt/monit-server
MONIT_ADMIN_PASSWORD='…' ./deploy-agent.sh root@10.1.0.101 -a -e you@company.com
```

That registers the host on the dashboard, takes the API key straight from the
response, rsyncs the agent, installs it, sends a real sample, and starts the
service. Nothing is copied by hand.

Without `-a` you paste a key you created in the dashboard yourself:

```bash
./deploy-agent.sh root@10.1.0.101 -i gpu-node-01 -k sk_agent_xxx
```

| Flag | Meaning |
|---|---|
| `-i ID` | server ID (default: the target's hostname) |
| `-a` | register on the dashboard and fetch the key automatically |
| `-e EMAIL` | admin email for `-a`; password from `$MONIT_ADMIN_PASSWORD` |
| `-k KEY` | use an existing key instead |
| `-U URL` | central URL *as the target sees it* — guessed from `.env` + this host's IP |
| `-m cron` | one sample per minute instead of the 10 s systemd loop |
| `-u` | update the agent files only, leave the config alone |

Re-running on a host that already exists rotates its key and reinstalls — safe
to repeat.

## Installing directly on the target

Copy `agent/` over and run it with no arguments to be asked for each value:

```bash
sudo ./install.sh
```

```
  ── monit agent setup ──────────────────────────────────
  Central server URL [http://10.1.0.50/monit]:
  Server ID (must match the dashboard) [pocdev]:
  API key (shown once when the server was registered):
  Sample interval in seconds [10]:
  Network interface(s) to report, space separated [ens192]:
  Local HTTP health checks, comma separated (blank = none):
  Run mode: loop … or cron … [loop]:
```

Defaults come from the machine itself — the interface is read from the default
route, the ID from the hostname — and from any previous install, so reinstalling
is mostly pressing Enter. Arguments still work for automation:
`sudo ./install.sh <URL> <ID> <KEY> [loop|cron]`.

Nothing is enabled until one real sample is accepted, so a wrong URL, ID or key
fails during setup rather than silently later.

## Changing settings later

```bash
sudo /opt/monit/monit-config.sh          # show, then edit interactively
sudo /opt/monit/monit-config.sh -s       # show only
sudo /opt/monit/monit-config.sh -i 30    # sample every 30 s
sudo /opt/monit/monit-config.sh -H "http://127.0.0.1:8084/health"
sudo /opt/monit/monit-config.sh -k sk_agent_new…    # after rotating the key
```

| Flag | Setting |
|---|---|
| `-i N` | sample interval (seconds) |
| `-H URLS` | local HTTP checks, comma separated |
| `-n "IF1 IF2"` | network interfaces |
| `-u URL` | central server URL |
| `-k KEY` | API key |
| `-g auto\|1\|0` | GPU collection |
| `-b N` | buffered-sample cap |
| `-y` | skip the confirmation |

Each change backs up `agent.conf`, sends a test sample, and restarts the
service. **If the sample is rejected the config is rolled back**, so a mistyped
key cannot leave a host silently not reporting.

### Interval and the offline threshold

The dashboard marks a server offline after `3 × SAMPLE_INTERVAL_S` (30 s by
default). Raising the agent's interval past 10 s without telling the central
server makes that host flap offline between samples. `monit-config.sh` warns
about it; the fix is on the central server:

```bash
echo 'SAMPLE_INTERVAL_S=30' >> /opt/monit-server/.env
docker compose -f docker-compose.app-only.yml up -d
```

## Updating the agent on every host

```bash
for h in 10.1.0.101 10.1.0.102 10.1.0.103; do
  ./deploy-agent.sh "root@$h" -u
done
```

`-u` replaces the script and restarts; configuration and API keys are untouched.

## Useful on the target

```bash
systemctl status monit-agent
journalctl -u monit-agent -f
bash /opt/monit/monit-agent.sh --print | head -40   # the payload, without sending
ls /var/lib/monit-agent/buffer                      # samples waiting for the server
```

A non-empty buffer means the central server was unreachable; the agent drains it
automatically on the next successful send.
