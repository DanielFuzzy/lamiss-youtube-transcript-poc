// The worker is a classic script, so it shares the backend helpers this way.
declare function importScripts(...urls: string[]): void;
importScripts('shared/lamiss-config.js', 'shared/lamiss-api.js', 'shared/lamiss-auth.js');

// ---------------------------------------------------------------------------
// Who may talk to the worker. Only this extension: its own pages (popup, chat,
// offscreen) may send anything; the content script on youtube.com, which runs
// next to an untrusted page, only the messages it needs, about its own tab.
// ---------------------------------------------------------------------------

type LamissSenderKind = 'extension' | 'content' | 'untrusted';

const LAMISS_CONTENT_SCRIPT_MESSAGES = new Set<string>([
  'GET_SENDER_TAB_ID',
  'INGEST_TRANSCRIPT',
  'DISCOVER_CAPTION_TRACKS',
  'FETCH_CAPTION_RESOURCE_MAIN_WORLD',
  LAMISS_SIGN_IN_MESSAGE,
  LAMISS_AUTH_STATE_MESSAGE
]);

function isYouTubePageUrl(value: string | undefined): boolean {
  try {
    const url = new URL(value ?? '');
    return url.protocol === 'https:' && url.hostname === 'www.youtube.com';
  } catch {
    return false;
  }
}

function classifyLamissSender(sender: chrome.runtime.MessageSender | undefined): LamissSenderKind {
  if (!sender || sender.id !== chrome.runtime.id) {
    return 'untrusted';
  }
  if (typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''))) {
    return 'extension';
  }
  if (sender.tab?.id !== undefined && isYouTubePageUrl(sender.url)) {
    return 'content';
  }
  return 'untrusted';
}

function isAllowedLamissMessage(message: unknown, sender: chrome.runtime.MessageSender): boolean {
  const kind = classifyLamissSender(sender);
  if (kind === 'extension') {
    return true;
  }
  if (kind !== 'content') {
    return false;
  }
  const typed = message as { type?: unknown; tabId?: unknown } | null;
  if (typeof typed?.type !== 'string' || !LAMISS_CONTENT_SCRIPT_MESSAGES.has(typed.type)) {
    return false;
  }
  // A content script only ever acts on its own tab.
  return typed.tabId === undefined || typed.tabId === sender.tab?.id;
}

type LamissMessageListener = (message: any, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => boolean | undefined;

// Every message listener of the worker goes through this check.
function addLamissMessageListener(listener: LamissMessageListener): void {
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!isAllowedLamissMessage(message, sender)) {
      return false;
    }
    return listener(message, sender, sendResponse);
  });
}

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if (!isAllowedLamissMessage(message, sender)) {
    const type = (message as { type?: unknown } | null)?.type;
    console.warn('Lamiss POC: ignored a message from an unexpected sender:', typeof type === 'string' ? type : 'unknown');
  }
  return false;
});

type DiscoverTracksMessage = {
  type: 'DISCOVER_CAPTION_TRACKS';
  tabId: number;
  videoId: string;
};

type FetchCaptionResourceMessage = {
  type: 'FETCH_CAPTION_RESOURCE_MAIN_WORLD';
  tabId: number;
  captionUrl: string;
};

type FetchCaptionResourceMainWorldResult = {
  ok: boolean;
  status: number;
  contentType: string;
  text: string;
};

const LAMISS_TRANSCRIPT_INGEST_ENDPOINT = `${LAMISS_API_BASE_URL}/api/transcripts/ingest`;

type VideoPlatform = 'YOUTUBE' | 'DISNEY' | 'NETFLIX' | 'HBO' | 'PRIMEVIDEO' | 'CRUNCHYROLL';

// videoPlatform/videoTitle/videoDurationSeconds let the backend register the
// video on its first ingest; they're ignored once the video already exists.
type TranscriptIngestPayload = {
  videoExternalId?: string;
  videoPlatform?: VideoPlatform;
  videoTitle?: string;
  videoDurationSeconds?: number;
  language?: string;
  translated?: boolean;
  rawCaptionResponse?: unknown;
};

type TranscriptIngestOutcome = {
  ok: boolean;
  status?: number;
  ingestStatus?: string;
  error?: string;
  // Signed out, or the session ran out: signing in again is the fix.
  signInRequired?: boolean;
};

