# Synergy

Day 4 of 40 for 40, built live on Twitch on Thursday 5 November 2026. The problem is "Cold outreach to founders". Work is tracked on the Superthread `day4` board and the "Day 4" page.

- **Form factor:** a Chrome extension.
- **Data:** the Dealroom API (https://developers.dealroom.co). It uses OAuth client credentials, so it needs two values: the client ID as `DEALROOM_CLIENT_ID` and the client secret as `DEALROOM_API_KEY`. Both go in the ignored `.dev.vars` locally and in Cloudflare secrets in production. Never commit them or paste them into chat.
- **Served at:** https://build40for40.com/synergy/ once the app has a scaffold and CI.

Shared 40 for 40 context lives in `../AGENTS.md`.

## Layout

- **`worker/`:** the `synergy-api` Cloudflare Worker. `dealroom.js` is the Dealroom client (token exchange, throttling and retries, `GET /data/companies` with the filter DSL and cursor pages, `/financials`) and the company mapping. `store.js` holds the D1 queries and today's 10 leads, ranked by filed positive EBITDA, then no disclosed funding, then headcount growth. `index.js` serves `GET /health`, `GET|PUT /profile`, `GET /leads/today` and `PATCH /leads/:id` (`reached_out`, `tier`, `notes`). There is no cron: the Worker never calls Dealroom.
- **`migrations/`:** the D1 schema: `companies` (typed columns, filed EBITDA and profit, plus `raw_json` and `financials_json`, with NULL meaning unknown), `profile` (single row), `leads` (a company is only ever offered once, created only by `/leads/today`), `sync_runs` (one row per pull) and `sync_state` (the pull's saved list cursor).
- **`scripts/dealroom-pull.mjs`:** the one-off Dealroom pull, run locally with `npm run pull -- --remote --minutes 60`. It lists companies for its filter (default: UK, operational, launched by 2018, 10 to 1,000 people, about 30,000) 500 a page, then fetches financials, best fit first, until the time limit. D1 is the cache: the list resumes from `sync_state` and a company with `financials_fetched_at` is never fetched again. It writes only `companies`, `sync_state` and `sync_runs`, through `wrangler d1 execute` (`--local` by default). About 2 credits a listed company and 23 a financials call, at 4 requests a second.
- **`extension/`:** a Manifest V3 Chrome extension. The toolbar button opens `dashboard.html`: today's 10, the "did you reach out?" buttons and the About you form. The API base defaults to `http://localhost:8787` and can be changed in the form.
- **Companies House:** no separate source. The company list returns no filing fields; filed revenue, EBITDA and profit by year come from `/financials`. Dealroom repeats the last filed figure in later years, so `ebitda_year` and `profit_year` are the first year of that repeated run.
- **No auth yet.** The API is single-user and open; add sign-in before it holds anything private.

## Commands

- Node.js 22.13 or later. `npm ci`, then `npm run db:migrate:local`.
- `npm run dev` runs the Worker locally. `npm run pull -- --minutes 1` pulls from Dealroom into local D1; add `--remote` for Cloudflare, after `npm run db:migrate:remote`.
- `npm test`, `npm run check` (tests plus a Wrangler dry run), `npm run extension:package` (ZIP into `dist/`; update its allowlist when the extension gains files).
- Load the extension unpacked from `extension/` at `chrome://extensions`.
- Run Wrangler as `npm run wrangler -- <args>` (the `40for40` profile). The D1 `database_id` in `wrangler.jsonc` is a placeholder until `npm run wrangler -- d1 create synergy` is run. CI never deploys.

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
