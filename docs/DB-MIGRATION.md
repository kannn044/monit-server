# Moving the database out of Docker onto the host

Same machine, container → native PostgreSQL. Nothing is deleted: the container
and its volume keep every row until you remove them yourself, so the way back is
one line in `.env`.

```bash
./migrate-db-to-native.sh --check      # what would move, and what would stop it
./migrate-db-to-native.sh --dump       # rehearse; safe while the app is running
./migrate-db-to-native.sh --cutover    # stop app → final dump → restore → verify
```

## Do the two servers even collide? Usually not

The instinct is to stop the container so the native server can have port 5432.
**Don't** — everything here reads the old data through `docker exec`, and that
needs the container running:

```
$ docker stop postgres-db && docker exec postgres-db psql -U monit -d monit -c '\dt'
Error response from daemon: container … is not running
```

Nothing is lost if you already did (`docker start postgres-db` brings it back,
the rows are in its volume) — but the stop was probably unnecessary. A container
only takes a host port if it **publishes** one:

```bash
docker port postgres-db
```

* **Nothing listed** — no collision at all. The container's PostgreSQL is
  reachable only on the docker network, and a native server binds host port 5432
  happily beside it. Run both, migrate, then retire the old one. This is the
  usual case for a compose service, and almost certainly yours: nothing in
  `docker-compose.app-only.yml` publishes the database.
* **`5432/tcp -> 0.0.0.0:5432`** — then they do collide, and the order matters:

  ```bash
  ./migrate-db-to-native.sh --dump     # 1. while the container still runs
  docker stop postgres-db              # 2. now the port is free
  sudo systemctl start postgresql      # 3. native server takes 5432
  ./migrate-db-to-native.sh --cutover  # 4. (restart the container first)
  ```

  Or leave the container alone and give the native server another port:
  `MONIT_TARGET_PORT=5433`. There is nothing wrong with a database on 5433.

`--dump` deliberately checks only the source, so you can take the dump before
the native server exists at all.

## If the names differ on the two sides

The container's database and the one you created on the host do not have to
share a name:

```bash
export MONIT_DB_NAME=monit            # in the container
export MONIT_TARGET_DB=monit_server   # on the native server
```

| Variable | Default | |
|---|---|---|
| `MONIT_DB_CONTAINER` | `postgres-db` | the container to read from |
| `MONIT_DB_NAME` | `monit` | database inside it |
| `MONIT_DB_USER` | `monit` | role on both sides |
| `MONIT_TARGET_DB` | same as `MONIT_DB_NAME` | database on the host |
| `MONIT_TARGET_HOST` / `MONIT_TARGET_PORT` | `127.0.0.1` / `5432` | |
| `MONIT_DUMP_DIR` | `/var/backups/monit` | |

## If the native server is on 5433

Set it once and every command below picks it up:

```bash
export MONIT_TARGET_PORT=5433
export PGPASSWORD='the monit password on the native server'
```

Two things on Rocky 9 that only bite on a non-default port:

**SELinux only knows 5432.** If PostgreSQL refuses to start with
`could not bind IPv4 address … Permission denied`, that is the label, not the
firewall:

```bash
sudo semanage port -a -t postgresql_port_t -p tcp 5433   # policycoreutils-python-utils
sudo semanage port -l | grep postgresql                  # confirm
```

**`psql` still defaults to 5432**, so every manual check needs `-p 5433` or it
quietly talks to the container's server instead — the confusing kind of wrong.

The port also has to appear in `DATABASE_URL` after the cutover:

```dotenv
DATABASE_URL=postgres://monit:PASSWORD@172.17.0.1:5433/monit
```

## Before anything else: two things decide whether this is easy

**TimescaleDB.** If the source has it, a plain dump/restore does **not** carry
hypertables and the restore fails or silently produces plain tables. `--check`
refuses to continue when it sees the extension. Find out first:

```bash
docker exec postgres-db psql -U monit -d monit -Atc "select extname from pg_extension"
```

**`postgres-db` is shared with `emac-backend`.** Only the `monit` database moves.
Stopping or removing that container later would take the other application's
database with it, so leave it alone until someone owns that decision.

## 1. Install and prepare the native server

Rocky 9:

```bash
sudo dnf install -y postgresql-server postgresql-contrib
sudo postgresql-setup --initdb
sudo systemctl enable --now postgresql
```

`postgresql-contrib` is not optional here — the schema uses `pgcrypto`.

Create the role and an empty database. Use the same name the app already uses,
so only the host and port change:

```bash
sudo -u postgres createuser --pwprompt monit
sudo -u postgres createdb -O monit monit
```

