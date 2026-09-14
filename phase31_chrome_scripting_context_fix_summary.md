# Phase 3.1 Chrome Scripting Execution-Context Fix

## Objective

This repository is the Lamiss YouTube Transcript POC Chrome extension. The objective is to keep the intended Phase 3.1 architecture intact while repairing the runtime error that occurs when the extension tries to perform `chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: discoverCaptionTracksMainWorld })` from the wrong JavaScript execution context.

The known failure is:

```
Lamiss POC: caption tracks discovered = false
Lamiss POC: diagnostic error = Cannot read properties of undefined (reading 'executeScript')
```

This is not supposed to be treated as a YouTube caption-structure issue. It is an extension API availability/context problem. The goal is to make `chrome.scripting` available from the extension execution context that actually runs `executeScript`, and to ensure the `discoverCaptionTracksMainWorld` function remains a self-contained MAIN-world helper that only reads page globals such as `window.ytInitialPlayerResponse`.

---

## Repository inspection

The workspace inspected the repository in the expected folder:

```
C:\Users\perro\Documents\GitHub\lamiss-youtube-transcript-poc
```

The repository contains the actual files expected for this extension work:

- `manifest.json`
- `package.json`
- `tsconfig.json`
- `scripts/build.js`
- `src/content/youtube.ts`
- `src/popup/popup.ts`
- `src/popup/popup.html`
- `compiled/manifest.json`
- `compiled/content/youtube.js`
- `compiled/popup/popup.js`

The extension is Manifest V3. The manifest requires the following permission model:

```json
"permissions": [
  "activeTab",
  "scripting"
]
```

This matches the architecture requirement: the extension may use the active tab and the `scripting` APIs, while the actual content script runs only after `document_idle` on YouTube watch pages:

```json
"content_scripts": [
  {
    "matches": ["https://www.youtube.com/watch*"],
    "js": ["content/youtube.js"],
    "run_at": "document_idle"
  }
]
```

The content script file receives and handles the popup’s `LOAD_TRANSCRIPT` message. It validates the YouTube watch URL, checks the requested `tabId`, then sends a discovery flow over the Chrome extension message bus.

---

## Root cause

The root cause was that the extension tried to run the `chrome.scripting.executeScript()` API directly from the content-script execution context. That context is an isolated JavaScript environment attached to the page; it is not the same as a privileged extension context. In Chrome extension APIs, `chrome.scripting` is not guaranteed to be available everywhere. In fact, the content script only has a partial Chrome extension object and no direct reliable access to the `chrome.scripting` API in the way the background worker or extension page context does.

That is why the runtime error is:

```
Cannot read properties of undefined (reading 'executeScript')
```

The failure is not a problem with `window.ytInitialPlayerResponse` or caption track extraction itself. It is a context-availability boundary error before the MAIN-world code can execute.

---

## Correct architecture direction

The goal was to preserve the intended architecture without replacing it with any forbidden mechanism such as:

- `document.createElement("script")`
- `script.textContent`
- `document.head.appendChild(script)`
- `chrome.debugger`
- `chrome.webRequest`
- `yt-dlp`
- UI scraping
- backend services or transcript models

The required architecture is:

```
Popup
  -> chrome.tabs.query({active:true,currentWindow:true})
  -> activeTab.id
  -> chrome.tabs.sendMessage(...)
  -> Content Script
  -> Background / Extension Context
  -> chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: discoverCaptionTracksMainWorld })
  -> YouTube MAIN world
  -> window.ytInitialPlayerResponse
  -> caption metadata
  -> response back to content script or popup
```

This keeps the `executeScript` call in an extension context that can legally access `chrome.scripting`.

---

## Implementation

### 1. Background worker added

The repository did not yet have a proper MV3 background service worker, but the `background` field is the right extension context for `chrome.scripting`. The repo’s build shape expects JavaScript sources compiled from TypeScript into the `compiled/` folder. The worker file added for this change is:

```
src/background.ts
```

The worker is the correct source for the self-contained `discoverCaptionTracksMainWorld()` implementation and for the `executeScript` receptor.

The worker performs the following sequence:

1. Accept an extension message of form:
   ```ts
   { type: 'DISCOVER_CAPTION_TRACKS', tabId, language }
   ```
2. Verify API availability using:
   ```ts
   Boolean(chrome.scripting && typeof chrome.scripting.executeScript === 'function')
   ```
3. If the API is unavailable, log:
   ```text
   Lamiss POC: chrome.scripting available = false
   Lamiss POC: chrome.scripting API is unavailable
   ```
   and refuse the retry loop.
4. If available, log:
   ```text
   Lamiss POC: chrome.scripting available = true
   Lamiss POC: executing caption discovery in MAIN world
   ```
   and call:
   ```ts
   chrome.scripting.executeScript({
     target: { tabId },
     world: 'MAIN',
     func: discoverCaptionTracksMainWorld
   });
   ```
5. Send the `MAIN`-world result back to the content script by message passing.

This preserves the `chrome.scripting.executeScript` API model while moving the boundary into the correct MV3 context.

### 2. Content script depopulated of the wrong API call

The old content script implementation had the direct `executeScript` loop embedded in the content script and its logic was in the wrong place. It repeatedly attempted to run `chrome.scripting.executeScript()` from the content-script world. This context cannot reliably provide the API object and therefore fails with the described undefined property error.

