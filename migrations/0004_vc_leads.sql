-- Leads are VC firms. Each one is shown with the partners to contact and the
-- portfolio companies that match the brief. Filled by scripts/vc-pull.mjs.

-- Money on rows from the VC pull is in GBP; earlier rows are USD.
ALTER TABLE companies ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';
-- The newest disclosed round, from /data/companies/{uuid}/funding-rounds.
ALTER TABLE companies ADD COLUMN last_round_date TEXT;
ALTER TABLE companies ADD COLUMN last_round_label TEXT;
ALTER TABLE companies ADD COLUMN last_round_amount REAL;

CREATE TABLE investors (
  uuid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  website TEXT,
  linkedin TEXT,
  dealroom_url TEXT,
  tagline TEXT,
  hq_city TEXT,
  hq_country TEXT,
  investor_types_json TEXT,
  deal_size_min REAL,
  deal_size_max REAL,
  investments_count INTEGER,
  last_investment_date TEXT,
  currency TEXT NOT NULL DEFAULT 'GBP',
  raw_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

-- Current partners from Dealroom. Dealroom rarely has emails, so email is
-- usually NULL; the user's own edits will need their own table.
CREATE TABLE investor_partners (
  investor_uuid TEXT NOT NULL REFERENCES investors(uuid),
  person_uuid TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT,
  linkedin TEXT,
  dealroom_url TEXT,
  email TEXT,
  PRIMARY KEY (investor_uuid, person_uuid)
);

-- A portfolio company that matches the brief, and why.
CREATE TABLE portfolio_matches (
  investor_uuid TEXT NOT NULL REFERENCES investors(uuid),
  company_uuid TEXT NOT NULL REFERENCES companies(uuid),
  is_lead INTEGER,
  rounds_count INTEGER,
  ebitda_over_1m INTEGER NOT NULL,
  series_a_plus INTEGER NOT NULL,
  matched_at TEXT NOT NULL,
  PRIMARY KEY (investor_uuid, company_uuid)
);
CREATE INDEX portfolio_matches_by_company ON portfolio_matches(company_uuid);