// Runs here rather than in the content script: the worker's host permission
// for the backend skips CORS, which youtube.com pages don't have.
async function ingestTranscript(payload: TranscriptIngestPayload): Promise<TranscriptIngestOutcome> {
  const accessToken = await readAccessToken();
  if (!accessToken) {
    return { ok: false, status: 401, error: LAMISS_SIGN_IN_REQUIRED_MESSAGE, signInRequired: true };
  }
  try {
    const response = await fetch(LAMISS_TRANSCRIPT_INGEST_ENDPOINT, withAuthorization({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, accessToken));

    if (response.status === 401) {
      const rejected = await lamissUnauthorized(accessToken);
      return { ok: false, status: rejected.status, error: rejected.error, signInRequired: true };
    }

    if (!response.ok) {
      console.log('Lamiss POC: transcript ingest HTTP status =', response.status);
      return { ok: false, status: response.status };
    }

    const body = await response.json().catch(() => undefined) as { status?: string } | undefined;
    console.log('Lamiss POC: transcript ingest status =', body?.status ?? 'unknown');
    return { ok: true, status: response.status, ingestStatus: body?.status };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

addLamissMessageListener((message: unknown, sender, sendResponse) => {
  const type = (message as { type?: unknown } | null)?.type;

  if (type === 'GET_SENDER_TAB_ID') {
    sendResponse({ tabId: sender.tab?.id });
    return false;
  }

  if (type === 'INGEST_TRANSCRIPT') {
    void ingestTranscript((message as { payload: TranscriptIngestPayload }).payload).then(sendResponse);
    return true;
  }

  return false;
});

async function fetchCaptionResourceMainWorld(captionUrl: string): Promise<FetchCaptionResourceMainWorldResult> {
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

// YouTube now requires a proof-of-origin token ("pot") plus a matching set of
// client-identity params on caption requests; the static baseUrl embedded in
// ytInitialPlayerResponse never carries them, so a plain fetch of it comes
// back HTTP 200 with an empty body. The token is generated by an obfuscated
// attestation script and isn't exposed anywhere a content script can read it
// passively (checked window.ytcfg/yt/ytplayer, IndexedDB, localStorage,
// sessionStorage, cookies - nothing). Instead, we nudge the page's own player
// into making one real caption request (by toggling its native CC button)
// and observe the resulting URL via chrome.webRequest, then reuse those
// params on our own request.
async function triggerCaptionDisplayMainWorld(): Promise<{ attempted: boolean; forcedRefresh: boolean }> {
  const button = document.querySelector('.ytp-subtitles-button') as HTMLButtonElement | null;
  if (!button) {
    return { attempted: false, forcedRefresh: false };
  }

  const alreadyOn = button.getAttribute('aria-pressed') === 'true';

  if (alreadyOn) {
    // The pot token behind an already-showing caption track can expire
    // between "Load Transcript" clicks. Toggling off then on again forces
    // the player to mint and request a genuinely fresh one instead of
    // silently reusing whatever we last observed.
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    button.click();
    return { attempted: true, forcedRefresh: true };
  }

  button.click();
  return { attempted: true, forcedRefresh: false };
}

const POT_CLIENT_PARAM_KEYS = ['c', 'cver', 'cplayer', 'cos', 'cosver', 'cplatform', 'cbr', 'cbrver', 'xorb', 'xobt', 'xovt'];

type CapturedPotToken = {
  pot: string;
  potc?: string;
  clientParams: Record<string, string>;
  capturedAt: number;
};

const capturedPotByTab = new Map<number, CapturedPotToken>();

if (chrome.webRequest && typeof chrome.webRequest.onBeforeRequest?.addListener === 'function') {
  chrome.webRequest.onBeforeRequest.addListener(
    (details): undefined => {
      if (typeof details.tabId !== 'number' || details.tabId < 0) {
        return undefined;
      }

      try {
        const url = new URL(details.url);
        const pot = url.searchParams.get('pot');
        if (!pot) {
          return undefined;
        }

        const clientParams: Record<string, string> = {};
        for (const key of POT_CLIENT_PARAM_KEYS) {
          const value = url.searchParams.get(key);
          if (value) {
            clientParams[key] = value;
          }
        }

        capturedPotByTab.set(details.tabId, {
          pot,
          potc: url.searchParams.get('potc') ?? undefined,
          clientParams,
          capturedAt: Date.now()
        });

        console.log('Lamiss POC: native pot token observed = true');
      } catch {
        // malformed URL; nothing to capture
      }

      return undefined;
    },
    { urls: ['*://www.youtube.com/api/timedtext*'] }
  );
}

async function ensureFreshPotToken(tabId: number): Promise<CapturedPotToken | undefined> {
  const requestedAt = Date.now();

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN' as chrome.scripting.ExecutionWorld,
      func: triggerCaptionDisplayMainWorld
    });
  } catch {
    // If we can't toggle captions, fall through and use whatever is cached.
  }

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const cached = capturedPotByTab.get(tabId);
    if (cached && cached.capturedAt >= requestedAt) {
      return cached;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return capturedPotByTab.get(tabId);
}

function discoverCaptionTracksMainWorld(expectedVideoId: string): {
  success: boolean;
  error?: string;
  diagnostics?: unknown;
  tracks?: Array<{ languageCode?: string; name?: { simpleText?: string; runs?: Array<{ text?: string }> }; baseUrl?: string; kind?: string }>;
  videoDetails?: { title?: string; lengthSeconds?: string };
  audioLanguage?: { languageCode: string; source: 'playing' | 'default' };
  defaultCaptionTrackIndex?: number;
} {
  const globalWindow = window as typeof window & {
    ytInitialPlayerResponse?: {
      videoDetails?: { videoId?: string; title?: string; lengthSeconds?: string };
      captions?: {
        playerCaptionsTracklistRenderer?: {
          captionTracks?: CaptionTrack[];
          audioTracks?: Array<{ defaultCaptionTrackIndex?: number }>;
          defaultAudioTrackIndex?: number;
        };
      };
      streamingData?: {
        adaptiveFormats?: Array<{ audioTrack?: { id?: string; audioIsDefault?: boolean } }>;
      };
    };
    ytInitialData?: unknown;
    ytInitialPlayerConfig?: unknown;
  };

  // window.ytInitialPlayerResponse is a load-time snapshot: on YouTube's
  // client-side navigation (e.g. clicking a related video) it keeps
  // describing whichever video the page loaded first. The player element's
  // own getPlayerResponse() always reflects whatever video is currently
  // loaded, so prefer it and fall back to the snapshot only if unavailable.
  const moviePlayer = document.getElementById('movie_player') as (Element & {
    getPlayerResponse?: () => unknown;
    getAudioTrack?: () => { id?: unknown } | undefined;
  }) | null;
  const livePlayerResponse = typeof moviePlayer?.getPlayerResponse === 'function'
    ? (moviePlayer.getPlayerResponse() as typeof globalWindow.ytInitialPlayerResponse)
    : undefined;

  const playerResponse = livePlayerResponse ?? globalWindow.ytInitialPlayerResponse;
  const playerResponseSource = livePlayerResponse ? 'live' : 'initial-snapshot';
  const playerResponseVideoId = playerResponse?.videoDetails?.videoId;

  if (expectedVideoId && playerResponseVideoId && playerResponseVideoId !== expectedVideoId) {
    return {
      success: false,
      error: 'Player response video ID does not match the requested video yet',
      diagnostics: {
        playerResponseSource,
        playerResponseVideoId,
        expectedVideoId
      }
    };
  }

  const playerResponseKeys = playerResponse ? Object.keys(playerResponse) : [];
  const captions = playerResponse?.captions;
  const captionsKeys = captions ? Object.keys(captions) : [];
  const renderer = captions?.playerCaptionsTracklistRenderer;
  const rendererKeys = renderer ? Object.keys(renderer) : [];
  const tracks = renderer?.captionTracks;
  const ytInitialData = globalWindow.ytInitialData;
  const ytInitialDataKeys = ytInitialData ? Object.keys(ytInitialData as Record<string, unknown>) : [];
  const ytInitialPlayerConfig = globalWindow.ytInitialPlayerConfig;
  const ytInitialPlayerConfigKeys = ytInitialPlayerConfig ? Object.keys(ytInitialPlayerConfig as Record<string, unknown>) : [];

  const diagnostics = {
    playerResponseSource,
    playerResponseVideoId,
    playerResponseExists: Boolean(playerResponse),
    playerResponseType: playerResponse ? typeof playerResponse : 'undefined',
    playerResponseKeys,
    captionsExists: Boolean(captions),
    captionsType: captions ? typeof captions : 'undefined',
    captionsKeys,
    rendererExists: Boolean(renderer),
    rendererKeys,
    captionTracksExists: Boolean(tracks),
    captionTracksIsArray: Array.isArray(tracks),
    captionTracksCount: Array.isArray(tracks) ? tracks.length : 0,
    ytInitialDataExists: Boolean(ytInitialData),
    ytInitialDataKeys,
    ytInitialPlayerConfigExists: Boolean(ytInitialPlayerConfig),
    ytInitialPlayerConfigKeys,
    alternativeCaptionMetadataPath: Boolean(globalWindow.ytInitialData || globalWindow.ytInitialPlayerConfig || globalWindow.ytInitialPlayerResponse)
  };

  if (!tracks || !Array.isArray(tracks)) {
    return {
      success: false,
      error: 'YouTube caption tracks are not available',
      diagnostics
    };
  }

  // The language of the audio the viewer is hearing. Videos with several
  // audio tracks (e.g. YouTube's AI dubs) play one picked from the viewer's
  // locale, so this can differ from the original language. While playing,
  // getAudioTrack().id is "<itag>;<base64url protobuf xtags>", and the xtags
  // carry a "lang" entry. Before playback (id "und") fall back to the stream
  // marked as the default audio, whose id looks like "es-US.4".
  const readXtagsLanguage = (trackId: string): string | undefined => {
    const xtags = trackId.split(';')[1];
    if (!xtags) {
      return undefined;
    }
    try {
      const bytes = atob(xtags.replace(/-/g, '+').replace(/_/g, '/'));
      // Each xtag is a key/value pair of length-prefixed strings: ...\x04lang\x12<len><value>
      const keyIndex = bytes.indexOf('\x04lang\x12');
      if (keyIndex < 0) {
        return undefined;
      }
      const valueStart = keyIndex + 6;
      return bytes.substr(valueStart + 1, bytes.charCodeAt(valueStart)) || undefined;
    } catch {
      return undefined;
    }
  };

  let audioLanguage: { languageCode: string; source: 'playing' | 'default' } | undefined;
  try {
    const playingId = moviePlayer?.getAudioTrack?.()?.id;
    const playingLanguage = typeof playingId === 'string' ? readXtagsLanguage(playingId) : undefined;
    if (playingLanguage) {
      audioLanguage = { languageCode: playingLanguage, source: 'playing' };
    }
  } catch {
    // Player API unavailable; use the default audio stream below.
  }
  if (!audioLanguage) {
    const defaultAudioId = playerResponse?.streamingData?.adaptiveFormats
      ?.find(format => format.audioTrack?.audioIsDefault)?.audioTrack?.id;
    const defaultLanguage = defaultAudioId?.split('.')[0];
    if (defaultLanguage) {
      audioLanguage = { languageCode: defaultLanguage, source: 'default' };
    }
  }

  return {
    success: true,
    tracks: tracks.map(track => ({
      languageCode: track.languageCode,
      name: track.name,
      baseUrl: track.baseUrl,
      kind: track.kind
    })),
    audioLanguage,
    defaultCaptionTrackIndex: renderer?.audioTracks?.[renderer.defaultAudioTrackIndex ?? 0]?.defaultCaptionTrackIndex,
    videoDetails: {
      title: playerResponse?.videoDetails?.title,
      lengthSeconds: playerResponse?.videoDetails?.lengthSeconds
    },
    diagnostics
  };
}

function isDiscoverTracksMessage(message: unknown): message is DiscoverTracksMessage {
  if (typeof message !== 'object' || message === null || !('type' in message) || !('tabId' in message) || !('videoId' in message)) {
    return false;
  }

  const typed = message as { type?: string; tabId?: unknown; videoId?: unknown };
  if (typed.type !== 'DISCOVER_CAPTION_TRACKS') {
    return false;
  }

  if (!Number.isInteger(typed.tabId) || typeof typed.tabId !== 'number' || typed.tabId < 0) {
    return false;
  }

  return typeof typed.videoId === 'string' && typed.videoId.trim().length > 0;
}

function isFetchCaptionResourceMessage(message: unknown): message is FetchCaptionResourceMessage {
  if (typeof message !== 'object' || message === null || !('type' in message) || !('tabId' in message) || !('captionUrl' in message)) {
    return false;
  }

  const typed = message as { type?: string; tabId?: unknown; captionUrl?: unknown };
  if (typed.type !== 'FETCH_CAPTION_RESOURCE_MAIN_WORLD') {
    return false;
  }

  if (!Number.isInteger(typed.tabId) || typeof typed.tabId !== 'number' || typed.tabId < 0) {
    return false;
  }

  return typeof typed.captionUrl === 'string' && isYouTubeCaptionUrl(typed.captionUrl);
}

// The caption fetch runs with the user's YouTube cookies, so it may only
// reach YouTube's caption endpoint.
function isYouTubeCaptionUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'www.youtube.com' && url.pathname === '/api/timedtext';
  } catch {
    return false;
  }
}

