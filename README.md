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

| Variable | Default | Purpose |
|---|---|---|
| `LAMISS_API_URL` | `http://localhost:8080` | Backend origin (scheme, host, optional port). Written to `compiled/shared/lamiss-config.js` and added to the manifest's host permissions. The WebSocket URL is derived from it (`http` → `ws`, `https` → `wss`). |
| `LAMISS_GOOGLE_CLIENT_ID` | none | Public client ID of the Google OAuth client below. Without it the build prints a warning and sign-in does not work. |

The client ID is public. No client secret is needed, and none may be added to
this repository or to the build.

`compiled/` is the unpacked extension. It is build output and is not committed.

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

## Tests

```sh
npm test
```

This builds `compiled/` and runs `node --test` over `test/**/*.test.js`. The
tests load the compiled scripts into a Node `vm` context with `chrome.*` and
`fetch` stubs, so they need neither a browser nor a backend. CI
(`.github/workflows/ci.yml`) runs the same command on Node 24.