## 2. Check

```bash
export PGPASSWORD='the password you just set'
./migrate-db-to-native.sh --check
```

It reports both versions, the size, the extensions, the schemas, and refuses if
the target is older than the source, already has tables, or does not exist yet.

`pgboss` is one of the schemas it carries — that is the job queue, so queued
notifications survive the move.

## 3. Rehearse

```bash
./migrate-db-to-native.sh --dump
```

Safe while the app is running. It writes to `/var/backups/monit`, checks the
dump is readable with `pg_restore -l`, and stops if it is truncated. Do this
once before the real thing so the cutover has no surprises left in it.

## 3b. Rehearse the restore, not just the dump

Especially when the two servers are more than one major version apart (16 → 18,
say), or the database is measured in gigabytes:

```bash
./migrate-db-to-native.sh --rehearse
```

It restores the dump into `<target>_rehearsal`, times it, and compares row
counts — without stopping the app or touching the real target database. Old
dump into a newer server is the supported direction, but this is the difference
between finding a problem now and finding it with production stopped.

```
✓ created scratch database 'monit_server_rehearsal'
▸ restoring into it (this is the slow part — time it)
✓ restored in 1s
  container : servers=18 users=5 … system_metrics=1182
  rehearsal : servers=18 users=5 … system_metrics=1182
✓ identical
```

The restore time it prints is the number to plan the cutover window around. The
role needs `CREATEDB` for this; the script says so if it is missing. Drop the
scratch database when you are done — it prints the command.

## 4. Cut over

```bash
./migrate-db-to-native.sh --cutover
```

It stops the app first — **on purpose**. A dump taken while the app is writing
loses whatever lands between the dump and the switch. Agents buffer samples
locally (`MONIT_BUFFER_MAX`, 50 by default), so a few minutes of downtime costs
no data; they deliver the backlog when the server returns.

Then it dumps, restores inside a single transaction, and compares row counts on
both sides. A mismatch stops the migration with the container still intact.

It leaves the app **stopped**. That is deliberate: the next step needs your
`.env`, and starting it with the old URL would just write to the old database
again.

## 5. The part that catches everyone

The app runs in a container. **Inside it, `127.0.0.1` is the container**, not
your host — a native PostgreSQL on the host is not there. Use the host's address
on the docker bridge:

```bash
docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}'   # usually 172.17.0.1
```

```dotenv
DATABASE_URL=postgres://monit:PASSWORD@172.17.0.1:5432/monit
```

The machine's LAN address (`10.1.1.171`) works too, and is easier to read later.

Then let PostgreSQL accept that connection — a fresh install listens only on
localhost and rejects everything else:

```bash
# /var/lib/pgsql/data/postgresql.conf
listen_addresses = '*'

# /var/lib/pgsql/data/pg_hba.conf   (above the restrictive lines)
host    monit    monit    172.17.0.0/16    scram-sha-256

sudo systemctl reload postgresql
```

If SELinux is enforcing and PostgreSQL refuses to listen, that is
`postgresql_can_network`:

```bash
sudo setsebool -P postgresql_can_rsync on 2>/dev/null || true
sudo ausearch -m avc -ts recent | grep -i postgres
```

Start it and watch:

```bash
docker compose -p monit -f docker-compose.app-only.yml up -d app
docker logs -f monit-app-1
```

`getaddrinfo`/`ECONNREFUSED` at this point is a networking problem, not a data
one — `./check-db-network.sh` names it.

## 6. Verify, then leave it alone for a while

```bash
./migrate-db-to-native.sh --verify     # row counts, both sides
```

Watch the dashboard for a sampling interval or two: servers online, charts
drawing, a test notification arriving. **Do not remove the container yet.** It
costs nothing to keep, and it is the only complete copy of the old state.

## Rolling back

Put the old `DATABASE_URL` back in `.env` and restart:

```dotenv
DATABASE_URL=postgres://monit:PASSWORD@postgres-db:5432/monit
```

```bash
docker compose -p monit -f docker-compose.app-only.yml up -d --force-recreate app
```

Samples written to the native database after the cutover stay there, so roll
back promptly if you are going to. After that, treat the native server as the
real one.

## Afterwards

* Back it up. The container is no longer the copy of record:
  `pg_dump -Fc -U monit monit > /var/backups/monit/monit-$(date +%F).dump`
* Without TimescaleDB nothing prunes `system_metrics` for you — keep
  `prune-metrics.sh` on a cron.
* `docker-compose.app-only.yml` still declares the external `pgnet` network for
  the container. With the database on the host it is no longer needed for the
  database, but leaving it does no harm.