addLamissMessageListener((message: unknown, _sender, sendResponse) => {
  if (!isFetchCaptionResourceMessage(message)) {
    return false;
  }

  const tabId = message.tabId;
  const requestedCaptionUrl = message.captionUrl;

  const apiAvailable = Boolean(chrome.scripting && typeof chrome.scripting.executeScript === 'function');
  if (!apiAvailable) {
    sendResponse({
      success: false,
      error: 'chrome.scripting API is unavailable in this context'
    });
    return true;
  }

  (async () => {
    try {
      const potToken = await ensureFreshPotToken(tabId);
      let captionUrl = requestedCaptionUrl;

      if (potToken?.pot) {
        const urlWithPot = new URL(captionUrl);
        urlWithPot.searchParams.set('pot', potToken.pot);
        if (potToken.potc) {
          urlWithPot.searchParams.set('potc', potToken.potc);
        }
        for (const [key, value] of Object.entries(potToken.clientParams)) {
          urlWithPot.searchParams.set(key, value);
        }
        captionUrl = urlWithPot.toString();
        console.log('Lamiss POC: pot token attached to caption request = true');
      } else {
        console.log('Lamiss POC: pot token attached to caption request = false');
      }

      console.log('Lamiss POC: caption fetch executing in MAIN world = true');
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN' as chrome.scripting.ExecutionWorld,
        func: fetchCaptionResourceMainWorld,
        args: [captionUrl]
      });

      const result = results[0]?.result as FetchCaptionResourceMainWorldResult | undefined;
      if (!result) {
        sendResponse({
          success: false,
          error: 'Unable to fetch caption resource in MAIN world'
        });
        return;
      }

      console.log('Lamiss POC: MAIN caption HTTP request completed = true');
      console.log('Lamiss POC: MAIN caption HTTP status =', result.status);
      console.log('Lamiss POC: MAIN caption response ok =', result.ok ? 'true' : 'false');
      console.log('Lamiss POC: MAIN caption response content-type =', result.contentType);
      console.log('Lamiss POC: MAIN caption response text length =', result.text.length);

      sendResponse({
        success: true,
        ok: result.ok,
        status: result.status,
        contentType: result.contentType,
        text: result.text
      });
    } catch (error) {
      console.log('Lamiss POC: MAIN caption HTTP request completed = false');
      console.log('Lamiss POC: MAIN caption fetch error =', error instanceof Error ? error.message : String(error));
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  })();

  return true;
});

