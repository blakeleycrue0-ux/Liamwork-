ALTER TABLE detected_changes ADD COLUMN category      TEXT;
ALTER TABLE detected_changes ADD COLUMN draft_message TEXT;
CREATE INDEX IF NOT EXISTS idx_changes_category ON detected_changes(category);