To avoid that, the content script no longer attempts to directly call `executeScript()` itself. The content script now only:

- receives the popup-sent message,
- validates `tabId` and the YouTube page URL,
- asks the background worker to run the `executeScript` path,
- receives the result of the worker’s `CAPTION_DISCOVERY_RESULT` message,
- performs caption fetching on the content side by building the `fmt=json3` caption URL and using `fetch()` to obtain the JSON caption resource.

### 3. Background file compiled into the extension output

The build helper and manifest must produce a bundled `compiled/` extension. Since the service worker is a new compiled artifact, the build helper must copy the final manifest and static popup HTML into `compiled/`, while the TypeScript compiler emits `background.js` into the compiled directory under the same extension root. This is the required output shape for MV3 teams.

The `compiled/manifest.json` now emits:

```json
"background": {
  "service_worker": "background.js"
}
```

That is the final MV3 proof that the correct extension context is being referenced.

### 4. Main-world function stays self-contained

The `discoverCaptionTracksMainWorld` function remains self-contained and only inspects the page object:

```ts
window.ytInitialPlayerResponse
  ?.captions
  ?.playerCaptionsTracklistRenderer
  ?.captionTracks
```

It returns only safe metadata, such as:

```ts
{
  success: true,
  tracks: [
    {
      languageCode,
      name,
      baseUrl
    }
  ]
}
```

or:

```ts
{
  success: false,
  error: 'YouTube caption tracks are not available'
}
```

The diagnostic object safely reports the keys available for the page object, but it does not dump the full `ytInitialPlayerResponse` object or complete URLs carrying tokens or signed query parameters.

---

## Manifest update

The manifest kept the `activeTab` and `scripting` permissions and added the minimal MV3 background configuration:

```json
{
  "manifest_version": 3,
  "name": "Lamiss YouTube Transcript POC",
  "version": "0.1.0",
  "description": "Investigates extracting YouTube caption data from the browser for a Lamiss transcript POC.",
  "permissions": [
    "activeTab",
    "scripting"
  ],
  "host_permissions": [
    "https://www.youtube.com/*"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "action": {
    "default_title": "Lamiss Transcript POC",
    "default_popup": "popup/popup.html"
  },
  "content_scripts": [
    {
      "matches": ["https://www.youtube.com/watch*"],
      "js": ["content/youtube.js"],
      "run_at": "document_idle"
    }
  ]
}
```

This is the correct MV3 structure: permissions are not broadened beyond `activeTab` and `scripting`, and `host_permissions` remains only for the YouTube watch page host.

---

## Build and test verification

### Build command

The project uses:

```json
"scripts": {
  "build": "tsc -p tsconfig.json && node scripts/build.js",
  "test": "npm run build && node test/youtubeUrl.test.js"
}
```

The command run for verification was:

```sh
Set-Location 'C:\Users\perro\Documents\GitHub\lamiss-youtube-transcript-poc'; npm run build
```

The resulting output was:

```text
> lamiss-youtube-transcript-poc@0.1.0 build
> tsc -p tsconfig.json && node scripts/build.js

Lamiss POC build helper: copied static extension files into compiled/.
```

This confirms that TypeScript compilation and static build artifact copying both succeeded.

### Test command

The command run for verification was:

```sh
Set-Location 'C:\Users\perro\Documents\GitHub\lamiss-youtube-transcript-poc'; npm test
```

The fresh evidence is:

```text
> lamiss-youtube-transcript-poc@0.1.0 test
> npm run build && node test/youtubeUrl.test.js

> lamiss-youtube-transcript-poc@0.1.0 build
> tsc -p tsconfig.json && node scripts/build.js

Lamiss POC build helper: copied static extension files into compiled/.
youtubeUrl tests passed: 6
```

That verifies the pre-existing test suite continue to pass and that the new message/service-worker execution context did not weaken or remove the test contract.

---

## Static source check

I also searched the repository for the old CSP-breaking inline script bridge implementation:

```text
document.createElement("script")
script.textContent
document.head.appendChild(script)
```

The repository search returned no remaining matches. This confirms the old policy-breaking bridge is fully removed from the source and build output.

---

## What this fix establishes

This Phase 3.1 proof establishes the architecture-preserving correction:

- The popup still sends the `LOAD_TRANSCRIPT` message with the explicit `tabId`.
- The content script still gets the `tabId`, parses the `videoId`, and keeps the requested language logic.
- The content script no longer tries to reach `chrome.scripting` from the isolated content world.
- The API check for `chrome.scripting` and the `executeScript` call are performed by a worker that has the required extension permissions and service-worker lifetime.
- The `MAIN` world function remains self-contained and has access only to `window` and the page global `ytInitialPlayerResponse` object.

This means the call path is now correctly routed through an MV3 extension context that is allowed to run `chrome.scripting.executeScript` and is therefore the right execution environment for the existing architecture.

---

## Remaining manual-test caveat

This repository is the correct code repository, and the `npm run build` and `npm test` verification both succeed. However, I did not run the actual Chrome/Brave manual unpacked-extension test in this session, so manual runtime verification remains a future browser gate.

The next browser console proof that should be observed when the extension is manually reloaded is:

```text
Lamiss POC: chrome.scripting available = true
Lamiss POC: executing caption discovery in MAIN world
Lamiss POC: MAIN world execution completed
```

That is the next evidence gate required before the project continues with the YouTube caption metadata investigation itself.
