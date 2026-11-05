# Release checks

Run these on a **clean Chrome profile** with sample data, never the client's account. Record the Chrome version, the ZIP name, the date and the result for each run.

Chrome 137 and later no longer accept `--load-extension` on the command line, so these checks are manual: unzip the store ZIP, then load the unzipped folder with **Load unpacked**.

| Check | Result | What good looks like |
| --- | --- | --- |
| Package builds | Passed 5 Nov (automated) | `npm run extension:package` succeeds and `test/package.test.js` passes in CI |
| ZIP contents | Passed 5 Nov (automated) | Only the allowlisted files; manifest has no localhost; `DEFAULT_API` is the live service |
| Loads in Chrome | Not run | No errors on `chrome://extensions`; name, version 0.1.0 and icon are correct |
| Icon | Not run | Readable in the toolbar in both light and dark Chrome themes |
| Install prompt | Not run | Asks only for what the extension uses (storage, side panel, the Synergy service) |
| Opens in the side panel | Not run | Toolbar button opens the dashboard in the side panel; it stays open while switching tabs; it's usable at the panel's narrowest width |
| Sign-in | Blocked: not built | Signed out shows the sign-in step only; signed in loads only that user's data |
| Today's leads load | Blocked: live API not deployed | 5 or 10 leads, matching the Settings choice |
| Feedback saves | Blocked: live API not deployed | Sent, Not for me, reply outcomes and notes survive closing and reopening |
| Rollover | Blocked: not built | Unsent leads appear first the next day, marked with their original day |
| Service down | Not run | A plain error; the last list stays on screen |
| Privacy check | Not run | Developer tools Network tab shows requests only to the Synergy service |
| Store install | Store submission pending | Installing from the unlisted link gives the same version as the tested ZIP |
| Update | First release pending | Uploading 0.1.1 updates the installed copy with data intact |

Screenshots for the listing come from this run: 1280×800, browser zoom 100%, sample data only, no personal bookmarks or tabs visible.
