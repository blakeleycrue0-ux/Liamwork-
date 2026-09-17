CREATE TABLE IF NOT EXISTS crawl_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at     TEXT    NOT NULL,
  finished_at    TEXT,
  status         TEXT    NOT NULL DEFAULT 'running',
  origin         TEXT    NOT NULL DEFAULT 'automatico',
  websites       INTEGER NOT NULL DEFAULT 0,
  pages_seen     INTEGER NOT NULL DEFAULT 0,
  pages_changed  INTEGER NOT NULL DEFAULT 0,
  analyzed       INTEGER NOT NULL DEFAULT 0,
  relevant       INTEGER NOT NULL DEFAULT 0,
  ignored        INTEGER NOT NULL DEFAULT 0,
  drafts         INTEGER NOT NULL DEFAULT 0,
  websites_failed INTEGER NOT NULL DEFAULT 0,
  errors         TEXT,
  duration_ms    INTEGER NOT NULL DEFAULT 0,
  slack_sent     INTEGER NOT NULL DEFAULT 0,
  slack_error    TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON crawl_runs(started_at DESC);

ALTER TABLE detected_changes ADD COLUMN run_id            INTEGER;
ALTER TABLE detected_changes ADD COLUMN slack_notified_at TEXT;
CREATE INDEX IF NOT EXISTS idx_changes_run ON detected_changes(run_id);
