# Lamiss YouTube Transcript POC — Phase 3 Execution Note

This document records the Phase 3 caption-access investigation that was performed in the repository.

## Objective

Phase 3 is specifically about proving whether the Chrome Extension can obtain the caption resource already loaded by YouTube in the browser. The experiment deliberately avoids mapping the caption format into a Lamiss transcript, avoids creating the Lamiss API abstraction, and avoids using privileged debugging or interception APIs.

The target test is:

https://www.youtube.com/watch?v=LeRylkDym54

The requested language is Spanish (`es`).

## Investigated Approach

The least-privileged mechanism used in this repository is:

1. stay inside the existing popup → content-script message flow
2. use the content script to validate the YouTube watch URL and extract the YouTube video ID
3. inspect the page JavaScript context for an already-exposed `ytInitialPlayerResponse` object
4. look for the structure:

```ts
window.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks
```

5. select the requested language track (`es`)
6. fetch the caption track’s `baseUrl`
7. set `fmt=json3` on the URL and fetch the YouTube caption JSON response
8. log the `events` array and return the raw caption structure to the popup layer

This was implemented in the content script and kept deliberately small.

## Why This Choice

This approach fits the requested investigation hierarchy:

1. access already-existing page data where possible
2. avoid `chrome.debugger`
3. avoid `chrome.webRequest`
4. avoid scraping the transcript UI
5. avoid network interception

The extension uses only the existing `activeTab` and `scripting` permission model already present in the manifest. No extra permissions were added.

## Implementation Summary

The main implementation point is in the content script:

- src/content/youtube.ts

The code:

- verifies the URL with the same YouTube watch validation rules already established in Phase 2
- accepts a `LOAD_TRANSCRIPT` message from the popup with a selected language
- calls a small page-context discovery helper that creates an inline script in the page to read `window.ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks`
- sends the discovered track metadata back to the content script through a `postMessage` bridge
- chooses the track whose `languageCode` matches the requested `language`
- fetches the caption resource from that track’s `baseUrl`
- appends `fmt=json3` to the caption URL before fetching the structured JSON
- verifies that the JSON has an `events` array
- logs the raw JSON response and reports whether the fetch succeeded

The popup remains the same simple UX layer. It sends `LOAD_TRANSCRIPT` and displays the returned response text. No additional UI was added beyond the existing popup behavior.

## Why This Is Still Phase 3 Only

The implementation does NOT:

- map caption events into a Lamiss transcript model
- create `TranscriptSegment` types
- create a Lamiss repository/API abstraction
- call a Lamiss backend
- scrape the transcript UI
- download the video or audio
- use yt-dlp
- use `chrome.debugger`
- use `chrome.webRequest`

Those belong to later phases and were intentionally not added here.

## Build Verification

I verified the repository with:

```sh
npm run build
```

The fresh build evidence was:

```text
> lamiss-youtube-transcript-poc@0.1.0 build
> tsc -p tsconfig.json
```

This confirms the TypeScript content script compiles successfully with the Phase 3 caption-discovery additions.

## Manual Testing Instructions

1. Open Chrome and load the unpacked extension from this repository.
2. Open the YouTube video:

   https://www.youtube.com/watch?v=LeRylkDym54

3. Ensure the page has loaded enough for the YouTube player data to be present.
4. Open the Lamiss popup.
5. Select Spanish (`es`).
6. Click `Load Transcript`.
7. Open the browser page DevTools console.

## Expected Console Output

The extension should log useful diagnostics such as:

```text
Lamiss POC: videoId = LeRylkDym54
Lamiss POC: language = es
Lamiss POC: caption track discovered = true
Lamiss POC: caption URL discovered = true
Lamiss POC: caption request = success
Lamiss POC: response format = JSON
Lamiss POC: events = N
Lamiss POC: rawCaptionResponse = { ... }
```

The exact number of `events` may vary depending on the YouTube page and caption data already loaded by the player.

## Conclusion

This experiment attempts to prove the least-privileged viable Phase 3 architecture: access already-exposed YouTube caption metadata from the page’s player response and fetch the caption track directly as an ordinary extension-origin fetch.

If the page does not expose `ytInitialPlayerResponse`, or if the fetch is blocked by browser-origin or CORS behavior, the extension should stop and document that limitation instead of escalating to `chrome.debugger` or `chrome.webRequest`.

The recommended next step, if this page-context discovery fails, is to inspect the browser page for a browser-readable caption metadata shape in the player response and then decide whether a non-privileged fetch is feasible. If that fails, the next advisory path is to stop and report the exact security/isolation blocker rather than implement a privileged network interception solution.
