# Synergy

Day 4 of 40 for 40, built live on Twitch on Thursday 5 November 2026. The problem is "Cold outreach to founders". Work is tracked on the Superthread `day4` board and the "Day 4" page.

- **Form factor:** a Chrome extension.
- **Data:** the Dealroom API (https://developers.dealroom.co). It uses OAuth client credentials, so it needs two values: the client ID as `DEALROOM_CLIENT_ID` and the client secret as `DEALROOM_API_KEY`. Both go in the ignored `.dev.vars` locally and in Cloudflare secrets in production. Never commit them or paste them into chat.
- **Served at:** https://build40for40.com/synergy/ once the app has a scaffold and CI.

Shared 40 for 40 context lives in `../AGENTS.md`.

## Layout

- **`worker/`:** the `synergy-api` Cloudflare Worker. `dealroom.js` is the Dealroom client (token exchange, throttling and retries, `GET /data/companies` with the filter DSL and cursor pages, `/financials`) and the company mapping. `store.js` holds the D1 queries and today's 10 leads, ranked by filed positive EBITDA, then no disclosed funding, then headcount growth. `criteria.js` holds the matching rules and the query that applies them; `vcs.js` builds VC leads from it. `index.js` serves `GET /health`, `GET /vcs` (VC leads under the profile's criteria), `GET|PUT /profile` (including `criteria`), `GET /leads/today`, `GET /leads` (history: `status=all|new|waiting|call|closed|not_for_me`, `limit`, `before`) and `PATCH /leads/:id` (`sent`, `not_for_me` + `reason`, `outcome` = `call|rejected|no_reply`, `notes`, plus the original `reached_out` and `tier`). Each lead comes back with a `status`: `new`, `sent`, `call`, `rejected`, `no_reply` or `not_for_me`. There is no cron: the Worker never calls Dealroom.
- **`migrations/`:** the D1 schema, in three layers (see `0004_vc_leads.sql`):
  - **Dealroom facts**, written only by the pull scripts, one row per fact, nothing encoding a rule: `companies` (typed columns plus `raw_json`, NULL meaning unknown, `currency` for its money columns), `company_financials` (one row per year; `carried_forward` marks Dealroom repeating the last filing), `funding_rounds` (every round, including debt and exits), `investors`, `investments` (who backed whom) and `investor_team`.
  - **Preferences:** `profile`, single row, with `criteria_json`: the user's matching rules as data (`worker/criteria.js`: countries, launched by, headcount, growing, no raise for N months, exclude exits, and EBITDA over £X in the last N years OR a Series A or later). `null` switches a rule off.
  - **Leads:** matching is computed from facts and criteria on every read, never stored. What the user did is stored in `leads` (offered once, never deleted, with sent, not-for-me, outcome and notes from `0003_feedback.sql`). `leads` still points at companies; moving it to VCs (`investor_uuid`) is the next schema change.
  - Pull bookkeeping: `sync_runs` and `sync_state`.
