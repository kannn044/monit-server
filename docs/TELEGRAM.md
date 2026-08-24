# Telegram notifications — step by step

Alerts reach Telegram through a **bot** that you own. Two values are needed: the
bot's **token** and the **chat id** of wherever the messages should land. Both
are obtained inside Telegram itself; nothing is registered with a third party.

The whole path is: `alert fires → rule lists a channel → pg_boss job → https://api.telegram.org/bot<token>/sendMessage`.

---

## 1. Create the bot

In Telegram, open a chat with **@BotFather** and send:

```
/newbot
```

It asks for two things:

- a display name — anything, e.g. `Monit Alerts`
- a username — must be unique and end in `bot`, e.g. `acme_monit_alerts_bot`

BotFather answers with the token:

```
7712345678:AAH9xQwErTyUiOpAsDfGhJkLzXcVbNm1234
```

Treat it as a password — anyone holding it can post as the bot. Save it now;
BotFather can re-show it with `/mybots`, but the dashboard never can.

## 2. Decide where alerts should arrive, and get its chat id

The bot cannot message anyone who has not spoken to it first — Telegram blocks
that by design. So the first message always has to come from your side.

### To a group (recommended for a team)

1. Create the group (or use an existing one).
2. **Add the bot as a member**, then send any message in the group, e.g. `hello`.
3. Groups where the bot is not an admin only deliver messages that mention it,
   depending on the bot's privacy setting. The simplest reliable setup is to
   **make the bot an admin** of the group — no extra permissions needed.

### To yourself (fine for a first test)

Search your bot by its `@username`, open it, press **Start**, and send `hi`.

### Read the chat id

With that message sent, ask Telegram what it saw:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | python3 -m json.tool
```

Look for `"chat": { "id": ... }`:

```json
"chat": { "id": -1001234567890, "title": "Ops Alerts", "type": "supergroup" }
```

- a **group / supergroup** id is negative, often starting `-100…`
- a **private** chat id is a positive number

Copy the number exactly, **including the minus sign**.

If `getUpdates` returns `{"ok":true,"result":[]}`, no message has reached the bot
yet — send one in the chat and run it again. Note that `getUpdates` cannot be
used while a webhook is set, and it only returns recent updates.

## 3. Add the channel in the dashboard

**Settings → Add channel**

| Field | Value |
|---|---|
| channel name | `telegram-ops` — this is the name rules refer to |
| type | Telegram |
| bot token | the token from step 1 |
| chat id | the number from step 2 |

Press **Add channel**, then **Test** on the row. A message should appear in the
chat within a second or two:

```
🔵 INFO — Test notification
Test from monit-server at 2026-08-24T04:31:27Z
server: -
```

If Test fails, the dashboard shows Telegram's own words — see
[Troubleshooting](#troubleshooting).

## 4. Attach the channel to your rules — **do not skip this**

A channel that no rule references sends nothing. Incidents still open, the Fleet
page still turns red, and Telegram stays silent. This is the single most common
reason "alerts do not work".

**Alert rules → Edit** a rule → **Notification channels** → select
`telegram-ops` → **Save rule**. Repeat for every rule that should page you.

The Alert rules page warns you when rules are still silent:

> 3 of 8 rules have no notification channel — they will open incidents in the
> dashboard but send nothing.

and each such rule shows **no channel** in the Channels column.

A sensible starting point: attach the channel to `Server Offline`,
`Disk Space`, `High RAM` and `Service Down`; leave the noisier
`CPU Sustained` on dashboard-only until you have tuned its threshold.

## 5. Confirm a real alert

Stop an agent and wait ~30 s:

```bash
ssh -t user@host 'sudo systemctl stop monit-agent'
```

Telegram should receive:

```
🔴 CRITICAL — Server Offline
Server Offline: no_sample = 45.68 (> 30) on web-prod-01 for 0 min
server: web-prod-01  ·  project: Core Platform (Prod)
metric: no_sample = 45.68 (threshold > 30)
since: 2026-08-24T04:33:13Z
```

Start the agent again and a `✅ RESOLVED` message follows.

Every attempt — success or failure — is recorded in **Settings → Notification
log**.

---

## What gets sent

| Event | Prefix |
|---|---|
| alert fired | 🔴 CRITICAL / 🟡 WARNING / 🔵 INFO |
| still firing (hourly reminder) | ⏰ STILL FIRING |
| resolved | ✅ RESOLVED |
| flapping, notifications suppressed | 🌀 FLAPPING (suppressed) |

Delivery is queued through pg_boss: a failed send is retried 5 times with
backoff, then written to `notification_dead_letter`. A Telegram outage delays
alerts, it does not lose them.

---

## Troubleshooting

### Start here: `./check-telegram.sh`

On the central server, in the project directory:

```bash
./check-telegram.sh              # diagnose
./check-telegram.sh -t           # also send a real test message
./check-telegram.sh -f           # attach the channel to every rule that has none
./check-telegram.sh --fix-token  # strip stray whitespace / a 'bot' prefix from the stored token
./check-telegram.sh --set-token  # paste a fresh token (hidden), verified before it is stored
```

It walks the delivery path in the order things actually break and names the fix:

```
1. Notification channels
✓ telegram-ops — enabled, chat_id 812345678 (private chat)

