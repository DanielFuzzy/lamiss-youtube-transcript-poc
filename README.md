# Lamiss Chrome extension

Practice a language while you watch YouTube: Lamiss asks you questions about the
video and answers yours, by voice or text. Manifest V3, plain TypeScript
(`tsc` + `scripts/build.js`, no bundler). It talks to the Lamiss backend
(`DanielFuzzy/Lamiss`).

Users sign in with Google. The design and the API contract are in
[TDR-0001: Google Authentication](https://github.com/DanielFuzzy/Lamiss/blob/main/docs/TDR-0001-Google-Authentication.md).

## Build

Requires Node.js 24.

```sh
npm ci
LAMISS_API_URL=http://localhost:8080 \
LAMISS_GOOGLE_CLIENT_ID=<your-client-id>.apps.googleusercontent.com \
npm run build
```

The variables can also go in a `.env` file next to `package.json` (git-ignored),
one `KEY=value` per line; then a plain `npm run build` or `npm test` uses them.
Variables set in the environment take precedence.

| Variable | Default | Purpose |
|---|---|---|
| `LAMISS_API_URL` | `config/environments.json` (`http://localhost:8080`) | Backend origin (scheme, host, optional port). Written to `compiled/shared/lamiss-config.js` and added to the manifest's host permissions. The WebSocket URL is derived from it (`http` → `ws`, `https` → `wss`). |
| `LAMISS_GOOGLE_CLIENT_ID` | none | Public client ID of the Google OAuth client below. Without it the build prints a warning and sign-in does not work. |

The client ID is public. No client secret is needed, and none may be added to
this repository or to the build.

`compiled/` is the unpacked extension. It is build output and is not committed.

These variables only apply to **development** builds. Each environment's backend
(development, staging, production) is set in `config/environments.json`; the
staging and production packages for testers and the Chrome Web Store are made
with `npm run package:staging` / `npm run package:production` and never read
`.env`. See [docs/RELEASING.md](docs/RELEASING.md) for endpoints, packaging, the
Chrome Web Store and the Release workflow, and [docs/TEST-PLAN.md](docs/TEST-PLAN.md).

## Load the extension

1. Build (see above).
2. Open `chrome://extensions`, turn on **Developer mode**.
3. **Load unpacked** and pick the `compiled/` folder.

The manifest has a fixed `key`, so the extension ID is always:

```
fjjelpamfjfkndcgjdfmkjglkimhokec
```

The redirect URI for Google sign-in is then:

```
https://fjjelpamfjfkndcgjdfmkjglkimhokec.chromiumapp.org/
```

The private key that matches the manifest `key` is only needed to pack a
`.crx`. It is kept outside the repository (for example
`~/.lamiss/extension-dev-key.pem`) and must never be committed. Loading the
extension unpacked doesn't need it.

## Google OAuth client

Do this once per Google Cloud project:

1. In Google Cloud Console, go to **APIs & Services → OAuth consent screen**
   and configure it (scopes `openid`, `email`, `profile`).
2. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**.
3. Application type: **Web application** (not "Chrome extension": the extension
   uses `chrome.identity.launchWebAuthFlow`, which needs a web client).
4. Under **Authorized redirect URIs**, add
   `https://fjjelpamfjfkndcgjdfmkjglkimhokec.chromiumapp.org/`.
5. Copy the client ID. The extension build takes it as
   `LAMISS_GOOGLE_CLIENT_ID`. The backend takes the same value as
   `GOOGLE_CLIENT_ID`.

The backend must also allow the extension's origin for CORS:
`LAMISS_CORS_ALLOWED_ORIGINS=chrome-extension://fjjelpamfjfkndcgjdfmkjglkimhokec`.

## How sign-in works

- The background worker runs the sign-in. It gets a nonce from
  `POST /api/auth/nonce`, opens Google with `launchWebAuthFlow`
  (`response_type=id_token`, a random `state`), checks the returned state, and
  exchanges the ID token at `POST /api/auth/google` for a Lamiss access token.
- The access token is kept only in `chrome.storage.session`, which content
  scripts can't read and which Chrome clears when the browser closes. After a
  restart the worker tries a silent sign-in (`prompt=none`). If that fails, the
  popup, the in-page Lamiss button and the chat show **Sign in with Google**.
- Every backend call sends `Authorization: Bearer <token>`. A `401` ends the
  local session ("Please sign in again"), and the call is not retried.
- The live-questions WebSocket uses a single-use ticket from
  `POST /api/auth/ws-ticket`. Close code `4401` ends the local session.
- **Sign out** (popup) calls `POST /api/auth/logout`, then forgets the token and
  any unanswered questions and closes live connections. The local sign-out
  still happens if the backend can't be reached.

## The popup

The toolbar popup (TDR-0002,
[docs/TDR-0002-Settings-Popup.md](https://github.com/DanielFuzzy/Lamiss/blob/main/docs/TDR-0002-Settings-Popup.md))
has a home view and one view per settings category, each with a back arrow:

- **Home**: **Start Learning** sends `lamiss:start-learning` to the active
  YouTube tab, which runs the same flow as the in-page Lamiss button (or opens
  the chat if Lamiss is already on). The status line comes from the sign-in,
  `GET /api/auth/me` (is the backend reachable), the active tab, and the tab's
  answer to `lamiss:page-status`. The content script only accepts both
  messages from this extension's own pages. Signed out, the popup shows
  **Sign in with Google** and Tutor Behavior / Profile & Account are disabled.
  With a daily goal set, a compact "12 of 30 min today" bar sits under Start
  Learning (`GET /api/me/practice/today`); without one it is hidden.
- **Recent videos** (TDR-0004,
  [docs/TDR-0004-Recent-Videos.md](https://github.com/DanielFuzzy/Lamiss/blob/main/docs/TDR-0004-Recent-Videos.md)):
  the videos studied with Lamiss, most recent first (`GET /api/me/recent-videos`),
  each with its thumbnail, title and when it was last studied. Where playback
  stopped (a thin grey bar, "Stopped at 3:05 of 10:12") and the learning
  progress (a pink "4 questions answered" badge) are shown apart: neither means
  the video was finished. **Resume** opens the video at that position in a new
  tab (only `https://www.youtube.com/watch` addresses). It has loading, empty and
  error (**Try again**) states, and needs the account.
- **Double Captions**: "Coming soon"; there is nothing to switch on yet.
- **Audio & Voice**: microphone and speaker (with a level-meter microphone test
  and a test tone), tutor voice (`GET /api/speech/voices`, filtered to the
  learning language), **Preview voice**, speaking speed, and volume.
- **Tutor Behavior**: kindness, question frequency, response length,
  encouragement, **Tutor language** (`tutorLanguage`; see Languages below), and
  **Auto-pause for questions** (`tutor.autoPause`; see below).
- **Profile & Account**: name, email and picture from `/api/auth/me` (read-only:
  Google refreshes them at every sign-in). Clicking the profile row edits the
  username (3–20 of `A–Z a–z 0–9 _`, checked before sending) with
  `PATCH /api/me/profile`; `400 invalid_username` and `409 username_taken` show
  a plain message in the form. Native and learning language, level,
  **Learning goal** (Not set, Conversation, Vocabulary, Grammar, Listening,
  Pronunciation), **Daily goal** (a slider: Off or 5–240 min) with today's
  progress, and **Log Out**. "Today" is the browser's local day: the popup sends
  `Intl.DateTimeFormat().resolvedOptions().timeZone` as `?timeZone=`.

Only Double Captions (and the tutor's tone for the pre-generated questions,
which all users of a video share) are still to come.

**Auto-pause.** On (the default), the backend sends `PAUSE_VIDEO` before each
question and `RESUME_VIDEO` after the feedback, and the video stays paused
while the question is open, as before. Off, neither is sent: the content script
keeps the question card open over the playing video and lowers the video's
volume to 20% (never raising a quieter one) while Lamiss asks, listens, checks
the answer and reads the feedback, then puts the user's volume back (also when
the card closes, the user leaves the video, or an error ends the spoken
answer). If the user changes the volume meanwhile, theirs is kept. With nothing
to resume, the card closes by itself a few seconds after the feedback (or on
**Close**), and a video the user paused stays paused. The content script holds
the video paused only for a question that `PAUSE_VIDEO` announced, and keeps
reporting positions while a question plays over the video. The worker stores
with each pending question whether it was paused, so a question replayed after
a reconnect pauses only if it did the first time.

**Ask Lamiss** (Lamiss#84). While Lamiss runs on a video, **Alt+L** (a
`chrome.commands` shortcut, changeable in `chrome://extensions/shortcuts`) or the
mic button next to the question timer opens the question card for the
learner's own question, already listening; it can also be typed. The video
keeps playing at 20% volume while Lamiss listens and answers. The worker sends
the question to `POST /api/user-interaction/user-asks` (the card's request ID is
the `interactionId`, so a retry gets the stored answer) and tells the chat panel
to reload its history. The answer shows in the card without a grade, is read
aloud in the tutor language (or the video's), and the card closes 4 s later.
**Escape** or **✕** cancels. A question Lamiss is asking comes first: the
shortcut does nothing then.

**Languages** (TDR-0003,
[docs/TDR-0003-Language-Preferences.md](https://github.com/DanielFuzzy/Lamiss/blob/main/docs/TDR-0003-Language-Preferences.md)).
Three languages, each set apart from the others:

- **App language**: what the extension shows. The row of five small flags
  (United Kingdom, Spain, France, Germany, Portugal; each named in its own
  language for screen readers and on hover) at the top of the popup switches the popup, the chat panel, the microphone page and
  everything Lamiss shows on YouTube, at once. It starts as the browser's
  language when it is one of the five, else English. Strings live in one
  catalog, `src/shared/lamiss-i18n.ts` (`lamissT(key, params)`; HTML uses
  `data-i18n` and `data-i18n-attr`), loaded before `shared/lamiss-api.js` in
  every context. A language is added by adding a column to every message there
  (TypeScript reports a missing one).
- **Tutor language**: what Lamiss asks, explains and gives feedback in. It's a
  backend preference, "Video's language" (`null`) by default. `ASK_QUESTION`
  carries the question's `language`, so the right voice reads it.
- **Caption language**: the transcript Lamiss reads, picked from the video's
  spoken language by `selectVideoCaptionTrack`. The other two never change it.

Each view is its own script under `src/popup/` (`home-view.ts`,
`audio-view.ts`, `tutor-view.ts`, `profile-view.ts`) on top of
`popup-shared.ts`; `popup.ts` wires the navigation.

Where the settings live:

| Where | What |
|---|---|
| `chrome.storage.local` `lamissDeviceSettings` | `{ micDeviceId?, speakerDeviceId?, volume }` (volume 0–1). Device IDs belong to this machine and browser profile and never leave the extension. The chat panel records with `micDeviceId`; the worker adds `micDeviceId` to the offscreen document's `listen` and `speakerDeviceId` + `volume` to its `speak` messages. A device that is gone falls back to the default one. |
| `chrome.storage.local` `lamissAppLanguage` | The app language: `en`, `es`, `fr`, `de` or `pt`. Every page and the content script follow changes through `chrome.storage.onChanged`. |
| `chrome.storage.local` `lamissQuestionSettings` | Question frequency (`minSecondsBetweenQuestions`: Less 300, Normal 120, More 60) and difficulty, also set from the chat panel. |
| Backend, `GET`/`PUT /api/me/preferences` | Native and learning language, tutor language (`tutorLanguage`; the backend also returns it as the older `tutor.explanationLanguage`, which the extension never sends), level, learning goal, daily goal minutes, kindness, response length, encouragement, auto-pause, voice, speed. |
| Backend, `PATCH /api/me/profile` | Username. |

To see every view in a browser with a stubbed backend and fake media devices:

```sh
npm run build && node scripts/popup-e2e.js [screenshotDir]
```

It needs a Chromium-based browser that still accepts `--load-extension`
(set `LAMISS_E2E_BROWSER`; branded Google Chrome no longer does) and is not
part of `npm test`.

## Brand assets

The logo lives in `src/brand/` and nowhere else:

- `lamiss-logo.svg`: the logo, traced from the reference in DanielFuzzy/Lamiss#14. Transparent background:
  the face is the background showing through, so on dark surfaces it sits on a white tile or disc.
- `lamiss-mark-small.svg`: the same shapes slightly grown, for 16–32 px (the toolbar icon, the button on
  the video, the question card, the chat header). It is web-accessible on youtube.com for the content script.

The extension icons in `src/icons/` are rendered from these files on a white rounded square, so the face
stays white on Chrome's dark toolbar. After changing the logo, run `node scripts/render-icons.js`
(same browser rules as the popup e2e: `LAMISS_E2E_BROWSER`) and commit the PNGs.

## Tests

```sh
npm test
```

This builds `compiled/` and runs `node --test` over `test/**/*.test.js`. The
tests load the compiled scripts into a Node `vm` context with `chrome.*` and
`fetch` stubs, so they need neither a browser nor a backend. CI
(`.github/workflows/ci.yml`) runs the same command on Node 24.