addLamissMessageListener((message: unknown, _sender, _sendResponse) => {
  if (!isDiscoverTracksMessage(message)) {
    if ((message as { type?: unknown } | null)?.type === 'DISCOVER_CAPTION_TRACKS') {
      console.log('Lamiss POC: malformed DISCOVER_CAPTION_TRACKS message received');
    }
    return false;
  }

  const tabId = message.tabId;
  const expectedVideoId = message.videoId;
  const apiAvailable = Boolean(chrome.scripting && typeof chrome.scripting.executeScript === 'function');

  console.log('Lamiss POC: chrome.scripting available =', apiAvailable ? 'true' : 'false');

  if (!apiAvailable) {
    console.log('Lamiss POC: chrome.scripting API is unavailable');
    chrome.tabs.sendMessage(tabId, {
      type: 'CAPTION_DISCOVERY_RESULT',
      result: {
        success: false,
        error: 'chrome.scripting API is unavailable in this context'
      }
    });
    return false;
  }

  console.log('Lamiss POC: executing caption discovery in MAIN world');

  (async () => {
    try {
      const startedAt = Date.now();
      let lastResult: ReturnType<typeof discoverCaptionTracksMainWorld> | undefined;

      while (Date.now() - startedAt < 5000) {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN' as chrome.scripting.ExecutionWorld,
          func: discoverCaptionTracksMainWorld,
          args: [expectedVideoId]
        });

        const result = results[0]?.result as ReturnType<typeof discoverCaptionTracksMainWorld> | undefined;
        if (result?.success) {
          const trackList = Array.isArray(result.tracks) ? result.tracks : [];
          if (trackList.length > 0) {
            lastResult = result;
            break;
          }
        }

        await new Promise(resolve => setTimeout(resolve, 250));
      }

      console.log('Lamiss POC: MAIN world execution completed');

      chrome.tabs.sendMessage(tabId, {
        type: 'CAPTION_DISCOVERY_RESULT',
        result: lastResult ?? {
          success: false,
          error: 'YouTube caption tracks are not available'
        }
      });
    } catch (error) {
      console.log('Lamiss POC: caption tracks discovered = false');
      console.log('Lamiss POC: diagnostic error =', error instanceof Error ? error.message : String(error));
      chrome.tabs.sendMessage(tabId, {
        type: 'CAPTION_DISCOVERY_RESULT',
        result: {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
  })();

  return true;
});

// ---------------------------------------------------------------------------
// Live connection for Lamiss's proactive questions. Each watch tab opens a
// port; the worker turns it into a WebSocket to the backend, because the
// worker can reach the backend while youtube.com pages may not. The tab's
// heartbeats keep this worker alive; if it is stopped anyway, the port
// disconnects and the tab connects again.
// ---------------------------------------------------------------------------

const LAMISS_LIVE_PORT_NAME = 'lamiss-live';
const LAMISS_LIVE_MAX_BACKOFF_MS = 30_000;
const WEBSOCKET_POLICY_VIOLATION = 1008;
// The ticket or the sign-in behind it was not accepted (TDR-0001).
const WEBSOCKET_UNAUTHENTICATED = 4401;

type LamissServerMessage =
  | { type: 'PAUSE_VIDEO' }
  | { type: 'ASK_QUESTION'; eventId: string; question: string }
  | { type: 'FEEDBACK'; correct: boolean; feedback: string }
  | { type: 'RESUME_VIDEO' }
  | { type: 'ERROR'; message: string }
  // When the next question will come if the video keeps playing; atVideoMs
  // is null when none is coming.
  | { type: 'NEXT_QUESTION'; atVideoMs: number | null; waitingForAnswer: boolean };

type LamissLiveClientMessage =
  | { type: 'start'; videoId: string }
  // playing: false reports where a paused viewer is; it never triggers a question.
  | { type: 'position'; positionMs: number; playing?: boolean }
  | { type: 'answer'; answeredTo: string; answer: string; language?: string }
  | { type: 'listen'; requestId: string }
  | { type: 'stop-listening'; requestId: string; discard: boolean }
  | { type: 'speak'; requestId: string; text: string; language?: string }
  | { type: 'stop-speaking'; requestId: string }
  | { type: 'keepalive' };

// Progress of a spoken answer, reported by the offscreen recorder.
type LamissListenEvent =
  | { type: 'listening'; noSpeechTimeoutMs: number }
  | { type: 'speech-started' }
  | { type: 'no-speech' }
  | { type: 'transcribing' }
  | { type: 'transcribed'; text: string; language?: string }
  | { type: 'failed'; error: string; micDenied?: boolean };

type LamissLiveState = 'connecting' | 'connected' | 'reconnecting' | 'failed';

type LamissLiveWorkerMessage =
  | { type: 'status'; state: LamissLiveState; detail?: string }
  | { type: 'server'; message: LamissServerMessage }
  | { type: 'answer-queued' }
  | { type: 'listen-event'; requestId: string; event: LamissListenEvent }
  | { type: 'speech-event'; requestId: string; event: LamissSpeechEvent };

// Lamiss's voice, played by the offscreen document.
type LamissSpeechEvent = { type: 'started' } | { type: 'ended' } | { type: 'failed'; error: string };

type LamissPendingQuestion = { eventId: string; question: string };

type LamissLiveConnection = {
  port: chrome.runtime.Port;
  videoId?: string;
  learningSessionId?: number;
  socket?: WebSocket;
  // The last answer sent, shown in the chat panel next to its feedback.
  lastAnswer?: string;
  connectedBefore?: boolean;
  attempt: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  closed: boolean;
  // The access token the current socket's ticket was obtained with.
  accessToken?: string;
  // Bumped by every new connection attempt; an older attempt stops at its next step.
  generation: number;
};

const liveConnections = new Set<LamissLiveConnection>();

async function sendQuestionSettings(socket: WebSocket): Promise<void> {
  const settings = await readQuestionSettings();
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'QUESTION_SETTINGS', ...settings }));
  }
}

