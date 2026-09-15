-- Core schema for Web Monitor
CREATE TABLE IF NOT EXISTS websites (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT    NOT NULL,
  url                TEXT    NOT NULL UNIQUE,
  active             INTEGER NOT NULL DEFAULT 1,
  check_interval     INTEGER NOT NULL DEFAULT 60,      -- seconds
  detection_method   TEXT    NOT NULL DEFAULT 'auto',  -- auto | rss | html | browser
  selector_config    TEXT    NOT NULL DEFAULT '{}',    -- JSON: {feed_url,list,title,link,date}
  notes              TEXT,
  baseline_done      INTEGER NOT NULL DEFAULT 0,       -- first run only records, never notifies
  last_checked_at    TEXT,
  last_success_at    TEXT,
  last_error         TEXT,
  last_error_at      TEXT,
  error_count        INTEGER NOT NULL DEFAULT 0,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  last_new_item_at   TEXT,
  last_new_item_title TEXT,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_websites_active ON websites(active);

CREATE TABLE IF NOT EXISTS workers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  email      TEXT    NOT NULL UNIQUE,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_workers_active ON workers(active);

-- One row per detected publication. content_hash is the de-duplication key.
CREATE TABLE IF NOT EXISTS posts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  website_id    INTEGER NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  title         TEXT    NOT NULL,
  url           TEXT,
  published_at  TEXT,
  content_hash  TEXT    NOT NULL,
  excerpt       TEXT,
  first_seen_at TEXT    NOT NULL DEFAULT (datetime('now')),
  notified_at   TEXT,
  UNIQUE (website_id, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_posts_website_seen ON posts(website_id, first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_seen ON posts(first_seen_at DESC);

CREATE TABLE IF NOT EXISTS check_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  website_id    INTEGER NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  checked_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  success       INTEGER NOT NULL,
  new_items     INTEGER NOT NULL DEFAULT 0,
  items_found   INTEGER NOT NULL DEFAULT 0,
  method        TEXT,
  duration_ms   INTEGER,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_check_logs_website ON check_logs(website_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_check_logs_checked ON check_logs(checked_at DESC);

-- Global runtime configuration, editable from the dashboard.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Single-row table shared by the web process and the crawler process.
CREATE TABLE IF NOT EXISTS crawler_state (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  status              TEXT    NOT NULL DEFAULT 'stopped', -- running | idle | stopped
  last_run_at         TEXT,
  last_run_duration_ms INTEGER,
  next_run_at         TEXT,
  last_heartbeat_at   TEXT,
  pid                 INTEGER,
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO crawler_state (id, status) VALUES (1, 'stopped') ON CONFLICT (id) DO NOTHING;

-- Express session store.
CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
