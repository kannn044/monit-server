# Disk I/O, network rates and rule packs

## What the agent reports

| Payload key | Source | Fields (cumulative counters) |
|---|---|---|
| `network[]` | `/proc/net/dev`, interfaces in `MONIT_NET_IFACES` | `rx_bytes tx_bytes rx_errs rx_drop tx_errs tx_drop` |
| `diskio[]` | `/proc/diskstats`, whole physical disks only | `dev read_bytes write_bytes reads writes io_ms` |

`MONIT_DISKIO=0` turns disk I/O off; `MONIT_DISKIO_DEVICES="sda nvme0n1"` pins the
device list (default `auto` = everything in `/sys/block` except loop/ram/zram/sr/fd/dm-*/md*/nbd/drbd,
so LVM and RAID layers are not counted on top of the disks under them).

Old agents keep working; they simply have no `diskio` and rules on those metrics are skipped
for them. Roll the new agent out with `./update-agents.sh`.

## Rate metrics for alert rules

Rates are computed from the two newest samples (≤ 300 s apart). A counter that went
backwards (reboot) or a missing previous sample yields no value, and the rule is skipped
for that tick — never a fake zero.

| Metric | Unit stored | Entered in the UI as |
|---|---|---|
| `net.rx_bps`, `net.tx_bps` | bytes/s (sum of reported interfaces) | MB/s (1024²) |
| `net.errors_ps`, `net.drops_ps` | events/s (rx+tx) | per second |
| `disk.read_bps`, `disk.write_bps` | bytes/s (sum of disks) | MB/s (1024²) |
| `disk.read_iops`, `disk.write_iops` | ops/s | per second |
| `disk.busy_pct` | % time the busiest disk had I/O in flight (iostat `%util`) | % |

Long-range charts read `metrics_io_1m` / `metrics_io_1h` (separate rollups, so the
existing `metrics_1m/1h` history is not rebuilt). `disk.busy_pct` has no rollup.

## Rule packs

*Alert rules → Rule packs.* A pack is a list of rule definitions. **Apply to groups…**
creates one *binding* per selected group (or one for all servers / a server list).
Each binding materialises ordinary `alert_rules` rows (`pack_binding_id`, `pack_item_id`),
evaluated per server like any other rule — servers that join the group later are covered
automatically.

- Edit the pack → every binding is re-synced (rule ids, and so open incidents, survive).
- Edit a binding → channels, enabled, and per-item overrides (threshold, recover,
  duration, severity, off) for that group only.
- Pack-owned rules cannot be edited from the Rules tab (HTTP 409); edit the pack.
- Removing an item, a binding or a pack resolves the incidents its rules had open.
- A pack applied to a group plus a global rule on the same metric gives two alerts —
  disable one of them.

API: `GET/POST /api/v1/rule-packs`, `PUT/DELETE /api/v1/rule-packs/:id`,
`POST /api/v1/rule-packs/:id/apply`, `PUT/DELETE /api/v1/rule-pack-bindings/:id`.
