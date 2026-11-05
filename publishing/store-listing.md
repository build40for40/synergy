# Chrome Web Store listing (draft)

Draft copy for the dashboard fields, 5 November 2026. Check every line against the build you upload: it describes the product on card 166 (VC leads), not the founder-company scaffold now in `extension/`. Never name the client or their firm.

## Store listing tab

- **Name:** Synergy
- **Summary (132 characters max, same as the manifest description):** A few VCs a day whose portfolio companies are ready for an exit, with the reasons why and a prompt for the first email.
- **Category:** Productivity. Pick the closest sub-category in the dashboard (Workflow & Planning).
- **Language:** English (UK)
- **Homepage:** https://build40for40.com/synergy/
- **Support:** help@build40for40.com

**Description:**

> Prospecting is a numbers game, and nobody enjoys it. Synergy gives you a short list every morning: 5 or 10 VC funds, each holding profitable portfolio companies that look ready for an exit.
>
> For each fund you get:
> - The partner to contact, with links to their website, LinkedIn and recent news.
> - The matching portfolio companies: revenue, EBITDA, growth, when they last raised, and why now might be the moment.
> - A prompt to paste into Claude to draft a first email.
>
> Tell it how you got on with three taps: Sent, Not for me, and whether they replied. Leads you don't get to roll over to tomorrow. Keep a streak going, look back at every lead in History, and review the week.
>
> Data comes from Dealroom. Where a figure isn't public, Synergy says so instead of guessing.
>
> Built live by 40 for 40.

**Graphics:** icon `extension/icons/icon-128.png`. At least one screenshot at 1280×800 (or 640×400), JPEG or 24-bit PNG with no transparency, taken from the installed extension on a clean profile with sample data only. Optional: small promo tile 440×280.

## Privacy tab

**Single purpose:** Show a short daily list of VC leads, with the information needed to contact them, and record what the user did with each one.

**Permission reasons:**

- `storage`: remembers the address of the Synergy service on this device.
- `sidePanel`: shows the dashboard in Chrome's side panel when the user clicks the toolbar button.
- (When sign-in returns) `identity`: opens the sign-in page in Chrome's own sign-in window, so each user's leads and notes are kept to their account.
- (When sign-in returns) Host permission for `https://api.workos.com/*`: completes sign-in and keeps the user signed in (WorkOS is the sign-in provider). Only the sign-in code and tokens are sent.
- Host permission for `https://synergy-api.40for40.workers.dev/*`: the dashboard loads today's leads from the Synergy service and saves the user's profile, feedback and notes to it. No other site is contacted, and no page the user visits is read.

**Remote code:** No. All code is in the package. The service returns JSON data only.

**Data usage**, to confirm against the final build before ticking:

- **Personally identifiable information:** yes. The name, firm and description the user types into "About you" are sent to and stored by the Synergy service.
- **User activity:** yes. Which leads were sent, dismissed (with an optional reason), replied to or booked, with dates.
- **Personal communications, website content, web history, location, health, financial, authentication:** no, provided sign-in is via Google and the extension never sees a password. Revisit if that changes.
- The three certifications (not sold, not used for unrelated purposes, not used for creditworthiness) are true for this design. Read Chrome's wording before accepting.

**Privacy policy URL:** https://build40for40.com/privacy/, once it has a Synergy section (see `privacy.md`).

## Test instructions for reviewers

> Click the Synergy toolbar button. The dashboard opens in Chrome's side panel. Sign in with the test account below. Today's leads load from the Synergy service. Open a lead to see its portfolio companies and the email prompt. Mark one as Sent, mark another as Not for me, and use History to see both.
>
> Test account: [create a reviewer account with sample leads before submitting; never use the client's account].

## Distribution tab

- Visibility: **Unlisted**
- Price: free
- Regions: all, or limited to the UK and the second territory
- Publishing: manual, after approval
