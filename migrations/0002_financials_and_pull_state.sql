-- More of each Dealroom record as typed columns, and filed financials from
-- GET /data/companies/{uuid}/financials. NULL still means unknown.
ALTER TABLE companies ADD COLUMN about TEXT;
ALTER TABLE companies ADD COLUMN industries_json TEXT;
ALTER TABLE companies ADD COLUMN classifications_json TEXT;
ALTER TABLE companies ADD COLUMN signal_rating REAL;
ALTER TABLE companies ADD COLUMN monthly_visits INTEGER;
ALTER TABLE companies ADD COLUMN is_hiring INTEGER;
ALTER TABLE companies ADD COLUMN open_jobs INTEGER;
ALTER TABLE companies ADD COLUMN valuation REAL;
ALTER TABLE companies ADD COLUMN ebitda REAL;
ALTER TABLE companies ADD COLUMN ebitda_year INTEGER;
ALTER TABLE companies ADD COLUMN profit REAL;
ALTER TABLE companies ADD COLUMN profit_year INTEGER;
ALTER TABLE companies ADD COLUMN financials_json TEXT;
-- Set once financials were requested, even when Dealroom had none, so a
-- company is never paid for twice.
ALTER TABLE companies ADD COLUMN financials_fetched_at TEXT;

-- Where the Dealroom pull got to in its company list, so a rerun with the
-- same filter and sort continues instead of re-buying pages. A NULL cursor
-- with done = 1 means the whole list is stored.
CREATE TABLE sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  filter TEXT NOT NULL,
  sort TEXT NOT NULL,
  next_cursor TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
