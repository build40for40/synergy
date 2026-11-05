# Design

Reference files for Synergy. They aren't part of the Worker or the extension build. Open either one in a browser.

- **`dashboard-prototype.html`:** Samira's clickable prototype of the extension's dashboard (Superthread card 166). Each tab is one user state: onboarding, loading, day 1, day 2, day 3, two weeks in, weekly, history, missed a day, settings, missing data, no leads and error. Every lead is a VC fund with matching portfolio companies. Feedback is Sent?, Not for me (with a reason), and Call / Rejected / No reply. It also has notes, streaks, editable partner contacts, and a choice of 5 or 10 leads a day. It uses Ben's agreed brand, draft 5 (card 173): black and deep sage, ivory text, champagne gold as a thin accent, and the SY monogram. All funds, partners and companies are invented sample data. Live version: https://claude.ai/artifact/SEB1hh5d6X1fHFdXxuZ8Zd
- **`build-map.html`:** a diagram of how the pieces connect (Dealroom → daily sync → D1 → API → Chrome extension → the broker → Claude → the VC partner), what's in the repo, and what's still to build. It's a snapshot from Thu 5 Nov, 14:15.

The prototype is the source of truth for the dashboard's fields and states until the extension's own screens catch up. The API side of its feedback loop is in PR 4.
