-- Leads are VC firms with portfolio companies that match the user's criteria.
--
-- Three layers:
-- 1. Dealroom facts, written only by the pull scripts: companies,
--    company_financials, funding_rounds, investors, investments, investor_team.
--    One row per fact as Dealroom reports it. Nothing here encodes a rule.
-- 2. Preferences: profile.criteria_json, the user's matching rules.
-- 3. Leads: matching is a query over 1 with 2 (worker/criteria.js); what the
--    user did with a lead is stored in leads.

-- The currency of a company's money columns. Rows from the VC pull are GBP;
-- the earlier company pull is USD.
ALTER TABLE companies ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';
-- Set once funding rounds were fetched, so they are not bought twice.
ALTER TABLE companies ADD COLUMN rounds_fetched_at TEXT;

ALTER TABLE profile ADD COLUMN criteria_json TEXT;

-- Filed financials, one row per company and year. Dealroom repeats the last
-- filed figure in later years; carried_forward marks those repeats.
CREATE TABLE company_financials (
  company_uuid TEXT NOT NULL REFERENCES companies(uuid),
  year INTEGER NOT NULL,
  currency TEXT NOT NULL,
  revenue REAL,
  ebitda REAL,
  profit REAL,
  carried_forward INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (company_uuid, year)
);

-- Every disclosed round, including debt, grants and exits (IPO, acquisition).
CREATE TABLE funding_rounds (
  id INTEGER PRIMARY KEY,
  company_uuid TEXT NOT NULL REFERENCES companies(uuid),
  announced_date TEXT,
  round_type TEXT,
  standardized_round TEXT,
  amount REAL,
  currency TEXT NOT NULL,
  is_exit INTEGER,
  is_vc_round INTEGER,
  fetched_at TEXT NOT NULL
);
CREATE INDEX funding_rounds_by_company ON funding_rounds(company_uuid, announced_date);

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
  currency TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

-- Which investor backed which company (Dealroom's portfolio list).
CREATE TABLE investments (
  investor_uuid TEXT NOT NULL REFERENCES investors(uuid),
  company_uuid TEXT NOT NULL REFERENCES companies(uuid),
  is_lead INTEGER,
  rounds_count INTEGER,
  last_round_date TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (investor_uuid, company_uuid)
);
CREATE INDEX investments_by_company ON investments(company_uuid);

-- People at an investor, as Dealroom lists them. Dealroom has duplicate
-- person records; reads keep one per name. Emails are rare.
CREATE TABLE investor_team (
  investor_uuid TEXT NOT NULL REFERENCES investors(uuid),
  person_uuid TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT,
  linkedin TEXT,
  dealroom_url TEXT,
  email TEXT,
  is_partner INTEGER,
  is_past INTEGER,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (investor_uuid, person_uuid)
);
