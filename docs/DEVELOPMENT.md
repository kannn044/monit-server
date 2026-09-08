# Running it locally

Two ways. Use the first while you are changing the UI, the second to check what
you will actually ship.

## What you need

Node 20+ and a PostgreSQL. TimescaleDB is optional — without it the migrations
take the plain-PostgreSQL path and say so in the log.

The quickest database, and the one the code already expects:

```bash
docker run -d --name monit-pg \
  -e POSTGRES_USER=monit -e POSTGRES_PASSWORD=monit_dev_password -e POSTGRES_DB=monit \
  -p 5432:5432 postgres:16
```

Those three values are the default `DATABASE_URL` in `server/src/config.js`, so
with that container running you need no environment variables at all. A
PostgreSQL you already have works too — point `DATABASE_URL` at it.

## 1. Two processes, with hot reload

```bash
cd server    && npm install && npm run dev     # API on :8080, restarts on save
cd dashboard && npm install && npm run dev     # UI  on :5173, hot module reload
```

Open **http://localhost:5173**. The Vite dev server proxies `/api` and
`/install` to the API on :8080, so the whole thing behaves as one origin.

The first start prints the admin password **once**, in the server log:

```
  ADMIN ACCOUNT CREATED — this password is shown ONCE
    email:    admin@example.com
    password: ……………
```

Miss it and the account still exists; the quickest reset is to drop the database
and start again, or set `ADMIN_EMAIL` / `ADMIN_PASSWORD` before the first run.

## 2. One process, the way production runs

```bash
cd dashboard && npm run build && rm -rf ../server/public && cp -r dist ../server/public
cd ../server && npm start
```

Open **http://localhost:8080**. This is worth doing before you deploy: it is the
build Fastify actually serves, and it catches anything that works only under the
dev server.

Behind a sub-path, build with the base baked in — it has to match the nginx
location:

```bash
VITE_BASE=/monit/ npm run build
```

## Setting up so an agent can report

The dashboard needs to know where agents should post, or the install command it
writes has nowhere to point: **Settings → Address agents connect to**.

In dev that is `http://localhost:8080` — the API's own port, **not** :5173. The
Vite dev server is for your browser; an agent talks to Fastify directly.

## Configuration: `.env`

The server reads the first of these that exists, and says which one it used:

```
[config] loaded /Users/you/monit-server/.env
```

| | |
|---|---|
| `$MONIT_ENV_FILE` | wherever you point it |
| `server/.env` | |
| `.env` at the repo root | the same file docker compose uses |

Real environment variables always win, so `DATABASE_URL=… npm run dev` overrides
the file for that one run.

Before this the Node process did not read `.env` at all — docker compose did,
turning it into environment variables before the container started, and the
shell scripts read it with grep. Editing `DATABASE_URL` there and running
`npm run dev` therefore changed nothing, and the app used the built-in default.

## Pointing a local copy at the production database

Useful for reproducing something with real data. It is also the fastest way to
damage that data, because three things happen at startup that assume this
process is the only one running:

* **migrations run** — a checkout with a newer migration alters the live schema
  the moment you press start;
* **the alert engine starts** — a second evaluator on the same rules;
* **the notifier starts** — every alert is then delivered twice.

`MONIT_READONLY=1` turns off all three:

```bash
ssh -N -L 5432:postgres-db:5432 root@10.1.1.171 &     # if the port is not published

cd server
MONIT_READONLY=1 \
DATABASE_URL='postgres://monit:PASSWORD@127.0.0.1:5432/monit' \
npm run dev
```

```
  ┌─ MONIT_READONLY ───────────────────────────────────────────────
  │  Migrations, the alert engine and the notifier are all OFF.
  │  Nothing here will change the schema or send a notification.
  │  Database: postgres://monit:***@127.0.0.1:5432/monit
  └────────────────────────────────────────────────────────────────
```

The dashboard, the API and ingest all still work — the name means "this process
is not the one running the show", not that the connection is read-only at the
SQL level. **Editing through the UI still edits production**: deleting a server
or rotating a key does the real thing. If you want that stopped too, connect as
a PostgreSQL role with only `SELECT`; the read paths work and every write fails
loudly.

Never set `MONIT_READONLY` on the real deployment — nothing would evaluate
alerts or send notifications, and it would look healthy while doing it.

## Trying an agent

`agent/monit-agent.sh` reads `/proc`, so it runs on Linux and not on macOS. To
exercise it from a Mac, use a Linux container:

```bash
docker run -it --rm --network host rockylinux:9 bash
# inside, paste the install command from the dashboard
```

Without one you can still work on everything else — the dashboard, the API, the
alert engine — by posting a sample by hand:

```bash
curl -X POST http://localhost:8080/api/v1/ingest \
  -H "Authorization: Bearer <the key shown when you registered the server>" \
  -H 'Content-Type: application/json' \
  -d '{"server_id":"dev-01","timestamp":"'"$(date -u +%FT%TZ)"'",
       "cpu":{"total":42.5,"cores":[]},
       "ram":{"total_kb":16777216,"used_kb":8388608,"used_pct":50},
       "disk":[],"network":[],"load":{"1m":1,"5m":1,"15m":1,"cores":8},
       "gpu":[],"docker":{"present":false},"pm2":{"present":false},"http":[]}'
# → 202 {"accepted":true}
```

## Ports

| | |
|---|---|
| 5173 | Vite dev server — the UI while developing |
| 8080 | Fastify — API, and the built UI in mode 2 |
| 5432 | PostgreSQL |

`PORT=…` moves Fastify; if you do, change the proxy targets in
`dashboard/vite.config.js` to match.