// The sliders in the chat panel apply right away to every open connection.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[LAMISS_QUESTION_SETTINGS_KEY]) {
    return;
  }
  for (const live of liveConnections) {
    if (live.socket) {
      void sendQuestionSettings(live.socket);
    }
  }
});

function postLive(live: LamissLiveConnection, message: LamissLiveWorkerMessage): void {
  if (live.closed) {
    return;
  }
  try {
    live.port.postMessage(message);
  } catch {
    live.closed = true;
  }
}

// The backend never repeats a question that is asked but unanswered, and it
// asks nothing new until that one is answered. Remember it here so a dropped
// socket, a restarted worker or a page reload can show it again.
function pendingQuestionKey(learningSessionId: number): string {
  return `lamissPendingQuestion:${learningSessionId}`;
}

async function readPendingQuestion(learningSessionId: number): Promise<LamissPendingQuestion | undefined> {
  const key = pendingQuestionKey(learningSessionId);
  const stored = await chrome.storage.local.get(key);
  return stored[key] as LamissPendingQuestion | undefined;
}

function scheduleLiveReconnect(live: LamissLiveConnection, detail: string): void {
  if (live.closed) {
    return;
  }
  const delay = Math.min(1000 * 2 ** live.attempt, LAMISS_LIVE_MAX_BACKOFF_MS);
  live.attempt += 1;
  postLive(live, { type: 'status', state: 'reconnecting', detail });
  live.retryTimer = setTimeout(() => void connectLive(live), delay);
}

// The live connection and the chat panel both need the video's session and
// ask for it at the same moment; separate requests would make the backend
// start two sessions, splitting the conversation. They share one request.
const learningSessionRequests = new Map<string, Promise<LamissCallResult<LamissLearningSession>>>();

function startSharedLearningSession(videoId: string): Promise<LamissCallResult<LamissLearningSession>> {
  let request = learningSessionRequests.get(videoId);
  if (!request) {
    request = startLearningSession(videoId).finally(() => learningSessionRequests.delete(videoId));
    learningSessionRequests.set(videoId, request);
  }
  return request;
}

addLamissMessageListener((message: { type?: string; videoId?: unknown }, _sender, sendResponse) => {
  if (message?.type !== LAMISS_START_SESSION_MESSAGE || typeof message.videoId !== 'string') {
    return false;
  }
  void startSharedLearningSession(message.videoId).then(sendResponse);
  return true;
});

// Mirrors the live conversation into the tab's chat panel, if it's open.
function postLiveLog(live: LamissLiveConnection, event: LamissLiveLogEvent): void {
  const tabId = live.port.sender?.tab?.id;
  if (tabId === undefined || live.learningSessionId === undefined) {
    return;
  }
  const message: LamissLiveLogMessage = { source: LAMISS_LIVE_LOG_SOURCE, tabId, learningSessionId: live.learningSessionId, event };
  // Rejects when no chat panel is open to receive it.
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}

async function connectLive(live: LamissLiveConnection): Promise<void> {
  if (live.closed || !live.videoId) {
    return;
  }
  const generation = ++live.generation;
  const superseded = () => live.closed || live.generation !== generation;

  // Signed out: nothing to connect to until the user signs in.
  const accessToken = await readAccessToken();
  if (superseded()) {
    return;
  }
  if (!accessToken) {
    postLive(live, { type: 'status', state: 'failed', detail: LAMISS_SIGN_IN_REQUIRED_MESSAGE });
    return;
  }

  if (live.learningSessionId === undefined) {
    const session = await startSharedLearningSession(live.videoId);
    if (superseded()) {
      return;
    }
    if (!session.ok) {
      if (session.retryable) {
        scheduleLiveReconnect(live, session.error);
      } else {
        postLive(live, { type: 'status', state: 'failed', detail: session.error });
      }
      return;
    }
    live.learningSessionId = session.data.learningSessionId;
  }

  const learningSessionId = live.learningSessionId;
  // A single-use ticket proves who opens the socket; it is valid for 30 s.
  const ticket = await callLamiss<{ ticket: string; expiresAt: string }>('/api/auth/ws-ticket', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ learningSessionId })
  }, { accessToken });
  if (superseded()) {
    return;
  }
  if (!ticket.ok || typeof ticket.data?.ticket !== 'string') {
    const detail = ticket.ok ? 'Lamiss sent no connection ticket' : ticket.error;
    if (!ticket.ok && ticket.retryable) {
      scheduleLiveReconnect(live, detail);
    } else {
      postLive(live, { type: 'status', state: 'failed', detail });
    }
    return;
  }

  const socket = new WebSocket(`${LAMISS_WS_BASE_URL}/ws/learning-sessions/${learningSessionId}?ticket=${encodeURIComponent(ticket.data.ticket)}`);
  live.socket = socket;
  live.accessToken = accessToken;

  socket.addEventListener('open', () => {
    live.attempt = 0;
    void sendQuestionSettings(socket);
    postLive(live, { type: 'status', state: 'connected' });
    if (live.connectedBefore) {
      postLiveLog(live, { type: 'resync' });
    }
    live.connectedBefore = true;
    void readPendingQuestion(learningSessionId).then((pending) => {
      if (pending && live.socket === socket) {
        postLive(live, { type: 'server', message: { type: 'PAUSE_VIDEO' } });
        postLive(live, { type: 'server', message: { type: 'ASK_QUESTION', ...pending } });
      }
    });
  });

  socket.addEventListener('message', (event) => {
    let message: LamissServerMessage;
    try {
      message = JSON.parse(String(event.data)) as LamissServerMessage;
    } catch {
      console.warn('Lamiss POC: ignoring a non-JSON message from Lamiss:', event.data);
      return;
    }

    if (message.type === 'ASK_QUESTION') {
      void chrome.storage.local.set({ [pendingQuestionKey(learningSessionId)]: { eventId: message.eventId, question: message.question } });
      postLiveLog(live, { type: 'lamiss-asked', question: message.question });
    } else if (message.type === 'FEEDBACK') {
      // Feedback means the backend has stored the answer.
      void chrome.storage.local.remove(pendingQuestionKey(learningSessionId));
      // A restarted worker has lost the answer; the history has it.
      postLiveLog(live, live.lastAnswer === undefined
        ? { type: 'resync' }
        : { type: 'answered', answer: live.lastAnswer, feedback: message.feedback });
      live.lastAnswer = undefined;
    } else if (message.type === 'ERROR') {
      console.warn('Lamiss POC: Lamiss reported an error:', message.message);
    }
    postLive(live, { type: 'server', message });
  });

  socket.addEventListener('close', (event) => {
    if (live.socket !== socket || live.closed) {
      return;
    }
    live.socket = undefined;
    if (event.code === WEBSOCKET_UNAUTHENTICATED) {
      void onLiveUnauthenticated(live, accessToken);
      return;
    }
    if (event.code === WEBSOCKET_POLICY_VIOLATION) {
      // Not a participant of the session: retrying can't fix that.
      console.error('Lamiss POC: Lamiss refused the live connection:', event.reason);
      postLive(live, { type: 'status', state: 'failed', detail: event.reason || 'Lamiss refused the connection' });
      return;
    }
    scheduleLiveReconnect(live, event.reason || 'The connection to Lamiss dropped');
  });
}

