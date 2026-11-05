-- Companies pulled from Dealroom. Typed columns hold what the lead dashboard
-- needs; raw_json keeps the full record so new fields need no re-fetch.
-- NULL always means "Dealroom doesn't say", never zero.
CREATE TABLE companies (
  uuid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT,
  website TEXT,
  linkedin TEXT,
  dealroom_url TEXT,
  tagline TEXT,
  hq_city TEXT,
  hq_country TEXT,
  launch_year INTEGER,
  employees INTEGER,
  employee_growth_1y REAL,
  funding_total REAL,
  funding_rounds INTEGER,
  revenue REAL,
  revenue_year INTEGER,
  status TEXT,
  founders_json TEXT,
  raw_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

-- The input form: who the user is, what they offer and who they want.
-- MVP is single-user, so there is one row with id 1.
CREATE TABLE profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  who TEXT NOT NULL DEFAULT '',
  offer TEXT NOT NULL DEFAULT '',
  looking_for TEXT NOT NULL DEFAULT '',
  dealroom_filter TEXT,
  dealroom_sort TEXT,
  updated_at TEXT NOT NULL
);

-- 10 leads a day. A company is only ever offered once.
CREATE TABLE leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_uuid TEXT NOT NULL UNIQUE REFERENCES companies(uuid),
  lead_date TEXT NOT NULL,
  tier TEXT,
  notes TEXT NOT NULL DEFAULT '',
  reached_out INTEGER CHECK (reached_out IN (0, 1)),
  feedback_at TEXT
);
CREATE INDEX leads_by_date ON leads(lead_date);

-- One row per Dealroom sync, so gaps and failures are visible.
CREATE TABLE sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  companies INTEGER NOT NULL DEFAULT 0,
  credits_used INTEGER,
  error TEXT
);
