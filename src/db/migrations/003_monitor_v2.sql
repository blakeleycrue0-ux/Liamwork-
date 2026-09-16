CREATE TABLE IF NOT EXISTS pages (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  website_id         INTEGER NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  url                TEXT    NOT NULL,
  title              TEXT,
  status             TEXT    NOT NULL DEFAULT 'active',
  discovered_at      TEXT    NOT NULL,
  first_content_at   TEXT,
  last_seen_at       TEXT    NOT NULL,
  last_checked_at    TEXT,
  last_changed_at    TEXT,
  published_at       TEXT,
  modified_at        TEXT,
  text_hash          TEXT,
  char_count         INTEGER NOT NULL DEFAULT 0,
  version_count      INTEGER NOT NULL DEFAULT 0,
  baseline_done      INTEGER NOT NULL DEFAULT 0,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  source             TEXT,
  UNIQUE (website_id, url)
);
CREATE INDEX IF NOT EXISTS idx_pages_website ON pages(website_id, status);
CREATE INDEX IF NOT EXISTS idx_pages_changed ON pages(last_changed_at DESC);

CREATE TABLE IF NOT EXISTS page_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id      INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  captured_at  TEXT    NOT NULL,
  text_hash    TEXT    NOT NULL,
  title        TEXT,
  text         TEXT    NOT NULL,
  char_count   INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,
  modified_at  TEXT,
  source       TEXT
);
CREATE INDEX IF NOT EXISTS idx_versions_page ON page_versions(page_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS detected_changes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id           INTEGER REFERENCES pages(id) ON DELETE CASCADE,
  website_id        INTEGER NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  from_version_id   INTEGER REFERENCES page_versions(id) ON DELETE SET NULL,
  to_version_id     INTEGER REFERENCES page_versions(id) ON DELETE SET NULL,
  detected_at       TEXT    NOT NULL,
  change_date       TEXT    NOT NULL,
  change_type       TEXT    NOT NULL,
  priority          TEXT    NOT NULL DEFAULT 'LOW',
  title             TEXT,
  url               TEXT,
  summary           TEXT,
  what_changed      TEXT,
  previous_value    TEXT,
  new_value         TEXT,
  reasoning         TEXT,
  analyzer          TEXT    NOT NULL DEFAULT 'claude',
  model             TEXT,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  cached_tokens     INTEGER NOT NULL DEFAULT 0,
  analysis_input    TEXT,
  analysis_output   TEXT,
  reported_in       INTEGER,
  UNIQUE (to_version_id, page_id)
);
CREATE INDEX IF NOT EXISTS idx_changes_date ON detected_changes(change_date, priority);
CREATE INDEX IF NOT EXISTS idx_changes_website ON detected_changes(website_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_changes_report ON detected_changes(reported_in);

CREATE TABLE IF NOT EXISTS daily_reports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date     TEXT    NOT NULL UNIQUE,
  generated_at    TEXT    NOT NULL,
  window_start    TEXT    NOT NULL,
  window_end      TEXT    NOT NULL,
  total_changes   INTEGER NOT NULL DEFAULT 0,
  high_priority   INTEGER NOT NULL DEFAULT 0,
  medium_priority INTEGER NOT NULL DEFAULT 0,
  low_priority    INTEGER NOT NULL DEFAULT 0,
  websites_total  INTEGER NOT NULL DEFAULT 0,
  websites_quiet  INTEGER NOT NULL DEFAULT 0,
  daily_summary   TEXT,
  payload         TEXT    NOT NULL,
  model           TEXT,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  sent_at         TEXT,
  recipients      TEXT,
  error           TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_date ON daily_reports(report_date DESC);
