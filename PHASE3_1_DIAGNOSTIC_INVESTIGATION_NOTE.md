# Lamiss YouTube Transcript POC — Phase 3.1 Diagnostic Investigation: YouTube Caption Metadata

This note records the requested diagnostic-only investigation for the current YouTube page state and the caption-metadata discovery problem.

## Objective

The goal is to determine exactly where YouTube caption metadata lives in the MAIN world for:

https://www.youtube.com/watch?v=LeRylkDym54

The current expected object shape is:

```ts
window.ytInitialPlayerResponse
  ?.captions
  ?.playerCaptionsTracklistRenderer
  ?.captionTracks
```

The current manual runtime observation is:

```text
Lamiss POC: LOAD_TRANSCRIPT message received = true
Lamiss POC: active tab ID received = true
Lamiss POC: videoId = LeRylkDym54
Lamiss POC: requested language = es
Lamiss POC: page player response discovered = true
Lamiss POC: executing caption discovery in MAIN world
Lamiss POC: caption tracks discovered = false
Lamiss POC: MAIN world execution completed
```

The popup → content script → `chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: ... })` flow is therefore already intact.

The remaining phase-3 blocker is the discovery of caption metadata in the MAIN context.

## Architecture preserved

The implementation remains inside the same architecture:

```text
Popup
↓
chrome.tabs.query
↓
activeTab.id
↓
chrome.tabs.sendMessage
↓
Content Script
↓
chrome.scripting.executeScript
↓
YouTube MAIN world
↓
caption metadata discovery
↓
Content Script
```

No Phase 4 work, no backend integration, no transcript mapping, no `yt-dlp`, no `chrome.debugger`, no `chrome.webRequest`, no UI scraping, and no new architecture are introduced.

## Diagnostic requirement

The MAIN-world discovery function remains self-contained and must not reintroduce inline script injection. The solution must continue using:

```ts
chrome.scripting.executeScript({
  target: { tabId },
  world: 'MAIN',
  func: discoverCaptionTracksMainWorld
});
```

The requested diagnostic expansion is limited to safe structural metadata:

```ts
{
  playerResponseExists,
  playerResponseType,
  playerResponseKeys,
  captionsExists,
  captionsType,
  captionsKeys,
  rendererExists,
  rendererKeys,
  captionTracksExists,
  captionTracksIsArray,
  captionTracksCount,
  ytInitialDataExists,
  ytInitialDataKeys,
  ytInitialPlayerConfigExists,
  ytInitialPlayerConfigKeys,
  alternativeCaptionMetadataPath
}
```

This is intentionally enough to distinguish:

1. `ytInitialPlayerResponse` missing
2. `ytInitialPlayerResponse` exists but `captions` is missing
3. `captions` exists but `playerCaptionsTracklistRenderer` is missing
4. renderer exists but `captionTracks` is missing
5. `captionTracks` exists but is empty
6. caption metadata exists elsewhere in a known page-state object
7. or the video exposes no accessible captions

No complete caption responses, base URLs, tokens, cookies, or user data are logged.

## Current implementation evidence

The source and compiled files already reflect the same bounded retry model:

```ts
const startedAt = Date.now();
let attempt = 0;
while (Date.now() - startedAt < 5000) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: discoverCaptionTracksMainWorld
  });
  await new Promise(resolve => setTimeout(resolve, 250));
}
```

This remains a bounded investigation loop with an immediate attempt, ~250 ms retry cadence, and ~5 second maximum run window.

The diagnostic output should report:

```text
Lamiss POC: MAIN player response exists = true/false
Lamiss POC: MAIN player response type = ...
Lamiss POC: MAIN player response keys = ...
Lamiss POC: MAIN captions exists = true/false
Lamiss POC: MAIN captions type = ...
Lamiss POC: MAIN captions keys = ...
Lamiss POC: MAIN caption renderer exists = true/false
Lamiss POC: MAIN caption renderer keys = ...
Lamiss POC: MAIN captionTracks exists = true/false
Lamiss POC: MAIN captionTracks is array = true/false
Lamiss POC: MAIN captionTracks count = N
Lamiss POC: ytInitialData exists = true/false
Lamiss POC: ytInitialData keys = ...
Lamiss POC: ytInitialPlayerConfig exists = true/false
Lamiss POC: ytInitialPlayerConfig keys = ...
Lamiss POC: alternative caption metadata path found = ...
```

If any caption metadata is found under a known alternative object, the diagnostic only records the structural path and never dumps the object.

## Required manual-data path

The requested manual test stays the same:

1. `npm run build`
2. `npm test`
3. load the generated `compiled/` folder as the unpacked extension
4. open `https://www.youtube.com/watch?v=LeRylkDym54`
5. select `es`
6. click `Load Transcript`
7. capture the complete `Lamiss POC` diagnostic sequence

## Verification evidence

The workspace already verifies the build/test path with:

```text
Lamiss POC build helper: copied static extension files into compiled/.
youtubeUrl tests passed: 6
```

That is sufficient for the compile packaging and existing test gate. It does not prove the runtime page object shape in Chrome/Brave, which remains a manual diagnostic question.

## Expected conclusion set

The diagnostic result must identify exactly one of the following:

A. `ytInitialPlayerResponse` is missing.
B. `ytInitialPlayerResponse` exists but captions are missing.
C. captions exists but `playerCaptionsTracklistRenderer` is missing.
D. renderer exists but `captionTracks` is missing.
E. `captionTracks` exists but is empty.
F. caption metadata exists elsewhere in a known page-state object.
G. the video does not expose accessible captions.

No Phase 4 workaround, fetching strategy, or alternate architecture should be implemented in this note.
