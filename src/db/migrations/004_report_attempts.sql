-- Every attempt to send the daily report, kept for ever.
-- Append-only: nothing updates or deletes a row, so a failed automatic send
-- is still visible after somebody presses "Enviar ahora".
CREATE TABLE IF NOT EXISTS report_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date  TEXT    NOT NULL,
  attempted_at TEXT    NOT NULL,
  origin       TEXT    NOT NULL,
  outcome      TEXT    NOT NULL,
  reason       TEXT,
  changes      INTEGER NOT NULL DEFAULT 0,
  recipients   TEXT,
  message_id   TEXT
);
CREATE INDEX IF NOT EXISTS idx_report_attempts_at ON report_attempts(attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_attempts_date ON report_attempts(report_date DESC);
