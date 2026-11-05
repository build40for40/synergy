-- Feedback on VC leads, for the side panel (card 166). A lead is a VC firm;
-- the user contacts a partner there. One row per VC once it has been shown.
-- Rows are never deleted.
--
-- first_shown      the day the VC first appeared in the user's list (YYYY-MM-DD).
--                  Unsent leads stay in the list, oldest first, until handled.
-- sent_at          when the user marked it sent (NULL = not sent)
-- dismissed_at     when the user marked it "not for me", with dismiss_reason
-- outcome          after sending: call, rejected or no_reply (NULL = waiting)
-- contact_name     the user's own partner name and email. They override
-- contact_email    Dealroom's values and are never touched by a pull.
CREATE TABLE vc_leads (
  investor_uuid TEXT PRIMARY KEY REFERENCES investors(uuid),
  first_shown TEXT NOT NULL,
  sent_at TEXT,
  dismissed_at TEXT,
  dismiss_reason TEXT,
  outcome TEXT CHECK (outcome IN ('call', 'rejected', 'no_reply')),
  outcome_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  notes_at TEXT,
  contact_name TEXT,
  contact_email TEXT,
  contact_at TEXT
);
CREATE INDEX vc_leads_by_first_shown ON vc_leads(first_shown);

-- Working days on which every lead in the list was sent or dismissed. The
-- streak is the run of consecutive working days in here.
CREATE TABLE streak_days (
  day TEXT PRIMARY KEY
);

-- 5 or 10 leads a day, the user's choice.
ALTER TABLE profile ADD COLUMN leads_per_day INTEGER NOT NULL DEFAULT 10 CHECK (leads_per_day IN (5, 10));