// Close code 4401 for a socket opened with socketToken. If the user has
// signed in again since, this is the old session: move to the new one.
// Otherwise the sign-in was revoked or ran out, and reconnecting can't fix it.
async function onLiveUnauthenticated(live: LamissLiveConnection, socketToken: string): Promise<void> {
  const current = await readAccessToken();
  if (live.closed) {
    return;
  }
  if (current && current !== socketToken) {
    live.learningSessionId = undefined;
    void connectLive(live);
    return;
  }
  console.error('Lamiss POC: Lamiss did not accept the sign-in for the live connection');
  postLive(live, { type: 'status', state: 'failed', detail: LAMISS_SIGN_IN_AGAIN_MESSAGE });
  await lamissOnSessionRejected(socketToken);
}

// A new session was stored: sockets (or attempts that failed) under any other
// token move to it.
function reconnectLiveConnections(accessToken: string): void {
  for (const live of liveConnections) {
    if (live.closed || !live.videoId || live.accessToken === accessToken) {
      continue;
    }
    clearTimeout(live.retryTimer);
    const socket = live.socket;
    // Cleared first, so its close event is ignored.
    live.socket = undefined;
    live.accessToken = undefined;
    socket?.close(1000, 'Signed in again');
    live.learningSessionId = undefined;
    live.attempt = 0;
    postLive(live, { type: 'status', state: 'connecting' });
    void connectLive(live);
  }
}

function onLiveClientMessage(live: LamissLiveConnection, message: LamissLiveClientMessage): void {
  const socket = live.socket?.readyState === WebSocket.OPEN ? live.socket : undefined;

  switch (message.type) {
    case 'start':
      if (!live.videoId && typeof message.videoId === 'string') {
        live.videoId = message.videoId;
        postLive(live, { type: 'status', state: 'connecting' });
        void connectLive(live);
      }
      break;
    case 'position':
      if (Number.isFinite(message.positionMs)) {
        socket?.send(JSON.stringify({
          type: 'VIDEO_POSITION',
          positionMs: Math.max(0, Math.round(message.positionMs)),
          ...(message.playing === false ? { playing: false } : {})
        }));
      }
      break;
    case 'answer':
      // While offline the tab keeps the answer and sends it again on 'connected'.
      if (socket) {
        live.lastAnswer = message.answer;
        // language only comes with a spoken answer: what the transcription heard.
        socket.send(JSON.stringify({
          type: 'ANSWER',
          answeredTo: message.answeredTo,
          answer: message.answer,
          ...(message.language ? { language: message.language } : {})
        }));
      } else {
        postLive(live, { type: 'answer-queued' });
      }
      break;
    case 'listen':
      listeningPorts.set(message.requestId, live);
      // The offscreen document can't read the token; it comes with the request.
      void readAccessTokenForOffscreen()
        .then(async (accessToken) => {
          await ensureOffscreenRecorder();
          await chrome.runtime.sendMessage({ target: 'lamiss-offscreen', type: 'listen', requestId: message.requestId, accessToken });
        })
        .catch((error: unknown) => {
          listeningPorts.delete(message.requestId);
          postLive(live, {
            type: 'listen-event',
            requestId: message.requestId,
            event: { type: 'failed', error: error instanceof Error ? error.message : String(error) }
          });
        });
      break;
    case 'stop-listening':
      void chrome.runtime.sendMessage({ target: 'lamiss-offscreen', type: 'stop-listening', requestId: message.requestId, discard: message.discard === true }).catch(() => undefined);
      break;
    case 'stop-speaking':
      void chrome.runtime.sendMessage({ target: 'lamiss-offscreen', type: 'stop-speaking', requestId: message.requestId }).catch(() => undefined);
      break;
    case 'speak':
      speakingPorts.set(message.requestId, live);
      void readAccessTokenForOffscreen()
        .then(async (accessToken) => {
          await ensureOffscreenRecorder();
          await chrome.runtime.sendMessage({
            target: 'lamiss-offscreen',
            type: 'speak',
            requestId: message.requestId,
            text: message.text,
            language: message.language,
            accessToken
          });
        })
        .catch((error: unknown) => {
          speakingPorts.delete(message.requestId);
          postLive(live, {
            type: 'speech-event',
            requestId: message.requestId,
            event: { type: 'failed', error: error instanceof Error ? error.message : String(error) }
          });
        });
      break;
    case 'keepalive':
      // Receiving it is enough: it resets the worker's idle timer.
      break;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== LAMISS_LIVE_PORT_NAME) {
    return;
  }
  // Only the content script of a YouTube tab opens the live connection.
  if (classifyLamissSender(port.sender) !== 'content') {
    console.warn('Lamiss POC: refused a live connection from an unexpected sender');
    port.disconnect();
    return;
  }

  const live: LamissLiveConnection = { port, attempt: 0, closed: false, generation: 0 };
  liveConnections.add(live);
  port.onMessage.addListener((message: LamissLiveClientMessage) => onLiveClientMessage(live, message));
  port.onDisconnect.addListener(() => {
    liveConnections.delete(live);
    live.closed = true;
    clearTimeout(live.retryTimer);
    live.socket?.close(1000, 'Tab left the video');
  });
});

