-- Where the daily sync got to, so the next run continues down the same
-- Dealroom result list instead of re-buying the first pages every day.
-- Single row. When the filter or sort changes, the cursor is discarded.
CREATE TABLE sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  filter TEXT NOT NULL,
  sort TEXT NOT NULL,
  next_cursor TEXT,
  updated_at TEXT NOT NULL
);
