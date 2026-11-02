# Release test plan

What to check before and after a release (`docs/RELEASING.md`). **Auto** rows run in CI (`npm test`,
`npm run lint`) on every pull request and in the Release workflow; **Manual** rows need a person and a browser.

| # | Area | How | Type | Expected |
|---|---|---|---|---|
| 1 | Development endpoints | `test/release.test.js` › build config (development) | Auto | File default `http://localhost:8080`; `LAMISS_API_URL` / `LAMISS_GOOGLE_CLIENT_ID` override; `ws(s)` derived. |
| 2 | Staging endpoints | `test/release.test.js` › staging/production | Auto | Only the file; `https` + public host + client ID required; overrides refused. |
| 3 | Production endpoints | same, plus › package | Auto | As 2; manifest without `"key"`; host permissions exactly YouTube + backend. |
| 4 | Invalid endpoints | › build config, › runtime | Auto | Malformed, path, credentials, http, localhost and private IPs are refused at build. At runtime an insecure or mismatched address is never called (no token sent). |
| 5 | Unreachable backend | Stop the backend, use the extension | Manual | Popup: "Lamiss can't be reached right now"; chat: "Could not reach Lamiss at …". Nothing hangs. |
| 6 | REST connectivity | Staging or Unlisted build: sign in, open each popup view, ask in the chat | Manual | Preferences, voices, recent videos and answers load; no CORS errors in the service worker console. |
| 7 | WebSocket connectivity | Start Learning on a captioned video, watch until a question | Manual | Countdown appears; question asked and spoken; answer gets feedback; reconnects after toggling the network. |
| 8 | Authentication and session | Sign in, sign out, let the session expire | Manual | Sign-in window opens and returns; sign-out clears the popup; expiry asks to sign in again. Store version needs its ID in OAuth/CORS. |
| 9 | Runtime overrides | n/a | — | Not implemented on purpose (`RELEASING.md` §1): nothing to persist. |
| 10 | Manifest and permissions | `test/release.test.js` › validator; `npm run package:production` | Auto | Every rule in `scripts/lib/validate-package.js` passes; the validator catches the planted errors. |
| 11 | Package integrity | › reproducible ZIP; release `.sha256` | Auto + Manual | Two builds give the same SHA-256; `unzip -t` reports no errors; the release asset's hash equals a local build of the tag. |
| 12 | Install from ZIP | Unzip, **Load unpacked** (staging ZIP for working sign-in) | Manual | Loads without errors or warnings on `chrome://extensions`; icon, popup, YouTube button work. |
| 13 | Install from Unlisted store release | Install from the item's link in a clean Chrome profile | Manual | Installs; permissions dialog lists only YouTube and the backend host; rows 6–8 and 14 pass. |
| 14 | YouTube integration | Popup e2e (`node scripts/popup-e2e.js`) + a real video with captions | Auto (stubbed) + Manual | Button, chat panel, questions, captions in the spoken language, Resume from Recent videos. |
| 15 | Netflix integration | — | n/a | **Not supported:** the extension has no Netflix code (content script matches only `www.youtube.com`). Nothing to regress. |
| 16 | Disney+ integration | — | n/a | **Not supported**, as 15. |
| 17 | Updates and upgrades | Install version N from the store, publish N+1 | Manual | Chrome updates within hours; signed-in session survives or asks to sign in again; settings in `chrome.storage.local` (devices, app language, question settings) are kept. |
| 18 | Store upload script | `test/release.test.js` › chrome web store | Auto (fake API) | Draft upload only by default; waits for processing; submits only with `--publish`; stops on missing credentials or rejections. First real run: upload only (`RELEASING.md` §6). |

Record the manual results (version, date, tester, pass/fail, notes) in the release's GitHub Release notes.
