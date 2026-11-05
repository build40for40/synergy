# Publishing the Chrome extension

How Synergy goes from `extension/` to something the user installs. This follows what we did for the Naughty List on Day 3 (`build40for40/naughty-list`, `publishing/`), cut down to what a single-user tool needs. Superthread card: **170, Chrome extension: package and publish for easy download**.

Prepared 5 November 2026. The client stays anonymous in everything under this folder.

## Build the package

```sh
npm run extension:package        # dist/synergy-chrome-<version>.zip, the one you upload
npm run extension:package:dev    # dist/synergy-chrome-<version>-dev.zip, keeps localhost, never upload
```

The store build differs from `extension/` in two ways, so the person installing it gets a working dashboard with nothing to set up:

- `http://localhost:8787/*` is removed from `host_permissions`.
- The dashboard's `DEFAULT_API` points at `https://synergy-api.40for40.workers.dev`. Set `SYNERGY_API_URL` to build against a different https origin.

The script uses an explicit allowlist (`RUNTIME_FILES` in `scripts/package-extension.mjs`). A new file in `extension/` stops the build until someone adds it to the list, so backend code, notes and secrets can't slip into the ZIP. It also fails if the manifest would be rejected by the store (version, description over 132 characters, missing icons) or if `DEFAULT_API` stops matching the line it rewrites. `test/package.test.js` covers all of this and runs in CI.

Check a package before uploading:

```sh
unzip -l dist/synergy-chrome-0.1.0.zip
unzip -p dist/synergy-chrome-0.1.0.zip manifest.json
```

## Distribution route

**Recommended: an unlisted Chrome Web Store item**, under the 40 for 40 Ltd developer account Ben set up on Day 3 (the account fee is already paid).

- The user installs from one link with one click. No developer mode, no unzipping.
- Chrome updates it automatically when we upload a new version.
- Unlisted means it doesn't appear in search; only people with the link can find it.
- It still goes through review. Day 3's review took longer than a day, so it won't be live on the day we submit.

**Same-day fallback: a direct download.** Send the store ZIP and the steps in `install.md`. It works today, but it needs Chrome's developer mode, Chrome shows a warning banner, and every update means sending a new ZIP. Use it to get the user going while review runs, not as the long-term route.

## Submit to the Chrome Web Store

The same steps as card 153 on Day 3, in order:

1. Build: `npm run extension:package`. Check the ZIP as above.
2. Open the [developer dashboard](https://chrome.google.com/webstore/devconsole) on the 40 for 40 Ltd account. Choose **Add new item** and upload the ZIP.
3. **Store listing:** paste from `store-listing.md`. Upload the 128px icon (`extension/icons/icon-128.png`) and at least one real 1280×800 screenshot of the installed extension (see `testing.md`). No prototype or concept images.
4. **Privacy:** paste the single purpose, permission reasons and data answers from `store-listing.md`. Add the privacy policy URL.
5. **Distribution:** visibility **Unlisted**, free, all regions (or the UK and the second territory only).
6. **Test instructions:** from `store-listing.md`. Reviewers need a working API with sample leads.
7. Submit for review with **manual publishing**, so we choose when it goes live.
8. After approval: publish, install from the store link on a clean Chrome profile, and repeat the checks in `testing.md` against the store build.
9. Send the user the store link and the "From the Chrome Web Store" steps in `install.md`.

Later versions: bump `version` in `extension/manifest.json`, build, upload to the same item. Never create a second item; the item ID is the extension's identity.

## Blockers before submitting

The packaging is ready. The product behind it isn't yet:

1. **No sign-in.** The API is open: anyone with the address can read and change the profile and leads. Don't submit, or send the direct download, until the API checks who's calling. The prototype on card 166 assumes Google sign-in.
2. **The live API isn't running.** The D1 `database_id` is still a placeholder, and the Dealroom key has no API access yet (card 172). The store build points at a Worker that isn't deployed.
3. **No privacy policy for Synergy.** Unlike the Naughty List, this stores personal data on our server (the user's name, firm and pitch, plus their notes and outcomes on each lead). Add a Synergy section to https://build40for40.com/privacy/ (site repo) before submitting. Draft facts are in `privacy.md`.
4. **Screenshots.** Take them from the installed extension once the dashboard follows the card 166 prototype. The current dashboard still shows founder-company leads.
## Where the dashboard opens

**Chrome's side panel**, decided with Samira on 5 November (card 170). The toolbar button opens the dashboard on the right of whatever page he's on, so he can read a fund's site or LinkedIn next to his leads. That's why the prototype on card 166 is phone-width.

- `manifest.json`: the `sidePanel` permission, `side_panel.default_path` set to `dashboard.html`, and `minimum_chrome_version` 116.
- `background.js` calls `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`. This also removed the old new-tab code, which opened a fresh tab on every click.
- The package check fails if the side panel page isn't in the allowlist or the permission is missing.

## References

- [Chrome Web Store: publish](https://developer.chrome.com/docs/webstore/publish)
- [Chrome Web Store: distribution and visibility](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)
- [Chrome Web Store: images](https://developer.chrome.com/docs/webstore/images)
- [User data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- [Manifest reference](https://developer.chrome.com/docs/extensions/reference/manifest)
- [Side panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
