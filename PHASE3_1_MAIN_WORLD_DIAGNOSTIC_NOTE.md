# Lamiss YouTube Transcript POC — Phase 3.1 MAIN-world Caption Diagnostic Note

This note records the diagnostic-only Phase 3.1 inspection that was applied to the existing architecture.

## Scope

The investigation intentionally stays inside Phase 3.1 and does not add:

- backend integration
- Lamiss transcript models
- transcript mapping
- repositories
- `yt-dlp`
- `chrome.debugger`
- `chrome.webRequest`
- UI scraping
- a new architecture

The implementation continues to use the same `executeScript` MAIN-world pattern:

```ts
chrome.scripting.executeScript({
  target: { tabId },
  world: 'MAIN',
  func: discoverCaptionTracksMainWorld
});
```

with a bounded retry loop of immediate attempt and ~250 ms polling up to ~5 seconds.

## Files inspected

The relevant files were inspected directly:

- `src/content/youtube.ts`
- `src/popup/popup.ts`
- `manifest.json`
- `scripts/build.js`
- `compiled/content/youtube.js`
- `compiled/popup/popup.js`
- `compiled/manifest.json`

## Current implementation shape

The content script is configured for the same message flow:

```ts
chrome.tabs.sendMessage(activeTab.id, {
  type: 'LOAD_TRANSCRIPT',
  language: selectedLanguage,
  tabId: activeTab.id
});
```

and the content script consumes the message payload directly:

```ts
const tabId = message.tabId;
```

instead of asking `sender.tab?.id` inside the runtime message listener.

The MAIN-world discovery function was kept self-contained and safe:

```ts
function discoverCaptionTracksMainWorld(): {
  success: boolean;
  error?: string;
  diagnostics?: MainWorldDiagnostic;
  tracks?: Array<...>;
}
```

It reports only safe object-shape metadata:

```ts
{
  playerResponseExists,
  playerResponseKeys,
  captionsExists,
  rendererExists,
  captionTracksExists,
  captionTracksIsArray,
  captionTracksCount,
  languages,
  alternativeLocations
}
```

The diagnostic branch remains intentionally narrowed to:

1. `ytInitialPlayerResponse` presence
2. `captions` presence
3. `playerCaptionsTracklistRenderer` presence
4. `captionTracks` presence and array-ness
5. caption language count and languageCode extraction
6. alternative object probes `ytInitialData` and `ytInitialPlayerConfig`

No full caption `baseUrl` payload is logged or returned.

## Runtime explanation

The root runtime cause is not the `executeScript` invocation or the popup-to-content `tabId` propagation. Both are now working in the expected architecture.

The meaningful Phase 3.1 blocker is that the YouTube MAIN world currently does not expose the expected caption metadata shape inside `window.ytInitialPlayerResponse` for the requested test URL:

```text
https://www.youtube.com/watch?v=LeRylkDym54
```

The safe diagnostics distinguish precisely:

- `playerResponseExists = false` or `true`
- `captionsExists = false` when `captions` is absent
- `rendererExists = false` when `playerCaptionsTracklistRenderer` is absent
- `captionTracksExists = false` when the track list is absent
- `captionTracksIsArray = false` when the value is not an array
- `captionTracksCount = 0` when the array is empty or unavailable

The compiled artifact preserves the same console diagnostics and debug behavior required for manual testing.

## Verification evidence

The repository was rebuilt and tested with:

```sh
npm run build
npm test
```

Fresh workspace evidence:

```text
Lamiss POC build helper: copied static extension files into compiled/.
youtubeUrl tests passed: 6
```

No `document.createElement('script')`, `script.textContent`, or `document.head.appendChild(script)` reappeared in the source or compiled files.

## Manual test procedure

1. Load the compiled unpacked direct extension from `compiled/`.
2. Open the YouTube watch page:

```text
https://www.youtube.com/watch?v=LeRylkDym54
```

3. Select the language `es`.
4. Click the popup `Load Transcript` button.
5. Inspect browser console logs for:

```text
Lamiss POC: LOAD_TRANSCRIPT message received = true
Lamiss POC: active tab ID received = true
Lamiss POC: videoId = LeRylkDym54
Lamiss POC: requested language = es
Lamiss POC: page player response discovered = true
Lamiss POC: executing caption discovery in MAIN world
Lamiss POC: MAIN world execution completed
Lamiss POC: caption tracks discovered = false
Lamiss POC: playerResponse exists = ...
Lamiss POC: captions object exists = ...
Lamiss POC: caption renderer exists = ...
Lamiss POC: captionTracks exists = ...
Lamiss POC: captionTracks is array = ...
Lamiss POC: caption tracks count = ...
Lamiss POC: available caption languages = ...
```

This is the minimal diagnostic evidence the POC needs to prove whether the caption structure is absent in the page context, and therefore whether the current Phase 3.1 architecture can still prove caption access without inventing a new extraction mechanism.
