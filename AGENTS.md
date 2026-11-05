# Synergy

Day 4 of 40 for 40, built live on Twitch on Thursday 5 November 2026. The problem is "Cold outreach to founders". Work is tracked on the Superthread `day4` board and the "Day 4" page.

- **Form factor:** a Chrome extension.
- **Data:** the Dealroom API. The key goes in the ignored `.dev.vars` as `DEALROOM_API_KEY` locally and in a Cloudflare secret in production. Never commit it or paste it into chat.
- **Served at:** https://build40for40.com/synergy/ once the app has a scaffold and CI.

Shared 40 for 40 context lives in `../AGENTS.md`.

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
