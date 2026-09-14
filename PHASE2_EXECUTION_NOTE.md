# Lamiss YouTube Transcript POC — Phase 2 Execution Note

This document records the work performed in the previous prompt execution for Phase 2 of the Lamiss YouTube Transcript POC.

## Goal

Phase 2 is focused on the browser extension’s active-tab and YouTube video-ID handling. The extension must:

1. identify the active tab
2. verify that the active tab is a YouTube watch page
3. extract the YouTube video ID from the URL
4. return that information through the existing popup → content-script message flow

The target URL is:

https://www.youtube.com/watch?v=LeRylkDym54

Expected result:

```text
videoId = LeRylkDym54
```

## Repository Inspection Before Changes

Before changing code, I inspected the files that the Phase 2 request explicitly named and the current project structure.

The files inspected were:

- manifest.json
- src/popup/popup.ts
- src/content/youtube.ts
- tsconfig.json
- package.json

The repository had already been scaffolded by Phase 1. The inspection showed that:

- the extension manifest already declared the popup and the YouTube watch page content script match
- the popup already sent a `LOAD_TRANSCRIPT` message via `chrome.tabs.sendMessage(...)`
- the popup already requested `chrome.tabs.query({ active: true, currentWindow: true })`
- the content script already tried to validate the YouTube watch page and extract the URL video ID

This meant that Phase 2 functional behavior was partially present already from Phase 1, and the safest approach was to preserve the existing message flow instead of redesigning it.

## What Was Already Satisfied

The repository already satisfied the following Phase 2 requirements:

- active tab detection via `chrome.tabs.query`
- YouTube URL check from the popup and the content script
- a browser-side message flow from popup to content script
- existing `LOAD_TRANSCRIPT` message structure for the popup → content script path
- a content-script hook that tries to extract the YouTube `v=` parameter from the page URL

## What Was Missing or Not Fully Correct

The earlier implementation had a few limitations that did not yet satisfy the requested Phase 2 contract precisely:

- popup response handling expected an `ok/message` object, while the requested Phase 2 response pattern is based on:

```json
{ "success": true, "videoId": "...", "language": "..." }
```

or:

```json
{ "success": false, "error": "Human readable error" }
```

- the content script URL validation was too loose and did not clearly enforce the Phase 2 rules for:
  - allowing only YouTube hostnames
  - requiring the pathname to be exactly `/watch`
  - requiring an `v` query parameter
  - rejecting empty or missing video IDs

- the popup had no shared URL parsing utility or reliable structured error handling for the Phase 2 error cases.

## Changes Made

I kept the existing extension flow and added a single shared parser utility in the TypeScript source tree:

### New file

- src/youtubeUrl.ts

This file exports:

```ts
parseYouTubeUrl(url: string)
extractYouTubeVideoId(url: string)
```

The parser implements the Phase 2 validation requirements:

- hostname must be `www.youtube.com` or `youtube.com`
- pathname must be `/watch`
- `v` query param must exist and be non-empty
- errors must be returned as a clear human-readable message

### Updated files

- src/content/youtube.ts
  - replaced the Phase 1 loose extraction approach with a Phase 2-style structured parse result
  - returned `success: true`, `videoId`, and `language` for normal cases
  - returned `success: false` and a clear `error` for unsupported or malformed page cases

- src/popup/popup.ts
  - preserved the existing popup → active tab → `chrome.tabs.sendMessage` route
  - updated the response handling so the popup reads `success`, `videoId`, and `error` rather than the earlier `ok/message` shape
  - displayed a clearer popup status message

- package.json
  - added a `test` script that runs the TypeScript build and the URL parser smoke checks

## Test File Added

A simple test file was created:

- test/youtubeUrl.test.js

It verifies:

1. `https://www.youtube.com/watch?v=LeRylkDym54` → `LeRylkDym54`
2. `https://www.youtube.com/watch?v=LeRylkDym54&t=120` → `LeRylkDym54`
3. `https://example.com/watch?v=LeRylkDym54` → rejected
4. `https://www.youtube.com/` → rejected
5. `https://www.youtube.com/watch` → rejected
6. `https://www.youtube.com/watch?v=` → rejected

The test avoids any live YouTube network dependency and is therefore deterministic and safe for the POC.

## Build and Test Verification

I verified the repository with:

```sh
npm run build
```

and then with:

```sh
npm test
```

Fresh terminal evidence:

```text
> npm test
> npm run build && node test/youtubeUrl.test.js

> lamiss-youtube-transcript-poc@0.1.0 build
> tsc -p tsconfig.json

youtubeUrl tests passed: 6
```

This confirmed that:

- TypeScript compilation succeeded
- the new parser passed all six requested URL scenarios

## Final Expected Result

For the primary test URL:

https://www.youtube.com/watch?v=LeRylkDym54

The parser and content script should produce the following structured object for a successful case:

```json
{
  "success": true,
  "videoId": "LeRylkDym54",
  "language": "es"
}
```

or, if the popup selected the English option, the `language` field would be "en" instead.

## Scope Guard

No Phase 3 actions were implemented.

The following were intentionally not added:

- caption acquisition
- `timedtext` access
- `chrome.debugger`
- `chrome.webRequest`
- transcript UI scraping
- YouTube transcript parser
- Lamiss transcript mapper
- Lamiss API abstraction
- backend integration

This keeps the implementation squarely inside the Phase 2 active-tab and video-ID requirement.