// ---------------------------------------------------------------------------
// Spoken answers. Recording happens in an offscreen document: it has the
// extension's microphone permission, which youtube.com pages don't.
// ---------------------------------------------------------------------------

const OFFSCREEN_RECORDER_URL = 'offscreen/offscreen.html';
const listeningPorts = new Map<string, LamissLiveConnection>();
const speakingPorts = new Map<string, LamissLiveConnection>();
let offscreenRecorderCreating: Promise<void> | null = null;

async function ensureOffscreenRecorder(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_RECORDER_URL)]
  });
  if (existing.length > 0) {
    return;
  }
  offscreenRecorderCreating ??= chrome.offscreen.createDocument({
    url: OFFSCREEN_RECORDER_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.AUDIO_PLAYBACK],
    justification: 'Record the user\'s spoken answers to Lamiss\'s questions and read Lamiss\'s questions aloud'
  }).finally(() => {
    offscreenRecorderCreating = null;
  });
  await offscreenRecorderCreating;
}

addLamissMessageListener((message: { source?: string; requestId?: string; speech?: LamissSpeechEvent }) => {
  if (message?.source !== 'lamiss-offscreen' || !message.requestId || !message.speech) {
    return false;
  }
  const live = speakingPorts.get(message.requestId);
  if (message.speech.type !== 'started') {
    speakingPorts.delete(message.requestId);
  }
  if (live) {
    postLive(live, { type: 'speech-event', requestId: message.requestId, event: message.speech });
  }
  return false;
});

addLamissMessageListener((message: { source?: string; requestId?: string; event?: LamissListenEvent }) => {
  if (message?.source !== 'lamiss-offscreen' || !message.requestId || !message.event) {
    return false;
  }
  const live = listeningPorts.get(message.requestId);
  const event = message.event;
  if (['no-speech', 'transcribed', 'failed'].includes(event.type)) {
    listeningPorts.delete(message.requestId);
  }
  if (event.type === 'failed' && event.micDenied) {
    // Offscreen documents can't show the permission prompt; this tab can.
    void chrome.tabs.create({ url: chrome.runtime.getURL('permission/permission.html') });
  }
  if (live) {
    postLive(live, { type: 'listen-event', requestId: message.requestId, event });
  }
  return false;
});

// ---------------------------------------------------------------------------
// Google sign-in (TDR-0001). The worker owns it: it asks the backend for a
// nonce, runs Google's sign-in in chrome.identity's window, checks the state
// it sent, and exchanges Google's ID token for a Lamiss access token, kept
// until sign-out (see shared/lamiss-auth.ts). Content scripts never receive it.
// ---------------------------------------------------------------------------

// Silent sign-ins are rare: when no sign-in is stored, or it was rejected.
const LAMISS_SILENT_SIGN_IN_KEY = 'lamissSilentSignInAt';
const LAMISS_SILENT_SIGN_IN_INTERVAL_MS = 5 * 60_000;
const LAMISS_SILENT_SIGN_IN_TIMEOUT_MS = 10_000;

type LamissNonceResponse = { nonce: string; expiresAt: string };

// Chrome's default, set explicitly: content scripts must never read the token.
void chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined);

lamissOnSessionRejected = async (rejectedToken) => {
  if (await rejectAuthSession(rejectedToken)) {
    void trySilentSignIn();
  }
};

async function readAccessTokenForOffscreen(): Promise<string> {
  const accessToken = await readAccessToken();
  if (!accessToken) {
    throw new Error(LAMISS_SIGN_IN_REQUIRED_MESSAGE);
  }
  return accessToken;
}

function launchGoogleAuthFlow(url: string, interactive: boolean): Promise<string | undefined> {
  return chrome.identity.launchWebAuthFlow(interactive
    ? { url, interactive: true }
    // Google may finish a prompt=none flow with a script redirect, so the
    // flow waits for it instead of stopping at the first page load.
    : { url, interactive: false, abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: LAMISS_SILENT_SIGN_IN_TIMEOUT_MS });
}

async function runGoogleSignIn(interactive: boolean): Promise<LamissSignInResult> {
  if (!LAMISS_GOOGLE_CLIENT_ID) {
    return { ok: false, reason: 'not_configured', error: 'Google sign-in is not set up in this build (LAMISS_GOOGLE_CLIENT_ID).' };
  }

  const nonce = await callLamiss<LamissNonceResponse>('/api/auth/nonce', {
    method: 'POST',
    headers: { accept: 'application/json' }
  }, { anonymous: true });
  if (!nonce.ok || typeof nonce.data?.nonce !== 'string') {
    return { ok: false, reason: 'failed', error: nonce.ok ? 'Lamiss could not start the sign-in.' : nonce.error };
  }

  const state = randomUrlSafeString();
  const redirectUri = chrome.identity.getRedirectURL();
  const url = buildGoogleAuthUrl({ clientId: LAMISS_GOOGLE_CLIENT_ID, redirectUri, nonce: nonce.data.nonce, state, interactive });

  let redirect: string | undefined;
  try {
    redirect = await launchGoogleAuthFlow(url, interactive);
  } catch (error) {
    return { ok: false, ...describeAuthFlowError(error, interactive) };
  }
  if (!redirect) {
    return { ok: false, reason: 'cancelled', error: 'Sign-in was cancelled.' };
  }

  const parsed = parseAuthRedirect(redirect, { redirectUri, state, nonce: nonce.data.nonce });
  if (!parsed.ok) {
    return parsed;
  }

  const exchanged = await callLamiss<unknown>('/api/auth/google', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ idToken: parsed.idToken })
  }, { anonymous: true });
  if (!exchanged.ok) {
    return { ok: false, reason: 'rejected', error: exchanged.error };
  }
  const session = readGoogleSignInResponse(exchanged.data);
  if (!session) {
    return { ok: false, reason: 'failed', error: 'Lamiss sent an unexpected sign-in response.' };
  }

  // Signing in as someone else ends the previous session first.
  const previousToken = await readStoredAccessToken();
  await storeAuthSession(session);
  await chrome.storage.local.set({ [LAMISS_SIGNED_IN_BEFORE_KEY]: true });
  reconnectLiveConnections(session.accessToken);
  if (previousToken && previousToken !== session.accessToken) {
    void revokeAccessToken(previousToken);
  }

  const signedIn = await readAuthState();
  await broadcastAuthState(signedIn);
  return { ok: true, state: signedIn };
}

