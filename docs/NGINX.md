# Serving monit behind nginx

Two things have to agree: the path nginx strips, and the path the dashboard was
built for. Get one wrong and you see a blank page with 404s on `/assets/…`.

## Under a sub-path (`https://host/monit/`)

**1. Build the dashboard for that path**

```bash
# .env
VITE_BASE=/monit/

docker compose -f docker-compose.app-only.yml build --no-cache app
docker compose -f docker-compose.app-only.yml up -d
```

`VITE_BASE` is a *build* argument, so it needs a rebuild — not just a restart —
whenever it changes. Everything the browser requests (assets, API calls, router
URLs) is then relative to it, and the same source builds for any prefix.

**2. Add the location block**

```nginx
# --- Monitoring dashboard + API (monit-server on 8080) ---
location = /monit { return 301 /monit/; }

location /monit/ {
        proxy_pass http://127.0.0.1:8080/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # agent payloads are capped at 256 KB by the app
        client_max_body_size 1m;
        proxy_read_timeout 120s;
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

**3. Point agents at the same prefix**

```bash
MONIT_API_URL=https://your-host/monit
```

The agent appends `/api/v1/ingest` itself.

### The trailing slashes are not optional

| Written as | Upstream receives | Result |
|---|---|---|
| `location /monit/` + `proxy_pass …:8080/;` | `/api/v1/health` | correct |
| `location /monit` + `proxy_pass …:8080/;` | `//api/v1/health` | API returns the SPA's HTML instead of JSON |
| `location /monit/` + `proxy_pass …:8080;` | `/monit/api/v1/health` | 404 — the app serves at the root |

The middle row is the one that wastes an afternoon: the dashboard loads fine and
only the API misbehaves, because the doubled slash stops matching the `/api/`
routes and falls through to the SPA handler.

## At the root of its own host (`https://monit.example.com`)

No rebuild needed — the default build already targets `/`.

```nginx
server {
    listen 443 ssl;
    server_name monit.example.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 1m;
    }
}
```

## Checks

```bash
curl -i https://your-host/monit            # 301 → /monit/
curl    https://your-host/monit/api/v1/health   # {"ok":true,…}  ← JSON, not HTML
curl -o /dev/null -w '%{http_code}\n' https://your-host/monit/incidents   # 200 (SPA fallback)
```

If `/monit/api/v1/health` returns HTML, re-read the trailing-slash table above.

Once TLS is in front, drop the published port so the app is only reachable
through nginx — in `.env`:

```
APP_PORT=127.0.0.1:8080
```