2. Telegram API
✓ bot token is valid — @acme_monit_alerts_bot

3. Alert rules referencing a channel
✗ Server Offline → no channel (opens incidents, notifies nobody)
   fix in the dashboard: Alert rules → Edit → Notification channels → telegram-ops → Save
   or re-run this script with -f to attach 'telegram-ops' to all of them

! 'Server Offline' is one of them — that is exactly the alert you were expecting.

4. Recent delivery attempts (notification_log)
! empty — nothing has ever been sent through any channel
✗ 5 incidents were raised in the last 24 h and none produced a notification
   that combination means the rules are not referencing a channel — see section 3
```

The Telegram API calls are made **from inside the app container**, so the
network path it tests is the one the notifier really uses.

### Reading the errors by hand

The **Test** button surfaces Telegram's own error text.

| What Test says | Meaning | Fix |
|---|---|---|
| `HTTP 401: {"ok":false,...,"description":"Unauthorized"}` | the token is **well formed but wrong** or was revoked | re-copy it from BotFather (`/mybots` → your bot → API Token) |
| `HTTP 404: {"ok":false,...,"description":"Not Found"}` | the token is **malformed** — Telegram cannot parse it, so `/bot<token>/…` is not a route | see below |
| `HTTP 400: ..."description":"Bad Request: chat not found"` | wrong chat id, or the bot was never messaged in that chat | send a message in the chat, re-run `getUpdates`, use the id verbatim including `-100…` |
| `HTTP 403: ..."bot was kicked from the group chat"` | the bot was removed | add it back and make it an admin |
| `telegram channel needs config.bot_token and config.chat_id` | a field was left blank | fill both in Settings |
| `fetch failed` / `ETIMEDOUT` / `ENOTFOUND` | the central server has no route to `api.telegram.org` | see below |

### 404 Not Found — the token is malformed

404 and 401 mean different things and it is worth being precise, because 404
looks like "Telegram is down" when it is really "this string is not a token":

| Telegram says | Token parsed? | Meaning |
|---|---|---|
| `401 Unauthorized` | yes | the token is a valid *shape* but wrong or revoked |
| `404 Not Found` | **no** | the token is malformed — whitespace, a `bot` prefix, or truncated |

A real token is about **46 characters**: 5–16 digits, a colon, then 35
characters of `A-Z a-z 0-9 _ -`, e.g. `7712345678:AAH9xQwErTyUiOpAsDfGhJkLzXcVbNm1234`.

Verified causes of a 404:

| Stored value | Result |
|---|---|
| `…Nm1234` + a trailing space | **404** |
| a space anywhere inside | **404** |
| saved as `bot7712345678:AA…` | **404** |
| only part of it copied | **404** |
| a trailing newline | fine — URLs drop newlines |

`./check-telegram.sh` names which one it is without ever printing the token:

```
✗ telegram-ops — bot_token is MALFORMED (48 chars; expected about 46, shaped 1234567890:AAH9xQ…)
   → it contains a SPACE or tab. Delete every space, including a trailing one.
```

Whitespace and a `bot` prefix are never part of a real token, so they can be
removed without guessing — `--fix-token` does exactly that, in place, and then
sends a test:

```
Repairing the stored token
✓ telegram-ops — bot_token looks well formed (46 chars)
✓ repaired — no restart needed, the notifier reads the channel per send

