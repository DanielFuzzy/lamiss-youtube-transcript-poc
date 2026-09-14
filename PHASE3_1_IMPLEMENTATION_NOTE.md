# Lamiss YouTube Transcript POC — Phase 3.1 Implementation Note

This note records the work performed to replace the old inline `<script>` caption-discovery bridge with a Chrome `chrome.scripting.executeScript` path that runs in the YouTube page MAIN world.

## Objective

Preserve the existing Phase 1, Phase 2, Phase 3, and packaging architecture while removing the CSP-breaking inline-script injection and replacing it with a self-contained `chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: discoverCaptionTracks })` flow.

## What Changed

The content script in [src/content/youtube.ts](src/content/youtube.ts) was updated so that:

1. the `LOAD_TRANSCRIPT` listener remains the same popup → content-script message flow,
2. it obtains the current tab ID from `sender.tab?.id`,
3. it logs the requested diagnostics,
4. it replaces the old inline `document.createElement('script')` / `script.textContent` / `document.head.appendChild(script)` mechanism,
5. it invokes `chrome.scripting.executeScript(...)` in the MAIN world,
6. it runs a bounded retry loop for up to ~5 seconds while polling for `window.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks`,
7. it returns only the requested caption metadata shape from the MAIN world, limited to `languageCode`, `name`, and `baseUrl`,
8. it selects the requested Spanish language exactly using `track.languageCode?.toLowerCase() === requestedLanguage`,
9. it returns the requested error payload when the requested language is absent, and
10. it keeps the caption fetch on the content-script side by creating `new URL(baseUrl)` and adding `fmt=json3` before fetching the resource.

This keeps the repository inside the requested Phase 3.1 scope and avoids any Phase 4 mapping, backend, or repository abstraction.

## Files Changed

- [src/content/youtube.ts](src/content/youtube.ts)
- [src/popup/popup.html](src/popup/popup.html)
- [manifest.json](manifest.json)

## Files Created

- [PHASE3_1_MAIN_WORLD_CAPTION_FIX.md](PHASE3_1_MAIN_WORLD_CAPTION_FIX.md)
- [PHASE3_POPUP_HTML_NOTE.md](PHASE3_POPUP_HTML_NOTE.md)
- [PHASE3_PACKAGE_NOTE.md](PHASE3_PACKAGE_NOTE.md)
- [PHASE3_1_IMPLEMENTATION_NOTE.md](PHASE3_1_IMPLEMENTATION_NOTE.md)

## Build and Test Evidence

The implementation was verified with:

```sh
npm run build
npm test
```

Fresh evidence from the workspace:

```text
> lamiss-youtube-transcript-poc@0.1.0 build
> tsc -p tsconfig.json && node scripts/build.js

Lamiss POC build helper: copied static extension files into compiled/.

> lamiss-youtube-transcript-poc@0.1.0 test
> npm run build && node test/youtubeUrl.test.js

Lamiss POC build helper: copied static extension files into compiled/.
youtubeUrl tests passed: 6
```

## Manifest Path Normalization

The compiled extension manifest and popup HTML were normalized so the bundle remains self-contained under `compiled/`:

```json
"default_popup": "popup/popup.html"
```

and:

```json
"js": ["content/youtube.js"]
```

The popup HTML now points to the script inside the same local popup folder:

```html
<script src="popup.js"></script>
```

## Result

The old inline page-script bridge is removed and replaced by the `chrome.scripting.executeScript` MAIN-world API path while preserving the rest of the requested Phase 3 caption investigation architecture and the compiled extension packaging pattern.
