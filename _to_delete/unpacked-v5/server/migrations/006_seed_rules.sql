-- Seed alert rules (units normalized to what the agent actually reports)
INSERT INTO alert_rules (name, metric, comparator, threshold, duration_min, severity, channels) VALUES
  ('High RAM',          'ram.used_pct',     '>',  90,      3,  'critical', '[]'),
  -- Whole machine, not the tightest mount: /boot and /boot/efi are small by
  -- design and would otherwise trip this on every host. See 008_disk_total.sql.
  ('Disk Space',        'disk.total_used_pct', '>', 80,  5,  'critical', '[]'),
  ('CPU Sustained',     'cpu.total',        '>',  95,      10, 'warning',  '[]'),
  ('Server Offline',    'no_sample',        '>',  30,      0,  'critical', '[]'),  -- seconds without a sample
  ('HTTP Unhealthy',    'http.status_code', '!=', 200,     2,  'critical', '[]'),
  ('GPU VRAM Pressure', 'gpu.mem_used_pct', '>',  95,      5,  'warning',  '[]'),
  ('Service Down',      'service_down',     '>',  0,       1,  'critical', '[]'),
  ('DB Connections',    'db.active_pct',    '>',  85,      3,  'warning',  '[]');
