# Lamiss YouTube Transcript POC — Phase 3.1 Final Fetch Verification and JSON3 Handoff

We are continuing the existing Lamiss YouTube Transcript POC.

DO NOT redesign the architecture.
DO NOT introduce yt-dlp.
DO NOT use chrome.debugger.
DO NOT use chrome.webRequest.
DO NOT scrape the YouTube DOM.
DO NOT reintroduce an inline <script> bridge.
DO NOT implement backend integration.
DO NOT move to Phase 4.

The caption discovery mechanism is already working and MUST remain unchanged.

## Current proven runtime state

The extension currently produces:

Lamiss POC: LOAD_TRANSCRIPT message received = true
Lamiss POC: active tab ID received = true
Lamiss POC: videoId = LeRylkDym54
Lamiss POC: requested language = es
Lamiss POC: page player response discovered = true
Lamiss POC: caption tracks discovered = true
Lamiss POC: caption tracks count = 1
Lamiss POC: matching track discovered = true
Lamiss POC: caption baseUrl obtained = true
Lamiss POC: fmt=json3 requested = true

The user manually inspected the Network request to:

https://www.youtube.com/api/timedtext

and confirmed that the response contains the complete JSON3 caption document, including:

{
  "events": [
    {
      "tStartMs": 0,
      ...
      "segs": [
        {
          "utf8": "qué"
        }
      ]
    }
  ]
}

Therefore:

CAPTION DISCOVERY IS NOT THE PROBLEM.

The remaining problem is only the transfer/fetch/JSON3 processing path.

## Previous failure

When the content script performed:

const response = await fetch(captionUrl.toString());

the browser returned:

HTTP 200
content-type = text/html; charset=UTF-8
response body length = 0

and:

JSON.parse error = Unexpected end of JSON input

This proves that the old content-script fetch path was not receiving the actual caption body.

## Current architecture

The current architecture already routes privileged scripting through the MV3 background service worker:

Popup
  ->
Content Script
  ->
Background Service Worker
  ->
chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: ...
  })
  ->
YouTube MAIN world

The background worker is the ONLY place where chrome.scripting.executeScript may be called.

Preserve that architecture.

## Current implementation

The worker now contains a MAIN-world helper similar to:

async function fetchCaptionResourceMainWorld(captionUrl: string) {
  const response = await fetch(captionUrl, {
    credentials: 'include'
  });

  const text = await response.text();

  return {
    ok: response.ok,
    status: response.status,
    contentType: response.headers.get('content-type') ?? 'unknown',
    text
  };
}

The worker executes it with:

chrome.scripting.executeScript({
  target: { tabId },
  world: 'MAIN',
  func: fetchCaptionResourceMainWorld,
  args: [captionUrl]
});

The content script then receives the returned object.

## IMPORTANT TASK

Do NOT assume that the MAIN-world fetch succeeded.

Instrument and verify the COMPLETE result of executeScript.

The first task is to inspect the exact result returned by:

chrome.scripting.executeScript(...)

Remember that executeScript returns an array of InjectionResult objects.

The implementation must correctly extract:

results[0]?.result

and validate that it contains:

ok
status
contentType
text

Do not accidentally treat the InjectionResult wrapper itself as the fetch result.

## Required diagnostics

Add safe diagnostics in the background worker:

Lamiss POC: caption fetch executing in MAIN world = true

Lamiss POC: executeScript returned = true/false

Lamiss POC: MAIN caption result exists = true/false

Lamiss POC: MAIN caption HTTP request completed = true/false

Lamiss POC: MAIN caption HTTP status = N

Lamiss POC: MAIN caption response ok = true/false

Lamiss POC: MAIN caption response content-type = ...

Lamiss POC: MAIN caption response text length = N

Do NOT log the actual caption text.

Do NOT log the full caption URL.

Do NOT log query parameters, tokens, cookies, authorization headers, or signed URLs.

## Content script processing

Once the worker successfully returns the MAIN-world fetch result, the content script must process ONLY the returned text.

It must NOT fetch the URL again.

Use:

const responseText = result.text;

Then:

console.log(
  'Lamiss POC: response body read =',
  typeof responseText === 'string' ? 'true' : 'false'
);

console.log(
  'Lamiss POC: response text length =',
  typeof responseText === 'string' ? responseText.length : 0
);

Then parse exactly once:

const data = JSON.parse(responseText);

Do NOT call response.json().

Do NOT call response.text() in the content script because the content script no longer owns the Response object.

## JSON3 validation

After JSON.parse:

console.log('Lamiss POC: JSON.parse succeeded = true');

console.log(
  'Lamiss POC: parsed response type =',
  typeof data
);

console.log(
  'Lamiss POC: events exists =',
  Array.isArray(data?.events) ? 'true' : 'false'
);

