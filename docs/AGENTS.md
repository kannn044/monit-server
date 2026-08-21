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

**Values go in flags, never positionally.** `./deploy-agent.sh host api-server sk_…`
is rejected rather than quietly ignoring the ID and key.

### Deploying as an ordinary user

The remote account does not have to be root. Files are staged in that account's
own home (`~/.monit-agent-deploy`) — writing straight into root-owned `/opt`
would fail — and only the install step runs through `sudo`:

```bash
./deploy-agent.sh gdata@10.1.1.175 -i api-server -k sk_agent_xxx
```

The account needs sudo rights; the script checks before touching anything and
says so plainly if they are missing. One ssh connection is shared for the whole
run, so a password-only account is asked once instead of five or six times.

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

The tool lives at **`/opt/monit/monit-config.sh`** on the target.
(`~/.monit-agent-deploy/` is only the staging copy `deploy-agent.sh` leaves
behind; editing it changes nothing.)

Over ssh, use **`ssh -t`** — sudo cannot prompt for a password without a
terminal and fails with *"a terminal is required to read the password"*:

```bash
ssh -t gdata@10.1.1.175 'sudo /opt/monit/monit-config.sh -s'
```

On the host itself:

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

### Lost the key?

It cannot be looked up — the dashboard stores only its SHA-256 hash. Issue a
replacement instead: **Projects → the server's row → New key**, copy it from the
card (it is shown once), and install it with the command that card hands you:

```bash
ssh -t user@host 'sudo /opt/monit/monit-config.sh -k sk_agent_new…'
```

The host's own copy is also still on disk if the agent is running — `grep
MONIT_API_KEY /etc/monit/agent.conf` as root. Deleting the server and
registering the ID again works too (it restores the record and issues a new
key), but rotating is one click and keeps the history.

### Sampling faster

```bash
ssh -t gdata@10.1.1.175 'sudo /opt/monit/monit-config.sh -i 5'
```

Lowering the interval is safe on its own — the offline threshold is
`3 × SAMPLE_INTERVAL_S`, so a faster agent simply has more margin. Two things
are worth knowing:

- **cron mode ignores it.** Cron can only fire once a minute. `monit-config.sh -s`
  shows the mode; if it reads `cron (once a minute)`, reinstall in loop mode
  (`sudo ./install.sh <URL> <ID> <KEY> loop`) to sample faster. Installing in
  one mode now removes the other, so a host never reports twice.
- **Storage doubles when the interval halves.** At 5 s a host writes ~60 MB a
  day without TimescaleDB. Adjust `prune-metrics.sh -d` accordingly.

Below about 5 s there is little to gain: the agent spends 1 s measuring CPU
deltas, and the dashboard refreshes every 10 s anyway. The ingest rate limit
(`INGEST_RATE_MAX`, 12 requests per 10 s per server) allows down to 1 s, but
`monit-config.sh` refuses anything under 5 s.

For faster *offline* detection, match the central server to the new interval:

```bash
echo 'SAMPLE_INTERVAL_S=5' >> /opt/monit-server/.env   # offline after 15 s
docker compose -f docker-compose.app-only.yml up -d
```

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

## Turning an agent off

```bash
# from the central server
./deploy-agent.sh root@10.1.0.101 -S     # stop + disable, keep everything
./deploy-agent.sh root@10.1.0.101 -E     # start it again
./deploy-agent.sh root@10.1.0.101 -X     # remove completely
```

Or on the host itself:

```bash
sudo systemctl disable --now monit-agent   # loop mode
sudo rm -f /etc/cron.d/monit-agent         # cron mode
pgrep -af monit-agent                      # confirm nothing is left
```

`-S` keeps the files, config and API key, so `-E` brings it straight back.
`-X` deletes the service, `/opt/monit`, `/etc/monit`, the buffer and the `monit`
user — the host is left as it was before installation.

A stopped host keeps its entry in the dashboard and will start firing
**Server Offline** after 30 s. Either delete the server there (Projects →
Archive), or silence the incident, or disable the *Server Offline* rule for it.

### How much traffic does an agent actually use?

One sample is roughly 2–5 KB — around **30 MB per host per day** at a 10 s
interval, or 250 bytes/s. If a link looks saturated, the agent is almost
certainly not the cause; check for two agents sharing one `server_id`, an open
dashboard (it polls every 10 s and the fleet endpoint returns every server), or
simply the traffic the monitored service itself is doing — which is what the
network chart on the server page is showing you.

To cut it anyway without going dark, slow the agent down rather than stopping it:

```bash
sudo /opt/monit/monit-config.sh -i 60
# then on the central server:  SAMPLE_INTERVAL_S=60 in .env, and restart
```

## Useful on the target

```bash
systemctl status monit-agent
journalctl -u monit-agent -f
bash /opt/monit/monit-agent.sh --print | head -40   # the payload, without sending
ls /var/lib/monit-agent/buffer                      # samples waiting for the server
```

A non-empty buffer means the central server was unreachable; the agent drains it
automatically on the next successful send.
