# Lamiss YouTube Transcript POC — Phase 3.1 MAIN-World Caption Discovery Note

This note records the requested Phase 3.1 fix for the existing caption investigation path.

## Manual Test Signal

The observed manual test produced the following evidence:

```text
Lamiss POC: LOAD_TRANSCRIPT message received = true
Lamiss POC: videoId = LeRylkDym54
Lamiss POC: requested language = es
Lamiss POC: page player response discovered = true
```

The browser then emitted a CSP failure:

```text
Executing inline script violates the following Content Security Policy directive ...
```

The failure was observed from the caption-discovery inspection path and led to:

```text
Lamiss POC: caption tracks discovered = false
```

## Diagnosis

The old path was trying to inject an inline `<script>` element into the YouTube page in order to read the page context:

```js
document.createElement("script")
script.textContent = ...
document.head.appendChild(script)
```

That mechanism is incompatible with the page and extension CSP model and cannot be kept in this POC.

The fix is to remove the inline-script bridge entirely and replace it with the supported Chrome extension runtime API:

```ts
chrome.scripting.executeScript({
  target: { tabId },
  world: "MAIN",
  func: discoverCaptionTracks
})
```

This API runs the discovery function directly in the YouTube page's MAIN JavaScript world, where `window.ytInitialPlayerResponse` is accessible without injecting a script tag.

## Required Architecture

The architecture remains:

```text
Popup
 ↓
Content Script
 ↓
chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: discoverCaptionTracks })
 ↓
YouTube MAIN world
 ↓
window.ytInitialPlayerResponse
 ↓
captionTracks
 ↓
Content Script
 ↓
fetch caption baseUrl
```

No redesign is introduced. No backend, no transcript mapping, no `yt-dlp`, no `chrome.debugger`, no `chrome.webRequest`, and no UI scraping are added.

## MAIN-World Function Shape

The discovery function passed to `chrome.scripting.executeScript` is intentionally self-contained and executes only from the serialized function body:

```ts
function discoverCaptionTracks() {
  const playerResponse = window.ytInitialPlayerResponse;
  const tracks = playerResponse
    ?.captions
    ?.playerCaptionsTracklistRenderer
    ?.captionTracks;

  if (!tracks || !Array.isArray(tracks)) {
    return {
      success: false,
      error: "YouTube caption tracks are not available"
    };
  }

  return {
    success: true,
    tracks: tracks.map(track => ({
      languageCode: track.languageCode,
      name: track.name,
      baseUrl: track.baseUrl
    }))
  };
}
```

This intentionally avoids returning unnecessary parts of `ytInitialPlayerResponse`.

## Timing and Retry Strategy

Because YouTube loads data dynamically, the implementation should do an immediate probe and then retry every ~250 ms for up to roughly 5 seconds.

The retry loop stops as soon as:

```ts
window.ytInitialPlayerResponse
  ?.captions
  ?.playerCaptionsTracklistRenderer
  ?.captionTracks
```

becomes available.

This prevents a permanent failure while avoiding an infinite polling loop.

## Language Selection

After the MAIN-world function returns the track list, the content script chooses the requested language exactly:

```ts
track.languageCode === requestedLanguage
```

For the manual test scenario, `requestedLanguage` is `"es"`.

If Spanish is unavailable, the result must be:

```json
{
  "success": false,
  "error": "Requested caption language is not available"
}
```

## Caption Fetch

Once the requested track metadata is identified, the content script uses the returned `baseUrl` and applies the required caption fetch adjustment:

```ts
const captionUrl = new URL(baseUrl);
captionUrl.searchParams.set("fmt", "json3");
```

The fetch remains on the content-script side, with the MAIN-world function responsible only for the metadata discovery.

## Required Diagnostics

The existing diagnostics must remain visible in the implementation and should continue to support the observed Phase 3 caption proof path:

```text
Lamiss POC: LOAD_TRANSCRIPT message received = true
Lamiss POC: videoId = LeRylkDym54
Lamiss POC: requested language = es
Lamiss POC: executing caption discovery in MAIN world
Lamiss POC: MAIN world execution completed
Lamiss POC: caption tracks discovered = true/false
Lamiss POC: caption tracks count = N
Lamiss POC: matching track discovered = true/false
Lamiss POC: caption baseUrl obtained = true/false
Lamiss POC: caption request started
Lamiss POC: caption resource fetched = true/false
Lamiss POC: response JSON = true/false
Lamiss POC: events count = N
```

No complete `baseUrl` value should be logged because it may contain tokens or signed query parameters.

## Build and Manual Test Expectations

The requested verification steps are:

```sh
npm run build
npm test
```

and then a direct manual load of the compiled output as an unpacked extension.

The desired manual-test log sequence should be the following:

```text
Lamiss POC: executing caption discovery in MAIN world
Lamiss POC: MAIN world execution completed
Lamiss POC: caption tracks discovered = true
Lamiss POC: caption tracks count = N
Lamiss POC: matching track discovered = true
Lamiss POC: caption baseUrl obtained = true
Lamiss POC: caption resource fetched = true
Lamiss POC: response JSON = true
Lamiss POC: events count = N
```

The old CSP error message should not appear after the inline-script bridge is removed.

## Scope

This note deliberately stays inside Phase 3.1 only. It does not add or infer any Phase 4 transcript model, mapping, or backend abstraction.
