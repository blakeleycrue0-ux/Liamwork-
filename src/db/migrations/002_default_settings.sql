INSERT INTO settings (key, value) VALUES
  ('default_check_interval', '60'),
  ('scheduler_tick', '15'),
  ('crawler_concurrency', '8'),
  ('notify_on_first_check', 'false'),
  ('max_items_per_email', '20'),
  ('crawler_enabled', 'true'),
  ('log_retention_days', '30')
ON CONFLICT (key) DO NOTHING;