2. Telegram API
✓ bot token is valid — @acme_monit_alerts_bot
✓ test message delivered to chat 8647538703 — look in Telegram
```

A token that is genuinely *incomplete* cannot be repaired, and the script says
so rather than pretending:

```
✗ still malformed after stripping whitespace — the token is incomplete, not just dirty
   re-copy the whole line from @BotFather (/mybots → your bot → API Token)
```

### Right shape, wrong length → 401

Telegram's secret half is **always exactly 35 characters**. A token carrying one
extra character still *parses*, so Telegram answers 401 rather than 404 — which
reads as "wrong password" when the real problem is one stray keystroke. The
script measures both halves:

```
✗ telegram-ops — bot_token has the right SHAPE but the wrong LENGTH (47 chars total)
   bot id: 10 digits   secret after the colon: 36 chars (Telegram always issues exactly 35)
   → 36 is 1 too many — an extra character came along with the paste.
```

### Replacing the token safely

`--set-token` takes it typed in, hidden, and **checks it with Telegram before
storing** — so a bad paste can never replace a credential that works:

```
$ ./check-telegram.sh --set-token
Setting a new bot token for 'telegram-ops'
   Get it from @BotFather: /mybots → your bot → API Token
   paste the token (input hidden):
▸ checking it with Telegram before storing…
✓ Telegram accepts it — @acme_monit_alerts_bot
✓ stored for channel 'telegram-ops'
✓ test message delivered to chat 8647538703 — look in Telegram
```

It refuses, leaving the stored value untouched, when the paste has the wrong
length or Telegram rejects it. The value never reaches shell history or a web
form.

Independently of the repair, the app itself now strips whitespace and a stray
`bot` prefix before calling Telegram, so a pasted-in space no longer breaks
delivery at all, and a token that is too short fails with a message that says
so instead of a bare 404.

### The central server needs outbound HTTPS

This is the usual blocker on an on-prem box. The **central server** calls
Telegram — the agents never do. Check from inside the container:

```bash
docker exec monit-server-app-1 node -e \
  "fetch('https://api.telegram.org').then(r=>console.log('OK',r.status)).catch(e=>console.log('FAIL',e.message))"
```

`OK 200` means the path is clear. `FAIL …` means egress to
`api.telegram.org:443` is blocked — open it on the firewall, or put the app
behind a proxy by adding to the app service in `docker-compose.app-only.yml`:

```yaml
    environment:
      HTTPS_PROXY: http://proxy.internal:3128
      NO_PROXY: localhost,127.0.0.1,postgres-db
```

Node 20 does not read `HTTPS_PROXY` on its own; if you need a proxy, say so and
the delivery code can be pointed through an `undici` `ProxyAgent`.

### The log shows old failures after you fixed something

`notification_log` is history, not current state. Rows from before a fix stay
there forever, so the script judges the **most recent attempt** (and a live test
message, if one just went through) rather than counting old failures:

```
✗ 08-24 05:10  telegram-ops  alert.fired  {"error": "HTTP 404: ..."}
…
! the failures above pre-date the fix applied just now — a live test message got through
   they stay in the log as history. Trigger a real alert to see a fresh success.
```

To see a fresh success, stop and start an agent and let `Server Offline` fire.

### Alerts fire but nothing arrives

In order of how often it turns out to be each:

1. **The rule has no channel** — Alert rules page, look for **no channel**.
2. **The channel is disabled** — Settings, the Enabled column.
3. **A delivery failed** — Settings → Notification log shows `failed` with the
   reason; persistent failures land in `notification_dead_letter`.

```sql
SELECT channel, event, success, response, created_at
  FROM notification_log ORDER BY created_at DESC LIMIT 20;
SELECT * FROM notification_dead_letter ORDER BY created_at DESC LIMIT 20;
```

### Too many messages

Telegram rate-limits bots to roughly 20 messages per minute to the same group.
If a fleet-wide event fires many rules at once, raise `duration_min` on the
noisy rules and set `recover_threshold` a few points below the trigger so
metrics hovering at the boundary do not flap. The flapping guard
(`flap_limit` / `flap_window_min`) already suppresses repeat notifications for a
rule that keeps toggling.

### Rotating the token

BotFather → `/mybots` → your bot → **API Token** → **Revoke current token**.
Paste the new one into the channel in Settings and press **Test**. Nothing else
changes — rules reference the channel by *name*, not by token.
