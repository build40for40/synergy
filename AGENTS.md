# Synergy

Day 4 of 40 for 40, built live on Twitch on Thursday 5 November 2026. The problem is "Cold outreach to founders". Work is tracked on the Superthread `day4` board and the "Day 4" page.

- **Form factor:** a Chrome extension.
- **Data:** the Dealroom API (https://developers.dealroom.co). It uses OAuth client credentials, so it needs two values: the client ID as `DEALROOM_CLIENT_ID` and the client secret as `DEALROOM_API_KEY`. Both go in the ignored `.dev.vars` locally and in Cloudflare secrets in production. Never commit them or paste them into chat.
- **Served at:** https://build40for40.com/synergy/ once the app has a scaffold and CI.

Shared 40 for 40 context lives in `../AGENTS.md`.

## Layout

- **`worker/`:** the `synergy-api` Cloudflare Worker. `dealroom.js` is the Dealroom client (token exchange, `GET /data/companies` with the filter DSL and cursor pages) and the company mapping. `sync.js` pulls up to 2 pages of 50 companies for the profile's filter, daily at 06:07 UTC. `store.js` holds the D1 queries and today's 10 leads. `index.js` serves `GET /health`, `GET|PUT /profile`, `GET /leads/today` and `PATCH /leads/:id` (`reached_out`, `tier`, `notes`).
- **`migrations/`:** the D1 schema: `companies` (typed columns plus `raw_json`, with NULL meaning unknown), `profile` (single row), `leads` (a company is only ever offered once) and `sync_runs`.
- **`extension/`:** a Manifest V3 Chrome extension. The toolbar button opens `dashboard.html` in Chrome's side panel: today's 10, the "did you reach out?" buttons and the About you form. The API base defaults to `http://localhost:8787` and can be changed in the form.
- **`publishing/`:** how the extension reaches the user (card 170): the store build, the unlisted Chrome Web Store route, listing and privacy drafts, release checks and install steps. Start with `publishing/README.md`. Icons are in `extension/icons/`, drawn from `publishing/src/icon.svg`.
- **Companies House:** no separate source for now. Dealroom is believed to include Companies House filings, and `companies.raw_json` keeps the full record, so check which filing fields come back once there are credentials, then promote the useful ones to columns.
- **No auth yet.** The API is single-user and open; add sign-in before it holds anything private.

## Commands

- Node.js 22.13 or later. `npm ci`, then `npm run db:migrate:local`.
- `npm run dev` runs the Worker locally. `curl localhost:8787/__scheduled` triggers a Dealroom sync.
- `npm test`, `npm run check` (tests plus a Wrangler dry run), `npm run extension:package` (the store ZIP in `dist/`: no localhost, dashboard pointed at the live API) and `npm run extension:package:dev` (keeps localhost; never upload). Update `RUNTIME_FILES` in `scripts/package-extension.mjs` when the extension gains files.
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
