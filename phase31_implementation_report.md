# Phase 3.1 Chrome Scripting Execution-Context Fix Report

## Objective

This repository implements the Lamiss YouTube Transcript POC Chrome extension. The requested Phase 3.1 work is to remove the direct `chrome.scripting.executeScript(...)` access from the content script and route the discovery request through the MV3 background service worker so the MAIN-world caption discovery function can run correctly from an extension context that has the required `scripting` permission.

## Root cause

The underlying runtime error was caused by the content-script execution context trying to reach the privileged `chrome.scripting.executeScript` API directly. In a content-script world, that API is not reliably exposed as an extension-owned privileged object, so the code failed before the page MAIN-world helper could run. The runtime symptom was:

```text
Lamiss POC: caption tracks discovered = false
Lamiss POC: diagnostic error = Cannot read properties of undefined (reading 'executeScript')
```

That failure is a context-availability problem, not a caption metadata or YouTube player-response problem.

## Correct architecture preserved

The architecture now follows the requested flow:

```text
Popup
  -> chrome.tabs.query({ active: true, currentWindow: true })
  -> activeTab.id
  -> chrome.tabs.sendMessage(...)
  -> Content Script
  -> chrome.runtime.sendMessage({ type: 'DISCOVER_CAPTION_TRACKS', tabId, language })
  -> MV3 Background Service Worker
  -> chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: discoverCaptionTracksMainWorld })
  -> YouTube MAIN world
  -> window.ytInitialPlayerResponse
  -> caption metadata
  -> background worker sends CAPTION_DISCOVERY_RESULT back to content script
  -> content script fetches caption resource and continues the existing Phase 3 flow
```

No inline script bridge or DOM `document.createElement('script')` / `script.textContent` / `document.head.appendChild(script)` bridge is part of the implemented design.

## Implemented files

### Created

- `src/background.ts`

This file holds the MV3 background worker message listener and the MAIN-world caption-discovery `executeScript` entry point. Its implementation validates a message shape of:

```ts
{ type: 'DISCOVER_CAPTION_TRACKS', tabId: number, language: string }
```

It rejects malformed messages cleanly by returning false from the message listener without crashing the service worker. It also validates that the `tabId` is a valid integer and that the requested language is a non-empty string. The worker checks for API availability using:

```ts
Boolean(chrome.scripting && typeof chrome.scripting.executeScript === 'function')
```

When unavailable it logs:

```text
Lamiss POC: chrome.scripting available = false
Lamiss POC: chrome.scripting API is unavailable
```

and immediately returns a failure message back over the message bus rather than re-entering a retry loop.

### Modified

- `src/content/youtube.ts`
- `src/popup/popup.ts`
- `manifest.json`
- `scripts/build.js`

The content script was updated so it receives the popup’s `LOAD_TRANSCRIPT` message, validates the `tabId` and the YouTube watch URL, extracts the video ID, and sends the requested language to the worker. It then expects a `CAPTION_DISCOVERY_RESULT` response message from the worker and continues the existing caption fetch logic by creating the `fmt=json3` URL and calling `fetch()` from the content script.

The worker performs the privileged execution of `chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: discoverCaptionTracksMainWorld })` and sends the `CAPTION_DISCOVERY_RESULT` message back to the content script. The worker remains self-contained and does not import anything from page state or extension scope outside the request message itself.

## Main-world helper

The MAIN-world helper remains self-contained and returns safe metadata only. The helper accesses the page global `window.ytInitialPlayerResponse`, then reads the caption metadata path:

```ts
window.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks
```

The returned structure avoids dumping the entire response object:

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

or an error:

```ts
{
  success: false,
  error: 'YouTube caption tracks are not available'
}
```

The diagnostic object reports structural fields such as:

- `playerResponseExists`
- `playerResponseType`
- `playerResponseKeys`
- `captionsExists`
- `captionsType`
- `captionsKeys`
- `rendererExists`
- `rendererKeys`
- `captionTracksExists`
- `captionTracksIsArray`
- `captionTracksCount`
- `ytInitialDataExists`
- `ytInitialDataKeys`
- `ytInitialPlayerConfigExists`
- `ytInitialPlayerConfigKeys`
- `alternativeCaptionMetadataPath`

These diagnostics remain structural and safe; they do not log full caption URLs, signed URLs, cookies, tokens, full player-media structures, or user data.

## Manifest and build contract

The workspace manifest stays MV3 and continues to require:

```json
"permissions": [
  "activeTab",
  "scripting"
]
```

It also preserves the YouTube host permission:

```json
"host_permissions": [
  "https://www.youtube.com/*"
]
```

and the MV3 background worker reference:

```json
"background": {
  "service_worker": "background.js"
}
```

The popup HTML packaging remains corrected to include a relative script reference that stays self-contained under the compiled popup directory:

```html
<script src="popup.js"></script>
```

This is the required output shape that the build process writes into the compiled extension directory.

## Build and test evidence

The project’s existing build command is:

```json
"build": "tsc -p tsconfig.json && node scripts/build.js"
```

and the test command is:

```json
"test": "npm run build && node test/youtubeUrl.test.js"
```

Fresh verification evidence was run in the workspace:

```sh
npm run build
npm test
```

Observed output:

```text
> lamiss-youtube-transcript-poc@0.1.0 build
> tsc -p tsconfig.json && node scripts/build.js

Lamiss POC build helper: copied static extension files into compiled/.

> lamiss-youtube-transcript-poc@0.1.0 test
> npm run build && node test/youtubeUrl.test.js

> lamiss-youtube-transcript-poc@0.1.0 build
> tsc -p tsconfig.json && node scripts/build.js

Lamiss POC build helper: copied static extension files into compiled/.
youtubeUrl tests passed: 6
```

That verifies the TypeScript build and static packaging work as required, and that the pre-existing caption URL parsing test suite remains passing.

## Static search verification

A static repository scan was run to confirm that the old inline cross-origin CSP-breaking bridge pattern is gone and that the background worker is the only extension context where `chrome.scripting.executeScript` appears in the source and compiled outputs.

The banned bridge patterns that were searched for were:

```text
document.createElement("script")
document.createElement('script')
script.textContent
document.head.appendChild(script)
```

The final verification result confirms that no old inline-script bridge remains in the source and compiled files.

## Manual browser verification status

Manual browser execution was not performed in this environment. No live Chrome or Brave runtime verification was observed here, so the requested manual presence of:

```text
Lamiss POC: chrome.scripting available = true
Lamiss POC: executing caption discovery in MAIN world
Lamiss POC: MAIN world execution completed
```

cannot be claimed from this session.

## Final architecture status

The requested Phase 3.1 execution-context fix is now represented by the source implementation in the repository and by the generated compiled artifacts. The extension remains MV3, uses the active-tab and scripting permissions, and routes the work through the background service-worker context where `chrome.scripting.executeScript` legitimately belongs.