console.log(
  'Lamiss POC: events count =',
  Array.isArray(data?.events) ? data.events.length : 0
);

Then validate the existing caption response structure.

Do not redesign the transcript model.

Do not transform the transcript yet.

For this Phase 3.1 task, it is sufficient to prove:

1. MAIN-world fetch succeeded
2. response body is non-empty
3. JSON.parse succeeds
4. data.events exists
5. data.events is an array
6. at least some events contain segs
7. at least some segments contain utf8 text

Add:

const events = Array.isArray(data?.events) ? data.events : [];

const eventsWithSegments = events.filter(
  event =>
    Array.isArray(event?.segs) &&
    event.segs.length > 0
);

const segmentsWithText = eventsWithSegments
  .flatMap(event => event.segs ?? [])
  .filter(
    seg =>
      typeof seg?.utf8 === 'string' &&
      seg.utf8.trim().length > 0
  );

Diagnostics:

Lamiss POC: events containing segments = N
Lamiss POC: segments containing text = N

## Critical executeScript handling

Make sure the worker does NOT accidentally return:

results

when the content script expects:

results[0].result

The expected worker response should contain the actual fetch result:

{
  ok: true,
  status: 200,
  contentType: "...",
  text: "..."
}

If executeScript fails, return:

{
  ok: false,
  error: "..."
}

Do not expose the full caption response in console logs.

## Content-script response contract

Keep the existing message architecture.

The content script should receive something equivalent to:

{
  type: 'CAPTION_FETCH_RESULT',
  ok: true,
  status: 200,
  contentType: '...',
  text: '...'
}

or:

{
  type: 'CAPTION_FETCH_RESULT',
  ok: false,
  error: '...'
}

Use the existing pending response mechanism.

Do not create a second unrelated messaging architecture.

## Preserve caption discovery

DO NOT modify:

window.ytInitialPlayerResponse

captions

playerCaptionsTracklistRenderer

captionTracks

language matching

baseUrl discovery

The existing discovery is already proven.

## Preserve MV3

manifest.json must continue to contain:

"manifest_version": 3

"permissions": [
  "activeTab",
  "scripting"
]

and the existing YouTube host permission.

The background service worker must remain configured.

## Security / logging requirements

Never log:

- complete caption baseUrl
- signed query parameters
- tokens
- cookies
- authorization headers
- complete caption response
- transcript text

Only log:

- booleans
- HTTP status
- content type
- response length
- counts
- structural diagnostics

## Build and tests

After making the change run:

npm run build

npm test

Both must pass.

Expected existing test result:

youtubeUrl tests passed: 6

Also verify that compiled/ is regenerated.

## Static verification

Verify:

1. chrome.scripting.executeScript exists ONLY in the background worker.
2. No document.createElement('script') bridge exists.
3. No script.textContent bridge exists.
4. No document.head.appendChild(script) bridge exists.
5. Content script does NOT directly fetch captionUrl.
6. Content script parses the worker-returned text only once.

## Manual browser verification

After building:

1. Load compiled/ as an unpacked extension.
2. Completely reload:
   https://www.youtube.com/watch?v=LeRylkDym54
3. Select Spanish.
4. Click Load Transcript.
5. Inspect the extension/content-script/background console.

The desired diagnostic sequence is approximately:

Lamiss POC: caption fetch executing in MAIN world = true
Lamiss POC: executeScript returned = true
Lamiss POC: MAIN caption result exists = true
Lamiss POC: MAIN caption HTTP request completed = true
Lamiss POC: MAIN caption HTTP status = 200
Lamiss POC: MAIN caption response ok = true
Lamiss POC: MAIN caption response content-type = ...
Lamiss POC: MAIN caption response text length = > 0

Then in the content script:

Lamiss POC: response body read = true
Lamiss POC: response text length = > 0
Lamiss POC: JSON.parse succeeded = true
Lamiss POC: events exists = true
Lamiss POC: events count = N
Lamiss POC: events containing segments = N
Lamiss POC: segments containing text = N

The critical success condition is:

MAIN caption response text length > 0
AND
JSON.parse succeeded = true
AND
events exists = true
AND
events count > 0

## Important final instruction

Do not stop after making the code compile.

Inspect the existing source before editing it.

Make the smallest possible change required to correctly propagate:

executeScript(...)
    ->
results[0].result
    ->
content script
    ->
JSON.parse(text)
    ->
data.events

Do not implement any alternate caption extraction mechanism.

At the end, report:

1. Exact files changed.
2. Exact root cause discovered.
3. How executeScript result is extracted.
4. How the result is transferred to the content script.
5. Build result.
6. Test result.
7. Static verification result.
8. Manual verification status.
9. Exact console diagnostics expected after the fix.
