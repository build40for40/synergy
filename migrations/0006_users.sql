-- Sign-in (WorkOS): anyone can sign in, and each user gets their own profile, leads,
-- feedback and notes. user_id is the WorkOS user id from the signed access token.
-- Companies, investors and the Dealroom pull stay shared. Each user's matching
-- criteria (criteria_json, from 0004) and leads a day (leads_per_day, from 0005)
-- move with their profile, and the VC lead feedback and streak days from 0005
-- become per user too.
--
-- Rows from before sign-in belong to user_id 'unclaimed', which no token can carry,
-- so they're kept but nobody sees them.

CREATE TABLE profiles (
  user_id TEXT PRIMARY KEY,
  who TEXT NOT NULL DEFAULT '',
  offer TEXT NOT NULL DEFAULT '',
  looking_for TEXT NOT NULL DEFAULT '',
  dealroom_filter TEXT,
  dealroom_sort TEXT,
  criteria_json TEXT,
  leads_per_day INTEGER NOT NULL DEFAULT 10 CHECK (leads_per_day IN (5, 10)),
  updated_at TEXT NOT NULL
);
INSERT INTO profiles (user_id, who, offer, looking_for, dealroom_filter, dealroom_sort, criteria_json, leads_per_day, updated_at)
  SELECT 'unclaimed', who, offer, looking_for, dealroom_filter, dealroom_sort, criteria_json, leads_per_day, updated_at FROM profile;

-- leads.company_uuid was unique across everyone. Each user now gets each company once,
-- so the table is rebuilt with UNIQUE (user_id, company_uuid). Same columns as 0001 + 0003.
CREATE TABLE leads_by_user (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  company_uuid TEXT NOT NULL REFERENCES companies(uuid),
  lead_date TEXT NOT NULL,
  tier TEXT,
  notes TEXT NOT NULL DEFAULT '',
  reached_out INTEGER CHECK (reached_out IN (0, 1)),
  feedback_at TEXT,
  sent_at TEXT,
  dismissed_at TEXT,
  dismiss_reason TEXT,
  outcome TEXT CHECK (outcome IN ('call', 'rejected', 'no_reply')),
  outcome_at TEXT,
  notes_at TEXT,
  UNIQUE (user_id, company_uuid)
);
INSERT INTO leads_by_user (id, user_id, company_uuid, lead_date, tier, notes, reached_out, feedback_at,
    sent_at, dismissed_at, dismiss_reason, outcome, outcome_at, notes_at)
  SELECT id, 'unclaimed', company_uuid, lead_date, tier, notes, reached_out, feedback_at,
    sent_at, dismissed_at, dismiss_reason, outcome, outcome_at, notes_at FROM leads;
DROP TABLE leads;
ALTER TABLE leads_by_user RENAME TO leads;
CREATE INDEX leads_by_user_date ON leads(user_id, lead_date);
CREATE INDEX leads_by_user_outcome ON leads(user_id, outcome);

-- VC lead feedback (0005) was one row per VC for the single user. Each user now
-- has their own row per VC: primary key (user_id, investor_uuid).
CREATE TABLE vc_leads_by_user (
  user_id TEXT NOT NULL,
  investor_uuid TEXT NOT NULL REFERENCES investors(uuid),
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
  contact_at TEXT,
  PRIMARY KEY (user_id, investor_uuid)
);
INSERT INTO vc_leads_by_user (user_id, investor_uuid, first_shown, sent_at, dismissed_at, dismiss_reason, outcome, outcome_at,
    notes, notes_at, contact_name, contact_email, contact_at)
  SELECT 'unclaimed', investor_uuid, first_shown, sent_at, dismissed_at, dismiss_reason, outcome, outcome_at,
    notes, notes_at, contact_name, contact_email, contact_at FROM vc_leads;
DROP TABLE vc_leads;
ALTER TABLE vc_leads_by_user RENAME TO vc_leads;
CREATE INDEX vc_leads_by_user_first_shown ON vc_leads(user_id, first_shown);

-- Streak days, per user.
CREATE TABLE streak_days_by_user (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  PRIMARY KEY (user_id, day)
);
INSERT INTO streak_days_by_user (user_id, day) SELECT 'unclaimed', day FROM streak_days;
DROP TABLE streak_days;
ALTER TABLE streak_days_by_user RENAME TO streak_days;
