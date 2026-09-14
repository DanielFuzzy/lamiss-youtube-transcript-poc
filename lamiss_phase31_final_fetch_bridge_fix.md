# Lamiss YouTube Transcript POC — Phase 3.1 FINAL FETCH BRIDGE FIX

We are continuing the existing Lamiss YouTube Transcript POC.

DO NOT redesign the architecture.
DO NOT start Phase 4.
DO NOT add yt-dlp.
DO NOT add chrome.debugger.
DO NOT add chrome.webRequest.
DO NOT scrape the YouTube UI.
DO NOT introduce an inline <script> bridge.
DO NOT change the caption discovery mechanism.

The caption discovery mechanism is already proven to work.

Current runtime evidence:

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

The user also manually inspected the YouTube timedtext request in DevTools and confirmed that the response contains the complete JSON3 caption document with:

{
  "wireMagic": "pb3",
  ...
  "events": [
    ...
  ]
}

Therefore:

- caption discovery is NOT the problem
- ytInitialPlayerResponse is NOT the problem
- captionTracks is NOT the problem
- matching Spanish track is NOT the problem
- baseUrl is NOT the problem
- fmt=json3 is NOT the problem
- JSON.parse itself is NOT the root problem

The remaining problem is the transfer of the timedtext response body from the YouTube MAIN world back to the extension.

## IMPORTANT EXISTING ARCHITECTURE

The architecture must remain:

Popup
  ↓
Content Script
  ↓
Background Service Worker
  ↓
chrome.scripting.executeScript()
  ↓
YouTube MAIN world
  ↓
fetch timedtext
  ↓
response.text()
  ↓
return result
  ↓
Background Worker
  ↓
chrome.runtime.sendMessage()
  ↓
Content Script
  ↓
JSON.parse()
  ↓
data.events

The content script must NOT perform the timedtext fetch itself.

## PRIMARY TASK

Inspect the current implementation of:

- src/background.ts
- src/content/youtube.ts
- manifest.json
- scripts/build.js
- compiled/background.js
- compiled/content/youtube.js

Determine exactly where the response body is being lost.

Pay particular attention to chrome.scripting.executeScript() result handling.

IMPORTANT:

chrome.scripting.executeScript() returns:

InjectionResult[]

not the raw value returned by the MAIN-world function.

Therefore the worker must correctly extract:

const results = await chrome.scripting.executeScript(...);

const result = results[0]?.result;

The worker must NOT accidentally send the entire results array to the content script.

The expected fetch result object is:

{
  ok: boolean,
  status: number,
  contentType: string,
  text: string
}

## MAIN WORLD FETCH

Keep the existing self-contained MAIN-world helper.

It must look conceptually like:

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

The helper must:

1. execute in MAIN world
2. receive captionUrl through executeScript args
3. use args: [captionUrl]
4. perform fetch()
5. call response.text() exactly once
6. return the complete text
7. never log the complete text
8. never log the complete URL
9. never log query parameters
10. never log cookies
11. never log authorization headers

Do not add arbitrary HTTP headers.

Do not copy browser request headers.

Use credentials: 'include'.

## CRITICAL executeScript RESULT HANDLING

Implement and verify this exact conceptual flow:

const results = await chrome.scripting.executeScript({
  target: { tabId },
  world: 'MAIN',
  func: fetchCaptionResourceMainWorld,
  args: [captionUrl]
});

console.log(
  'Lamiss POC: executeScript returned =',
  Array.isArray(results) ? 'true' : 'false'
);

const mainResult = results[0]?.result;

console.log(
  'Lamiss POC: MAIN caption result exists =',
  mainResult ? 'true' : 'false'
);

if (!mainResult || typeof mainResult !== 'object') {
  // return a clean failure to the content script
}

const fetchResult = mainResult as {
  ok: boolean,
  status: number,
  contentType: string,
  text: string
};

DO NOT send:

results

to the content script.

Send:

fetchResult

instead.

## REQUIRED BACKGROUND DIAGNOSTICS

Add/preserve these diagnostics:

Lamiss POC: caption fetch executing in MAIN world = true

Lamiss POC: executeScript returned = true/false

Lamiss POC: MAIN caption result exists = true/false

Lamiss POC: MAIN caption HTTP request completed = true/false

Lamiss POC: MAIN caption HTTP status = N

Lamiss POC: MAIN caption response ok = true/false

Lamiss POC: MAIN caption response content-type = ...

Lamiss POC: MAIN caption response text length = N

Do NOT print the actual response text.

Do NOT print the full caption URL.

Do NOT print query parameters.

## MESSAGE BOUNDARY DIAGNOSTICS

Trace the result through the message bus.

Immediately before sending from the worker:

Lamiss POC: fetch result sent to content script = true
Lamiss POC: worker fetch result text length = N

When the content script receives it:

Lamiss POC: content script received fetch result = true
Lamiss POC: content script received text length = N

The text itself must never be logged.

## CONTENT SCRIPT

