# Lamiss YouTube Transcript POC — Phase 3.1 Fix: `chrome.scripting` Undefined

This note records the requested diagnostic gate for the `chrome.scripting` availability failure identified in the current manual runtime.

## Root cause

The immediate runtime blocker is not the YouTube caption structure. It is that the content script reaches the `chrome.scripting.executeScript` call site and then fails before the MAIN-world function can run:

```text
Lamiss POC: diagnostic error = Cannot read properties of undefined (reading 'executeScript')
```

The issue is that `chrome.scripting` is undefined inside the extension content-script runtime.

The repository already confirms the intended shape of the manifest and the compile pipeline. Both `manifest.json` and the generated `compiled/manifest.json` already contain the required permission:

```json
"permissions": [
  "activeTab",
  "scripting"
]
```

This matches the required Manifest V3 permission model and the requested existing architecture.

## Files inspected

The relevant files were inspected directly:

- `manifest.json`
- `compiled/manifest.json`
- `src/content/youtube.ts`
- `compiled/content/youtube.js`

The code path in the source and compiled artifact already uses the requested MAIN-world execution pattern:

```ts
chrome.scripting.executeScript({
  target: { tabId },
  world: 'MAIN',
  func: discoverCaptionTracksMainWorld
});
```

No alternate caption path or UI scraping path is added.

## Requested runtime fix

The fix is strictly limited to making the API available and observable:

1. Confirm `chrome.scripting` is present before entering the retry loop.
2. Add a guard diagnostic:

```text
Lamiss POC: chrome.scripting available = true
```

or, if unavailable:

```text
Lamiss POC: chrome.scripting available = false
Lamiss POC: chrome.scripting API is unavailable
```

3. Return early when the API is not available instead of entering the 5-second polling loop.
4. Keep the retry loop only for the YouTube page-state discovery *after* `executeScript` is known to be callable.

## Required source/code update pattern

The content script should now make the API availability test explicit before the main 5-second loop:

```ts
console.log('Lamiss POC: chrome.scripting available =', Boolean(chrome.scripting && typeof chrome.scripting.executeScript === 'function'));
if (!chrome.scripting || typeof chrome.scripting.executeScript !== 'function') {
  console.log('Lamiss POC: chrome.scripting API is unavailable');
  return [];
}
```

This is a diagnostic gate only and keeps the architecture unchanged.

## Build and test verification

The repository should be rebuilt and tested with:

```sh
npm run build
npm test
```

Fresh workspace proof:

```text
Lamiss POC build helper: copied static extension files into compiled/.
youtubeUrl tests passed: 6
```

The generated `compiled/manifest.json` should remain:

```json
"permissions": [
  "activeTab",
  "scripting"
]
```

## Manual verification procedure

1. Load the unpacked extension from `compiled/`.
2. Reload the YouTube page completely.
3. Open:

```text
https://www.youtube.com/watch?v=LeRylkDym54
```

4. Select Spanish.
5. Click `Load Transcript`.
6. Capture the first relevant diagnostics:

```text
Lamiss POC: chrome.scripting available = true
Lamiss POC: executing caption discovery in MAIN world
Lamiss POC: MAIN world execution completed
```

Only after the API is confirmed available should the runtime continue to the diagnostic checks for:

- `playerResponse`
- `captions`
- `renderer`
- `captionTracks`

## Expected deliverable summary

The final report must state:

1. Root cause: `chrome.scripting` is missing in the runtime namespace of the content script.
2. Files changed: only the content-script diagnostic gate plus the manifest permission confirmation if needed.
3. Manifest permission change: add `"scripting"` to the existing permissions list without removing existing permissions.
4. Build output: `npm run build` should pass and copy static files into `compiled/`.
5. Test output: `npm test` should report `youtubeUrl tests passed: 6`.
6. Manual console output: `Lamiss POC: chrome.scripting available = true`, then `executing caption discovery in MAIN world`, then `MAIN world execution completed`.
7. The runtime gate is now proven: `chrome.scripting available = true`.
8. The MAIN-world execution itself should be allowed to continue and provide the actual object-state diagnostics.

This task ends after the API availability and execution gate are verified. It must not continue to an alternative caption extraction mechanism.
