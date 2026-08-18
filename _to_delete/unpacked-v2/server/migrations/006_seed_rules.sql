-- Seed alert rules (units normalized to what the agent actually reports)
INSERT INTO alert_rules (name, metric, comparator, threshold, duration_min, severity, channels) VALUES
  ('High RAM',          'ram.used_pct',     '>',  90,      3,  'critical', '[]'),
  ('Low Disk',          'disk.avail_kb',    '<',  5242880, 5,  'critical', '[]'),  -- 5 GiB in KB
  ('CPU Sustained',     'cpu.total',        '>',  95,      10, 'warning',  '[]'),
  ('Server Offline',    'no_sample',        '>',  30,      0,  'critical', '[]'),  -- seconds without a sample
  ('HTTP Unhealthy',    'http.status_code', '!=', 200,     2,  'critical', '[]'),
  ('GPU VRAM Pressure', 'gpu.mem_used_pct', '>',  95,      5,  'warning',  '[]'),
  ('Service Down',      'service_down',     '>',  0,       1,  'critical', '[]'),
  ('DB Connections',    'db.active_pct',    '>',  85,      3,  'warning',  '[]');