The content script must NOT fetch the caption URL again.

Once it receives the worker result:

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

Parse exactly once:

const data = JSON.parse(responseText);

Do NOT use response.json().
Do NOT call response.text() in the content script.
The content script no longer owns the Response object.

## JSON3 VALIDATION

After JSON.parse():

console.log('Lamiss POC: JSON.parse succeeded = true');

const events = Array.isArray(data?.events)
  ? data.events
  : [];

console.log(
  'Lamiss POC: events exists =',
  Array.isArray(data?.events) ? 'true' : 'false'
);

console.log(
  'Lamiss POC: events count =',
  events.length
);

Then calculate:

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

Log:

Lamiss POC: events containing segments = N
Lamiss POC: segments containing text = N

Do NOT transform the JSON3 response into a Lamiss transcript model yet.

Do NOT map timestamps yet.

Do NOT add backend integration.

Keep the raw JSON3 structure.

## ERROR STATES

Clearly distinguish:

1. executeScript failure
2. MAIN-world fetch failure
3. non-2xx HTTP response
4. 2xx response with empty body
5. non-empty response with invalid JSON
6. valid JSON without events
7. valid JSON with events

Never log:

caption resource fetched = false

after a successful HTTP response.

Use independent diagnostics for:

HTTP
→ body
→ JSON
→ events

## IMPORTANT

The user has already confirmed manually that the YouTube timedtext network response contains the complete caption JSON3 response.

Therefore the goal is NOT to find another caption extraction mechanism.

The goal is to correctly transfer that already-observed response body through:

MAIN world
→ executeScript result
→ background worker
→ runtime message
→ content script

## STATIC ARCHITECTURE REQUIREMENTS

Verify:

1. chrome.scripting.executeScript exists ONLY in src/background.ts and compiled/background.js.

2. There is NO executeScript call in src/content/youtube.ts.

3. There is NO inline script bridge.

Search for and confirm these are absent:

document.createElement("script")
document.createElement('script')
script.textContent
document.head.appendChild(script)

4. Manifest remains Manifest V3.

5. Keep:

"permissions": [
  "activeTab",
  "scripting"
]

6. Keep:

"host_permissions": [
  "https://www.youtube.com/*"
]

7. Keep the existing background service worker.

8. Do not add unnecessary permissions.

## BUILD

Run:

npm run build

Then:

npm test

Expected existing test result:

youtubeUrl tests passed: 6

Do not modify existing URL tests unless absolutely necessary.

## MANUAL TEST

After building:

1. Load compiled/ as an unpacked extension.
2. Completely reload:
   https://www.youtube.com/watch?v=LeRylkDym54
3. Select Spanish.
4. Click Load Transcript.
5. Capture the complete Lamiss diagnostic sequence.

Expected successful sequence:

Lamiss POC: caption tracks discovered = true
Lamiss POC: caption tracks count = 1
Lamiss POC: matching track discovered = true
Lamiss POC: caption baseUrl obtained = true
Lamiss POC: fmt=json3 requested = true

Lamiss POC: caption fetch executing in MAIN world = true
Lamiss POC: executeScript returned = true
Lamiss POC: MAIN caption result exists = true
Lamiss POC: MAIN caption HTTP request completed = true
Lamiss POC: MAIN caption HTTP status = 200
Lamiss POC: MAIN caption response ok = true
Lamiss POC: MAIN caption response text length = N

where N > 0.

Then:

Lamiss POC: fetch result sent to content script = true
Lamiss POC: worker fetch result text length = N
Lamiss POC: content script received fetch result = true
Lamiss POC: content script received text length = N

Then:

Lamiss POC: JSON.parse succeeded = true
Lamiss POC: events exists = true
Lamiss POC: events count = N

where N > 0.

Then:

Lamiss POC: events containing segments = N
Lamiss POC: segments containing text = N

where both values should be greater than zero for the observed caption response.

## IMPORTANT SUCCESS CRITERION

Do not consider this task complete merely because TypeScript compiles.

The real Phase 3.1 success criterion is:

MAIN-world response text length > 0
AND
content-script received text length > 0
AND
JSON.parse succeeds
AND
data.events is an array
AND
data.events.length > 0
AND
some events contain segs
AND
some segments contain utf8 text.

If browser execution is unavailable to the agent, explicitly report:

Manual browser verification: NOT PERFORMED

Do not claim browser success without actual browser evidence.

## FINAL REPORT

At the end report:

1. Exact root cause.
2. Exact files changed.
3. Exact MAIN-world fetch implementation.
4. Exact fetch options.
5. Exact executeScript result extraction.
6. Exact message-passing result handling.
7. Content-script JSON processing.
8. Build result.
9. Test result.
10. Static architecture verification.
11. Manual browser verification status.
12. Whether the inline script bridge remains removed.
13. Whether executeScript remains worker-only.
14. Exact runtime diagnostics observed.
15. Whether JSON3 events were successfully obtained.

STOP AFTER PHASE 3.1.
