# Lamiss YouTube Transcript POC — Phase 3.1 Active Tab ID Propagation Note

This note records the requested Phase 3.1 fix for the active-tab ID propagation problem observed in the popup/content-script flow.

## Problem

The extension loaded and the content script received the `LOAD_TRANSCRIPT` message, but the popup displayed:

```text
Status: Active tab ID is unavailable
```

The implementation had been trying to recover the tab ID in the content script from the message sender metadata:

```ts
sender.tab?.id
```

That metadata is not the reliable source for the explicit popup-to-content message flow.

## Requested Flow

The intended flow is:

```text
Popup
  ↓
chrome.tabs.query({ active: true, currentWindow: true })
  ↓
activeTab.id
  ↓
chrome.tabs.sendMessage(activeTab.id, {
  type: 'LOAD_TRANSCRIPT',
  language,
  tabId: activeTab.id
})
  ↓
Content Script
  ↓
const tabId = message.tabId
  ↓
chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: discoverCaptionTracks })
```

No redesign was introduced.

## Implementation

The popup file was updated so that it keeps the same active-tab query and validates that the selected tab is a YouTube watch page before sending the request.

The message payload now carries the current tab id explicitly:

```ts
{
  type: 'LOAD_TRANSCRIPT',
  language: selectedLanguage,
  tabId: activeTab.id
}
```

The content script type definition was updated to accept:

```ts
{
  type: 'LOAD_TRANSCRIPT',
  language: string,
  tabId: number
}
```

The content script now consumes the tab ID from the payload:

```ts
const tabId = message.tabId;
```

and rejects malformed or absent values with:

```ts
{ success: false, error: 'Active tab ID is unavailable' }
```

The existing MAIN-world caption-discovery path remains in place:

```ts
chrome.scripting.executeScript({
  target: { tabId },
  world: 'MAIN',
  func: discoverCaptionTracks
})
```

The old inline `<script>` bridge remains removed.

## Diagnostics Preserved

The relevant diagnostics remain:

```text
Lamiss POC: LOAD_TRANSCRIPT message received = true
Lamiss POC: active tab ID received = true
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

No full `baseUrl` is logged because the signed/tokenized query string may be present.

## Verification

The repository was rebuilt and tested with:

```sh
npm run build
npm test
```

Fresh proof from the workspace:

```text
Lamiss POC build helper: copied static extension files into compiled/.
youtubeUrl tests passed: 6
```

This confirms the build/test path remains working while the popup now sends the active tab id explicitly, and the content script accepts that id from the message payload instead of depending on the runtime sender metadata.