// One sign-in at a time. A click during a silent attempt waits for it and
// opens the Google window only if the silent attempt failed.
let lamissSignInFlight: { interactive: boolean; result: Promise<LamissSignInResult> } | null = null;

async function signInWithGoogle(interactive: boolean): Promise<LamissSignInResult> {
  const running = lamissSignInFlight;
  if (running) {
    const result = await running.result;
    if (result.ok || running.interactive || !interactive) {
      return result;
    }
  }
  if (lamissSignInFlight) {
    return lamissSignInFlight.result;
  }
  const flight = {
    interactive,
    result: runGoogleSignIn(interactive)
      .catch((error: unknown): LamissSignInResult => ({ ok: false, reason: 'failed', error: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        if (lamissSignInFlight === flight) {
          lamissSignInFlight = null;
        }
      })
  };
  lamissSignInFlight = flight;
  return flight.result;
}

// When no sign-in is stored or the backend rejected it, try once without
// showing anything; the sign-in button is the fallback.
async function trySilentSignIn(): Promise<void> {
  try {
    if (!LAMISS_GOOGLE_CLIENT_ID || (await readAuthState()).status === 'signedIn') {
      return;
    }
    const local = await chrome.storage.local.get(LAMISS_SIGNED_IN_BEFORE_KEY);
    if (local[LAMISS_SIGNED_IN_BEFORE_KEY] !== true) {
      return;
    }
    const session = await chrome.storage.session.get(LAMISS_SILENT_SIGN_IN_KEY);
    const lastAttempt = Number(session[LAMISS_SILENT_SIGN_IN_KEY] ?? 0);
    if (Date.now() - lastAttempt < LAMISS_SILENT_SIGN_IN_INTERVAL_MS) {
      return;
    }
    await chrome.storage.session.set({ [LAMISS_SILENT_SIGN_IN_KEY]: Date.now() });
    const result = await signInWithGoogle(false);
    if (!result.ok) {
      console.log('Lamiss POC: silent sign-in did not complete:', result.reason);
    }
  } catch (error) {
    console.warn('Lamiss POC: silent sign-in failed:', error instanceof Error ? error.message : String(error));
  }
}

// Best effort: a failed or rejected logout still ends the session locally.
async function revokeAccessToken(accessToken: string): Promise<void> {
  try {
    await fetch(`${LAMISS_API_BASE_URL}/api/auth/logout`, withAuthorization({ method: 'POST' }, accessToken));
  } catch {
    // Offline: the session runs out on its own.
  }
}

// Live connections belong to the signed-in user.
function closeAllLiveConnections(detail: string): void {
  for (const live of liveConnections) {
    postLive(live, { type: 'status', state: 'failed', detail });
    live.closed = true;
    clearTimeout(live.retryTimer);
    live.socket?.close(1000, 'Signed out');
    live.socket = undefined;
    try {
      live.port.disconnect();
    } catch {
      // Already gone.
    }
  }
  liveConnections.clear();
  for (const requestId of listeningPorts.keys()) {
    void chrome.runtime.sendMessage({ target: 'lamiss-offscreen', type: 'stop-listening', requestId, discard: true }).catch(() => undefined);
  }
  for (const requestId of speakingPorts.keys()) {
    void chrome.runtime.sendMessage({ target: 'lamiss-offscreen', type: 'stop-speaking', requestId }).catch(() => undefined);
  }
  listeningPorts.clear();
  speakingPorts.clear();
  learningSessionRequests.clear();
}

async function signOutOfLamiss(): Promise<LamissAuthState> {
  const accessToken = await readStoredAccessToken();
  // Forget the token first, so a slow or failed logout call can't keep it.
  await clearAuthSession();
  await chrome.storage.local.remove(LAMISS_SIGNED_IN_BEFORE_KEY);
  await removePendingQuestions();
  closeAllLiveConnections(LAMISS_SIGN_IN_REQUIRED_MESSAGE);
  const signedOut: LamissAuthState = { status: 'signedOut' };
  await broadcastAuthState(signedOut);
  if (accessToken) {
    await revokeAccessToken(accessToken);
  }
  return signedOut;
}

// The offscreen document saw a 401. Ask the backend whether the session is
// really gone; callLamiss marks it expired if so.
// Only for the token the offscreen document used: a 401 for an older session
// says nothing about the current one.
async function verifyAuthSession(rejectedToken: unknown): Promise<void> {
  const current = await readAccessToken();
  if (current && typeof rejectedToken === 'string' && rejectedToken === current) {
    await callLamiss<LamissAuthUser>('/api/auth/me', { headers: { accept: 'application/json' } }, { accessToken: current });
  }
}

addLamissMessageListener((message: { type?: string; state?: { status?: string } }, sender, sendResponse) => {
  const fromContentScript = classifyLamissSender(sender) === 'content';
  switch (message?.type) {
    case LAMISS_AUTH_STATE_MESSAGE:
      void readAuthState().then((state) => {
        sendResponse(fromContentScript ? { status: state.status } : state);
        if (state.status !== 'signedIn') {
          void trySilentSignIn();
        }
      });
      return true;
    case LAMISS_SIGN_IN_MESSAGE:
      void signInWithGoogle(true).then((result) => {
        sendResponse(fromContentScript && result.ok ? { ok: true, state: { status: result.state.status } } : result);
      });
      return true;
    case LAMISS_SIGN_OUT_MESSAGE:
      void signOutOfLamiss().then(sendResponse);
      return true;
    case LAMISS_SESSION_REJECTED_MESSAGE:
      void verifyAuthSession((message as { rejectedToken?: unknown }).rejectedToken);
      return false;
    case LAMISS_AUTH_CHANGED_MESSAGE:
      // A page saw its session rejected.
      if (message.state?.status === 'expired') {
        void trySilentSignIn();
      }
      return false;
  }
  return false;
});

chrome.runtime.onStartup.addListener(() => {
  void trySilentSignIn();
});