- **`scripts/dealroom-pull.mjs`:** the one-off Dealroom pull, run locally with `npm run pull -- --remote --minutes 60`. It lists companies for its filter (default: UK, operational, launched by 2018, 10 to 1,000 people, about 30,000) 500 a page, then fetches financials, best fit first, until the time limit. D1 is the cache: the list resumes from `sync_state` and a company with `financials_fetched_at` is never fetched again. It writes only `companies`, `sync_state` and `sync_runs`, through `wrangler d1 execute` (`--local` by default). About 2 credits a listed company and 23 a financials call, at 4 requests a second.
- **`scripts/vc-pull.mjs`** (`npm run vc:pull -- --vcs 10`, `--remote` for Cloudflare): stores VC facts. It takes UK and Spanish VCs best-ranked first, in turn by country, and stores every portfolio company in the UK or Spain that is operational, not exited or PE-owned, with 10 or more people, with all its rounds and filed financials in GBP, plus each VC's partners. That set is the outer bound of what criteria can match. It stops once `--vcs` VCs have a match under the default criteria. Cached: a stored VC isn't pulled again, and a GBP company with rounds and financials isn't bought again. About 600 credits a VC.
- **Side panel API (`worker/vc-leads.js`):** `GET /vcs/today` (today's 5 or 10 VC leads: unsent ones roll over oldest first, then new VCs; plus `in_play` and the `streak`), `PATCH /vcs/:uuid` (`sent`, `not_for_me` + `reason`, `outcome`, `notes`, `contact_name`, `contact_email`) and `GET /vcs/history?status=all|waiting|call|closed|not_for_me`. Migration `0005_vc_lead_feedback.sql` adds `vc_leads`, `streak_days` and `profile.leads_per_day`.
- **`extension/` screens:** Today (streak, Any replies?, the list, In play), History and Settings (also first-run onboarding), following `design/dashboard-prototype.html`.
- **`extension/`:** a Manifest V3 Chrome extension. The toolbar button opens `dashboard.html` in Chrome's side panel: today's 10, the "did you reach out?" buttons and the About you form. The API base defaults to `http://localhost:8787` and can be changed in the form.
- **`publishing/`:** how the extension reaches the user (card 170): the store build, the unlisted Chrome Web Store route, listing and privacy drafts, release checks and install steps. Start with `publishing/README.md`. Icons are in `extension/icons/`, drawn from `publishing/src/icon.svg`.
- **Companies House:** no separate source. The company list returns no filing fields; filed revenue, EBITDA and profit by year come from `/financials`. Dealroom repeats the last filed figure in later years, so `ebitda_year` and `profit_year` are the first year of that repeated run.
- **No auth yet.** The API is single-user and open; add sign-in before it holds anything private.

## Commands

- Node.js 22.13 or later. `npm ci`, then `npm run db:migrate:local`.
- `npm run db:seed:ui` replaces local leads, companies and VC data with `test/fixtures/ui-vcs.sql`: facts for 13 real UK and Spanish VCs and their 334 UK and Spanish portfolio companies. Under the default criteria that's 10 VC leads (`GET /vcs`). Local only. Regenerate it from local D1 with `node scripts/export-ui-fixture.mjs` (it blanks `raw_json` to keep the file small).
- `npm run dev` runs the Worker locally. `npm run pull -- --minutes 1` pulls from Dealroom into local D1; add `--remote` for Cloudflare, after `npm run db:migrate:remote`.
- `npm test`, `npm run check` (tests plus a Wrangler dry run), `npm run extension:package` (the store ZIP in `dist/`: no localhost, dashboard pointed at the live API) and `npm run extension:package:dev` (keeps localhost; never upload). Update `RUNTIME_FILES` in `scripts/package-extension.mjs` when the extension gains files.
- Load the extension unpacked from `extension/` at `chrome://extensions`.
- Run Wrangler as `npm run wrangler -- <args>` (the `40for40` profile). The remote D1 database is `synergy` (created 5 November 2026). CI never deploys.

## The problem

Finding the right founders to talk to is slow, manual work, and nobody enjoys it. Cold outreach from strangers rarely lands, especially for something as personal as selling or growing a business. Someone who originates deals needs a short list of the right companies to approach each day, and a reason to approach each one.

## What we're building

A personal lead generation engine that gets smarter as it's used: a Chrome extension with a dashboard of 10 leads a day and a yes or no feedback loop.

- **Input form:** who the user is, what they offer and who they're looking for.
- **Leads:** search Dealroom against the user's criteria, such as growing, established, cash generative and not recently funded, with Companies House filings as a qualifier.
- **Dashboard:** 10 leads a day, with notes and tiers.
- **Feedback (MVP):** "did you reach out? yes or no". Smarter feedback comes later.
- **Post-MVP:** warm paths through LinkedIn connections and referrals.
- **Open question:** start from the user's network or from a Dealroom search.
- Keep the MVP small and cut anything excessive.

## Guiding ideas

- Good moments to reach out: succession, expansion, or debt that needs refinancing.
- Spam is the bad version of this. Warm, trusted, relevant approaches work far better.
- It's a numbers game, so the daily question is "did you do your 10?"
- Data has gaps, in Dealroom and elsewhere, so leads should show what's known and what isn't.
