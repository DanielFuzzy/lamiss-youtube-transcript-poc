"use strict";
let pendingSendResponse = null;
let pendingVideoId;
let pendingVideoDetails;
let pendingTabId = -1;
function fetchCaptionResourceInMainWorld(tabId, captionUrl) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({
            type: 'FETCH_CAPTION_RESOURCE_MAIN_WORLD',
            tabId,
            captionUrl
        }, (response) => {
            if (chrome.runtime.lastError) {
                resolve({ success: false, error: chrome.runtime.lastError.message });
                return;
            }
            resolve(response);
        });
    });
}
// Shared by the popup's LOAD_TRANSCRIPT message and the in-page Lamiss button.
// `respond` is called exactly once, by whichever step finishes the load.
function startTranscriptLoad(tabId, respond) {
    const parsed = parseYouTubeWatchUrl(window.location.href);
    if (!parsed.success) {
        console.log('Lamiss POC: videoId = unavailable');
        respond({ success: false, error: parsed.error ?? 'Unable to parse YouTube page' });
        return;
    }
    pendingVideoId = parsed.videoId;
    pendingVideoDetails = undefined;
    pendingSendResponse = respond;
    pendingTabId = tabId;
    console.log('Lamiss POC: videoId =', parsed.videoId);
    console.log('Lamiss POC: page player response discovered = true');
    chrome.runtime.sendMessage({
        type: 'DISCOVER_CAPTION_TRACKS',
        tabId,
        videoId: parsed.videoId
    });
    console.log('Lamiss POC: caption request started');
}
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isLoadTranscriptMessage(message)) {
        return false;
    }
    (async () => {
        try {
            console.log('Lamiss POC: LOAD_TRANSCRIPT message received = true');
            if (!Number.isInteger(message.tabId)) {
                console.log('Lamiss POC: active tab ID received = false');
                sendResponse({ success: false, error: 'Active tab ID is unavailable' });
                return;
            }
            console.log('Lamiss POC: active tab ID received = true');
            startTranscriptLoad(message.tabId, sendResponse);
        }
        catch (error) {
            console.error('Lamiss POC: content script error:', error);
            if (pendingSendResponse) {
                pendingSendResponse({ success: false, error: 'Unable to process YouTube page' });
            }
        }
    })();
    return true;
});
chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
    if (!isCaptionDiscoveryResultMessage(message)) {
        return false;
    }
    const result = message.result;
    if (!result?.success) {
        console.log('Lamiss POC: caption tracks discovered = false');
        console.log('Lamiss POC: diagnostic error =', result?.error ?? 'No captions available');
        if (pendingSendResponse) {
            pendingSendResponse({ success: false, error: result?.error ?? 'No captions available' });
        }
        return true;
    }
    pendingVideoDetails = result.videoDetails;
    const captionTracks = Array.isArray(result.tracks) ? result.tracks : [];
    console.log('Lamiss POC: caption tracks discovered = true');
    console.log('Lamiss POC: caption tracks count =', captionTracks.length);
    const { track: selectedTrack, source } = selectVideoCaptionTrack(captionTracks, result.audioLanguage, result.defaultCaptionTrackIndex);
    const transcriptLanguage = selectedTrack?.languageCode ? toLamissLanguageCode(selectedTrack.languageCode) : undefined;
    if (!selectedTrack || !transcriptLanguage) {
        console.log('Lamiss POC: matching track discovered = false');
        if (pendingSendResponse) {
            pendingSendResponse({ success: false, error: 'No caption tracks are available for this video' });
        }
        return true;
    }
    console.log('Lamiss POC: matching track discovered = true');
    console.log('Lamiss POC: audio language =', result.audioLanguage?.languageCode ?? 'unknown', `(${result.audioLanguage?.source ?? 'none'})`);
    console.log('Lamiss POC: caption track source =', source);
    console.log('Lamiss POC: caption language =', selectedTrack.languageCode, '->', transcriptLanguage);
    if (!selectedTrack.baseUrl) {
        console.log('Lamiss POC: caption baseUrl obtained = false');
        if (pendingSendResponse) {
            pendingSendResponse({ success: false, error: 'Caption track URL is missing' });
        }
        return true;
    }
    console.log('Lamiss POC: caption baseUrl obtained = true');
    console.log('Lamiss POC: caption baseUrl query params redacted = true');
    console.log('Lamiss POC: caption resource URL redacted =', redactCaptionUrl(selectedTrack.baseUrl));
    const captionUrl = new URL(selectedTrack.baseUrl);
    captionUrl.searchParams.set('fmt', 'json3');
    console.log('Lamiss POC: fmt=json3 requested = true');
    console.log('Lamiss POC: caption request started');
    (async () => {
        try {
            console.log('Lamiss POC: caption fetch executing in MAIN world = true');
            const mainWorldResponse = await fetchCaptionResourceInMainWorld(pendingTabId, captionUrl.toString());
            if (!mainWorldResponse.success) {
                console.log('Lamiss POC: MAIN caption HTTP request completed = false');
                console.log('Lamiss POC: MAIN caption fetch error =', mainWorldResponse.error ?? 'Unable to fetch caption resource in MAIN world');
                if (pendingSendResponse) {
                    pendingSendResponse({ success: false, error: mainWorldResponse.error ?? 'Unable to fetch caption resource in MAIN world' });
                }
                return;
            }
            if (!mainWorldResponse.ok) {
                console.log('Lamiss POC: MAIN caption HTTP request completed = true');
                console.log('Lamiss POC: MAIN caption HTTP status =', mainWorldResponse.status);
                console.log('Lamiss POC: MAIN caption response ok = false');
                console.log('Lamiss POC: MAIN caption response content-type =', mainWorldResponse.contentType ?? 'unknown');
                if (pendingSendResponse) {
                    pendingSendResponse({ success: false, error: `Caption request failed with HTTP ${mainWorldResponse.status}` });
                }
                return;
            }
            console.log('Lamiss POC: MAIN caption HTTP request completed = true');
            console.log('Lamiss POC: MAIN caption HTTP status =', mainWorldResponse.status);
            console.log('Lamiss POC: MAIN caption response ok = true');
            console.log('Lamiss POC: MAIN caption response content-type =', mainWorldResponse.contentType ?? 'unknown');
            console.log('Lamiss POC: MAIN caption response text length =', mainWorldResponse.text?.length ?? 0);
            try {
                const data = JSON.parse(mainWorldResponse.text ?? '');
                console.log('Lamiss POC: MAIN caption JSON parse succeeded = true');
                console.log('Lamiss POC: MAIN caption events exists =', Array.isArray(data?.events) ? 'true' : 'false');
                console.log('Lamiss POC: MAIN caption events count =', Array.isArray(data?.events) ? data.events.length : 0);
                if (!isValidCaptionResponse(data)) {
                    console.log('Lamiss POC: MAIN caption events exists = false');
                    if (pendingSendResponse) {
                        pendingSendResponse({ success: false, error: 'Caption response is malformed' });
                    }
                    return;
                }
                const events = data.events;
                const eventsWithSegments = events.filter(event => Array.isArray(event.segs) && event.segs.length > 0);
                const segmentsWithText = eventsWithSegments
                    .flatMap(event => event.segs ?? [])
                    .filter((seg) => typeof seg.utf8 === 'string' && seg.utf8.trim().length > 0);
                console.log('Lamiss POC: events containing segments =', eventsWithSegments.length);
                console.log('Lamiss POC: segments containing text =', segmentsWithText.length);
                if (pendingSendResponse) {
                    pendingSendResponse({
                        success: true,
                        videoId: pendingVideoId,
                        language: transcriptLanguage,
                        translated: false,
                        videoTitle: readVideoTitle(pendingVideoDetails),
                        videoDurationSeconds: readVideoDurationSeconds(pendingVideoDetails),
                        rawCaptionResponse: data
                    });
                }
            }
            catch (jsonError) {
                console.log('Lamiss POC: MAIN caption JSON parse succeeded = false');
                console.log('Lamiss POC: MAIN caption JSON parse error =', jsonError instanceof Error ? jsonError.message : String(jsonError));
                if (pendingSendResponse) {
                    pendingSendResponse({ success: false, error: 'Unable to parse caption resource JSON' });
                }
            }
        }
        catch (error) {
            console.log('Lamiss POC: caption HTTP request completed = false');
            console.log('Lamiss POC: caption HTTP fetch error =', error instanceof Error ? error.message : String(error));
            if (pendingSendResponse) {
                pendingSendResponse({ success: false, error: 'Unable to fetch caption resource' });
            }
        }
    })();
    return true;
});
function isCaptionDiscoveryResultMessage(message) {
    return typeof message === 'object'
        && message !== null
        && 'type' in message
        && message.type === 'CAPTION_DISCOVERY_RESULT';
}
function isLoadTranscriptMessage(message) {
    return typeof message === 'object'
        && message !== null
        && 'type' in message
        && message.type === 'LOAD_TRANSCRIPT';
}
// The player response (already checked against the requested videoId) is the
// source of truth; the page DOM is only a fallback, since on YouTube's
// in-app navigation the title heading can briefly show the previous video.
function readVideoTitle(details) {
    const fromPlayer = details?.title?.trim();
    if (fromPlayer) {
        return fromPlayer;
    }
    const fromDom = document.querySelector('ytd-watch-metadata h1')?.textContent?.trim();
    return fromDom || undefined;
}
function readVideoDurationSeconds(details) {
    const fromPlayer = Number(details?.lengthSeconds);
    if (Number.isInteger(fromPlayer) && fromPlayer > 0) {
        return fromPlayer;
    }
    const fromVideo = Math.round(document.querySelector('video')?.duration ?? NaN);
    return Number.isFinite(fromVideo) && fromVideo > 0 ? fromVideo : undefined;
}
function parseYouTubeWatchUrl(url) {
    if (!url) {
        return { success: false, error: 'Active tab has no URL' };
    }
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return { success: false, error: 'Active tab has an invalid URL' };
    }
    if (parsed.hostname !== 'www.youtube.com' && parsed.hostname !== 'youtube.com') {
        return { success: false, error: 'Active tab is not YouTube' };
    }
    if (parsed.pathname !== '/watch') {
        return { success: false, error: 'YouTube page is not a watch page' };
    }
    const videoId = parsed.searchParams.get('v');
    if (!videoId || videoId.trim().length === 0) {
        return { success: false, error: 'YouTube watch page has no video ID' };
    }
    return { success: true, videoId };
}
function primaryLanguageSubtag(languageCode) {
    return languageCode.split('-')[0].toLowerCase();
}
// The transcript's language comes from the video, not from the user: it's the
// language of the audio being played, so the transcript matches what the
// viewer hears (the original or one of YouTube's dubs). Within that language a
// creator-made track beats the auto-generated one. Without audio-language info
// (most single-audio videos), the auto-generated track's language stands in for
// it, since YouTube only generates that track in the spoken language. Videos
// with neither (one audio track, creator-made captions only, e.g. TED talks
// with many human translations) carry no original-language marker at all, so
// the last resort is YouTube's own default track, which follows the viewer's
// locale and may be a translation. Tracks are never machine-translated.
function selectVideoCaptionTrack(tracks, audioLanguage, defaultCaptionTrackIndex) {
    if (tracks.length === 0) {
        return { track: undefined, source: 'none' };
    }
    const spokenLanguageCode = audioLanguage?.languageCode ?? tracks.find(track => track.kind === 'asr')?.languageCode;
    if (spokenLanguageCode) {
        const audioPrimary = toLamissLanguageCode(spokenLanguageCode);
        const inAudioLanguage = tracks.filter(track => track.languageCode && toLamissLanguageCode(track.languageCode) === audioPrimary);
        const manual = inAudioLanguage.find(track => track.kind !== 'asr');
        if (manual) {
            return { track: manual, source: 'audio-manual' };
        }
        if (inAudioLanguage.length > 0) {
            return { track: inAudioLanguage[0], source: 'audio-asr' };
        }
    }
    if (typeof defaultCaptionTrackIndex === 'number' && tracks[defaultCaptionTrackIndex]) {
        return { track: tracks[defaultCaptionTrackIndex], source: 'youtube-default' };
    }
    return { track: tracks[0], source: 'first' };
}
// YouTube uses region-tagged and a few legacy codes (es-419, zh-Hans, iw, in);
// the backend expects the bare ISO 639-1 code.
const LEGACY_LANGUAGE_CODES = { iw: 'he', in: 'id', nb: 'no' };
function toLamissLanguageCode(languageCode) {
    const primary = primaryLanguageSubtag(languageCode);
    return LEGACY_LANGUAGE_CODES[primary] ?? primary;
}
function isValidCaptionResponse(response) {
    return !!response
        && typeof response === 'object'
        && 'events' in response
        && Array.isArray(response.events);
}
// ---------------------------------------------------------------------------
// In-page "Start using Lamiss" button, placed next to the Subscribe button.
// ---------------------------------------------------------------------------
const LAMISS_PAGE_BUTTON_ID = 'lamiss-start-button';
const LAMISS_BUTTON_LABELS = {
    idle: 'Start using Lamiss',
    loading: 'Loading transcript…',
    ready: 'Lamiss is ready',
    error: 'Retry Lamiss'
};
const LAMISS_CHAT_FRAME_ID = 'lamiss-chat-frame';
let lamissButtonVideoId;
let lamissButtonState = 'idle';
let lamissTabId;
let lamissChatOpen = false;
let lamissButtonDetail = 'Send this video\'s transcript to Lamiss';
let lamissEnsureScheduled = false;
function createLamissButton() {
    const button = document.createElement('button');
    button.id = LAMISS_PAGE_BUTTON_ID;
    button.type = 'button';
    button.className = 'lamiss-start-button';
    const logo = document.createElement('span');
    logo.className = 'lamiss-start-button__logo';
    logo.textContent = 'L';
    const label = document.createElement('span');
    label.className = 'lamiss-start-button__label';
    button.append(logo, label);
    button.addEventListener('click', () => {
        void onLamissButtonClick();
    });
    return button;
}
// Only touches the DOM when something changed: the MutationObserver below
// watches the whole page, so an unconditional write would retrigger it forever.
function renderLamissButton(button) {
    if (button.dataset.state !== lamissButtonState) {
        button.dataset.state = lamissButtonState;
        button.disabled = lamissButtonState === 'loading';
    }
    if (button.title !== lamissButtonDetail) {
        button.title = lamissButtonDetail;
    }
    const label = button.querySelector('.lamiss-start-button__label');
    const text = LAMISS_BUTTON_LABELS[lamissButtonState];
    if (label && label.textContent !== text) {
        label.textContent = text;
    }
}
function ensureLamissButton() {
    const existing = document.getElementById(LAMISS_PAGE_BUTTON_ID);
    const parsed = parseYouTubeWatchUrl(window.location.href);
    if (!parsed.success) {
        existing?.remove();
        document.getElementById(LAMISS_CHAT_FRAME_ID)?.remove();
        stopLamissLive();
        return;
    }
    if (parsed.videoId !== lamissButtonVideoId) {
        lamissButtonVideoId = parsed.videoId;
        lamissButtonState = 'idle';
        lamissButtonDetail = 'Send this video\'s transcript to Lamiss';
        lamissChatOpen = false;
        stopLamissLive();
    }
    ensureLamissChat();
    const subscribeButton = document.querySelector('ytd-watch-metadata #owner #subscribe-button');
    if (!subscribeButton) {
        return;
    }
    const button = existing ?? createLamissButton();
    if (button.previousElementSibling !== subscribeButton) {
        subscribeButton.after(button);
    }
    renderLamissButton(button);
    ensureLamissTimer(button);
}
// The chat is an extension page in an iframe at the top of the right-hand
// column: it keeps its own styles and keyboard focus apart from YouTube's, and
// it runs on the extension's origin, which has the microphone permission and
// backend access.
function ensureLamissChat() {
    const existing = document.getElementById(LAMISS_CHAT_FRAME_ID);
    const videoId = lamissButtonVideoId;
    if (!lamissChatOpen || lamissButtonState !== 'ready' || lamissTabId === undefined || !videoId) {
        existing?.remove();
        return;
    }
    // Moving or recreating the frame reloads it and loses the conversation.
    if (existing?.dataset.videoId === videoId) {
        return;
    }
    existing?.remove();
    const column = document.querySelector('ytd-watch-flexy #secondary-inner') ?? document.querySelector('ytd-watch-flexy #secondary');
    if (!column) {
        return;
    }
    const query = new URLSearchParams({ tabId: String(lamissTabId), videoId });
    const frame = document.createElement('iframe');
    frame.id = LAMISS_CHAT_FRAME_ID;
    frame.className = 'lamiss-chat-frame';
    frame.title = 'Lamiss chat';
    frame.allow = 'microphone';
    frame.dataset.videoId = videoId;
    frame.src = chrome.runtime.getURL(`chat/chat.html?${query}`);
    column.prepend(frame);
}
function setLamissChatOpen(open) {
    lamissChatOpen = open;
    ensureLamissChat();
}
// Only the chat frame itself may close the chat.
window.addEventListener('message', (event) => {
    const frame = document.getElementById(LAMISS_CHAT_FRAME_ID);
    if (!frame || event.source !== frame.contentWindow) {
        return;
    }
    if (event.data?.type === 'lamiss:close-chat') {
        setLamissChatOpen(false);
    }
});
function scheduleEnsureLamissButton() {
    if (lamissEnsureScheduled) {
        return;
    }
    lamissEnsureScheduled = true;
    requestAnimationFrame(() => {
        lamissEnsureScheduled = false;
        ensureLamissButton();
    });
}
function setLamissButtonState(state, detail) {
    lamissButtonState = state;
    lamissButtonDetail = detail;
    const button = document.getElementById(LAMISS_PAGE_BUTTON_ID);
    if (button) {
        renderLamissButton(button);
    }
}
function getOwnTabId() {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'GET_SENDER_TAB_ID' }, (response) => {
            if (chrome.runtime.lastError || typeof response?.tabId !== 'number') {
                reject(new Error(chrome.runtime.lastError?.message ?? 'Tab ID is unavailable'));
                return;
            }
            resolve(response.tabId);
        });
    });
}
function sendTranscriptIngestRequest(payload) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'INGEST_TRANSCRIPT', payload }, (response) => {
            if (chrome.runtime.lastError || !response) {
                resolve({ ok: false, error: chrome.runtime.lastError?.message ?? 'No response from the extension' });
                return;
            }
            resolve(response);
        });
    });
}
async function onLamissButtonClick() {
    if (lamissButtonState === 'ready') {
        setLamissChatOpen(!lamissChatOpen);
        return;
    }
    if (lamissButtonState !== 'idle' && lamissButtonState !== 'error') {
        return;
    }
    const clickedVideoId = lamissButtonVideoId;
    // Ignore the outcome if the user navigated to another video meanwhile.
    const finish = (state, detail) => {
        if (lamissButtonVideoId === clickedVideoId) {
            setLamissButtonState(state, detail);
        }
    };
    setLamissButtonState('loading', 'Loading the transcript and sending it to Lamiss…');
    try {
        const tabId = await getOwnTabId();
        lamissTabId = tabId;
        const transcript = await new Promise((resolve) => {
            startTranscriptLoad(tabId, resolve);
        });
        if (!transcript.success) {
            finish('error', transcript.error ?? 'Transcript failed');
            return;
        }
        const loaded = transcript;
        const outcome = await sendTranscriptIngestRequest({
            videoExternalId: loaded.videoId,
            videoPlatform: 'YOUTUBE',
            videoTitle: loaded.videoTitle,
            videoDurationSeconds: loaded.videoDurationSeconds,
            language: loaded.language,
            translated: loaded.translated,
            rawCaptionResponse: loaded.rawCaptionResponse
        });
        if (!outcome.ok) {
            console.error('Lamiss POC: transcript ingest failed:', outcome.error ?? outcome.status);
            finish('error', outcome.error ?? `Lamiss backend returned HTTP ${outcome.status}`);
            return;
        }
        finish('ready', `${outcome.ingestStatus?.toUpperCase() === 'ALREADY_INGESTED'
            ? 'This video\'s transcript was already in Lamiss'
            : 'Transcript sent to Lamiss'}. Click to show or hide the chat`);
        if (lamissButtonVideoId === clickedVideoId && clickedVideoId) {
            setLamissChatOpen(true);
            startLamissLive(clickedVideoId, loaded.language);
        }
    }
    catch (error) {
        console.error('Lamiss POC: in-page button error:', error);
        finish('error', error instanceof Error ? error.message : String(error));
    }
}
// ---------------------------------------------------------------------------
// Proactive questions: Lamiss pauses the video, reads a question aloud over
// the player and listens for the spoken answer. The user can also type it.
// Lamiss checks the answer, reads the feedback aloud and resumes the video.
// The background worker owns the WebSocket and the microphone; this tab
// reports the playback position and runs the conversation.
// ---------------------------------------------------------------------------
const LAMISS_POSITION_INTERVAL_MS = 1000;
const LAMISS_KEEPALIVE_INTERVAL_MS = 20000;
const LAMISS_QUESTION_ID = 'lamiss-question';
const LAMISS_TOAST_ID = 'lamiss-toast';
// Pause between the end of the spoken feedback and the video resuming.
const LAMISS_RESUME_AFTER_SPEECH_MS = 1200;
let lamissLiveVideoId;
let lamissLiveLanguage;
let lamissLivePort = null;
let lamissLiveState = 'connecting';
let lamissLiveKeepalive;
let lamissLastPositionSentAt = 0;
let lamissQuestion = null;
let lamissResumeTimer;
let lamissCountdownTimer;
let lamissToastTimer;
function getLamissPlayer() {
    return document.getElementById('movie_player');
}
function getLamissVideo() {
    return document.querySelector('#movie_player video');
}
function formatLamissPosition(seconds) {
    const total = Math.floor(seconds);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
function startLamissLive(videoId, language) {
    lamissLiveLanguage = language;
    if (lamissLiveVideoId === videoId) {
        return;
    }
    stopLamissLive();
    lamissLiveVideoId = videoId;
    connectLamissLive();
    startLamissTimer();
    scheduleEnsureLamissButton();
    lamissLiveKeepalive = window.setInterval(() => postLamissLive({ type: 'keepalive' }), LAMISS_KEEPALIVE_INTERVAL_MS);
}
function stopLamissLive() {
    if (!lamissLiveVideoId) {
        return;
    }
    hideLamissQuestion();
    stopLamissTimer();
    lamissLiveVideoId = undefined;
    window.clearInterval(lamissLiveKeepalive);
    const port = lamissLivePort;
    lamissLivePort = null;
    port?.disconnect();
}
function connectLamissLive() {
    const videoId = lamissLiveVideoId;
    if (!videoId) {
        return;
    }
    let port;
    try {
        port = chrome.runtime.connect({ name: 'lamiss-live' });
    }
    catch (error) {
        // The extension was reloaded; this content script is orphaned.
        console.warn('Lamiss POC: cannot reach the extension:', error);
        return;
    }
    lamissLivePort = port;
    port.onMessage.addListener(onLamissLiveMessage);
    port.onDisconnect.addListener(() => {
        if (lamissLivePort !== port) {
            return;
        }
        // The worker was stopped. Connecting again restarts it and its socket.
        lamissLivePort = null;
        window.setTimeout(() => {
            if (lamissLiveVideoId === videoId && !lamissLivePort) {
                connectLamissLive();
            }
        }, 1000);
    });
    port.postMessage({ type: 'start', videoId });
}
function postLamissLive(message) {
    try {
        lamissLivePort?.postMessage(message);
    }
    catch {
        // The port closed; its onDisconnect handler reconnects.
    }
}
function onLamissLiveMessage(message) {
    if (message.type === 'status') {
        lamissLiveState = message.state;
        if (message.state !== 'connected') {
            lamissNextQuestion = undefined;
        }
        else {
            // Lamiss only hears positions from a playing video; tell it where a
            // paused one is so the countdown can start straight away.
            reportLamissPosition();
        }
        // An answer sent just before the socket dropped may not have arrived.
        // Answers are keyed on the question, so sending it again is safe.
        if (message.state === 'connected' && lamissQuestion?.phase === 'sending' && lamissQuestion.answer) {
            lamissQuestion.queued = false;
            postLamissLive({ type: 'answer', answeredTo: lamissQuestion.eventId, answer: lamissQuestion.answer, language: lamissQuestion.answerLanguage });
        }
        if (message.state === 'failed') {
            console.error('Lamiss POC: live questions are off:', message.detail);
            showLamissToast(`Lamiss can't ask you questions here: ${message.detail ?? 'connection refused'}`);
        }
        renderLamissQuestion();
        return;
    }
    if (message.type === 'answer-queued') {
        if (lamissQuestion) {
            lamissQuestion.queued = true;
        }
        renderLamissQuestion();
        return;
    }
    if (message.type === 'listen-event') {
        onLamissListenEvent(message.requestId, message.event);
        return;
    }
    if (message.type === 'speech-event') {
        onLamissSpeechEvent(message.requestId, message.event);
        return;
    }
    const server = message.message;
    switch (server.type) {
        case 'PAUSE_VIDEO':
            getLamissVideo()?.pause();
            break;
        case 'ASK_QUESTION':
            showLamissQuestion(server.eventId, server.question);
            break;
        case 'FEEDBACK':
            showLamissFeedback(server.correct, server.feedback);
            break;
        case 'RESUME_VIDEO':
            onLamissResume();
            break;
        case 'ERROR':
            onLamissError(server.message);
            break;
        case 'NEXT_QUESTION':
            lamissNextQuestion = { atVideoMs: server.atVideoMs, waitingForAnswer: server.waitingForAnswer };
            renderLamissTimer();
            break;
    }
}
// Heartbeats come from the player's own timeupdate events, so a paused video
// sends none. Media events don't bubble; listening in the capture phase on the
// document survives YouTube swapping the <video> element.
document.addEventListener('timeupdate', (event) => {
    const video = event.target;
    if (!lamissLivePort || lamissQuestion || !(video instanceof HTMLVideoElement)) {
        return;
    }
    const player = getLamissPlayer();
    // During ads currentTime is the ad's position, not the video's.
    if (!player?.contains(video) || player.classList.contains('ad-showing')) {
        return;
    }
    const now = Date.now();
    if (now - lamissLastPositionSentAt < LAMISS_POSITION_INTERVAL_MS) {
        return;
    }
    lamissLastPositionSentAt = now;
    postLamissLive({ type: 'position', positionMs: video.currentTime * 1000 });
}, true);
// A one-off position report that never counts as watching (see the backend's
// VIDEO_POSITION "playing" flag): it only refreshes the countdown.
function reportLamissPosition() {
    const video = getLamissVideo();
    const player = getLamissPlayer();
    if (!lamissLivePort || !video || player?.classList.contains('ad-showing')) {
        return;
    }
    postLamissLive({ type: 'position', positionMs: video.currentTime * 1000, playing: false });
}
// Pausing, or seeking while paused, moves the viewer without heartbeats.
document.addEventListener('pause', (event) => {
    if (event.target === getLamissVideo() && !lamissQuestion) {
        reportLamissPosition();
    }
}, true);
// "seeking" fires at once; "seeked" only after the new frame has loaded.
for (const type of ['seeking', 'seeked']) {
    document.addEventListener(type, (event) => {
        const video = getLamissVideo();
        if (event.target === video && video?.paused) {
            reportLamissPosition();
        }
    }, true);
}
// Keep the video paused until the question is answered, even if the user
// presses play with the keyboard or another control.
document.addEventListener('play', (event) => {
    if (lamissQuestion && lamissQuestion.phase !== 'feedback' && event.target === getLamissVideo()) {
        getLamissVideo()?.pause();
    }
}, true);
// --- Speech ------------------------------------------------------------------
// Lamiss speaks with her own voice, a kind teacher synthesized by the backend
// and played by the extension. If that fails (backend down, no audio), the
// browser's built-in voice reads the text instead. Resolves when she's done.
let lamissSpeech = null;
function speakLamiss(text) {
    stopLamissSpeech();
    if (!lamissLivePort) {
        return speakWithBrowserVoice(text);
    }
    return new Promise((resolve) => {
        const requestId = crypto.randomUUID();
        let done = false;
        const finish = () => {
            if (!done) {
                done = true;
                window.clearTimeout(limit);
                if (lamissSpeech?.requestId === requestId) {
                    lamissSpeech = null;
                }
                resolve();
            }
        };
        // Generating the audio takes a moment; this covers that plus playback.
        const limit = window.setTimeout(finish, 15000 + text.length * 150);
        lamissSpeech = { requestId, text, resolve: finish };
        postLamissLive({ type: 'speak', requestId, text, ...(lamissLiveLanguage ? { language: lamissLiveLanguage } : {}) });
    });
}
function onLamissSpeechEvent(requestId, event) {
    const speech = lamissSpeech;
    if (!speech || speech.requestId !== requestId) {
        return;
    }
    if (event.type === 'ended') {
        speech.resolve();
    }
    else if (event.type === 'failed') {
        // Still the current speech, so stopLamissSpeech can cut the fallback too.
        console.warn('Lamiss POC: Lamiss\'s voice failed, using the browser voice:', event.error);
        void speakWithBrowserVoice(speech.text).then(speech.resolve);
    }
}
function stopLamissSpeech() {
    const speech = lamissSpeech;
    if (speech) {
        lamissSpeech = null;
        postLamissLive({ type: 'stop-speaking', requestId: speech.requestId });
        speech.resolve();
    }
    if ('speechSynthesis' in window) {
        speechSynthesis.cancel();
    }
}
// The browser's built-in voice: robotic, but always available.
function speakWithBrowserVoice(text) {
    return new Promise((resolve) => {
        if (!text || !('speechSynthesis' in window)) {
            resolve();
            return;
        }
        let done = false;
        const finish = () => {
            if (!done) {
                done = true;
                window.clearTimeout(limit);
                resolve();
            }
        };
        const utterance = new SpeechSynthesisUtterance(text);
        if (lamissLiveLanguage) {
            utterance.lang = lamissLiveLanguage;
            const voice = speechSynthesis.getVoices().find(v => v.lang.toLowerCase().startsWith(lamissLiveLanguage.toLowerCase()));
            if (voice) {
                utterance.voice = voice;
            }
        }
        utterance.addEventListener('end', finish);
        utterance.addEventListener('error', (event) => {
            if (event.error !== 'interrupted' && event.error !== 'canceled') {
                console.warn('Lamiss POC: speech failed:', event.error);
            }
            finish();
        });
        const limit = window.setTimeout(finish, 3000 + text.length * 120);
        speechSynthesis.cancel();
        speechSynthesis.speak(utterance);
    });
}
// --- Listening -----------------------------------------------------------------
function startLamissListening() {
    if (!lamissQuestion) {
        return;
    }
    const requestId = crypto.randomUUID();
    lamissQuestion.listenRequestId = requestId;
    lamissQuestion.listenDeadline = undefined;
    lamissQuestion.error = undefined;
    lamissQuestion.phase = 'listening';
    renderLamissQuestion();
    postLamissLive({ type: 'listen', requestId });
}
function stopLamissListening(discard) {
    const requestId = lamissQuestion?.listenRequestId;
    if (!requestId) {
        return;
    }
    postLamissLive({ type: 'stop-listening', requestId, discard });
    if (discard && lamissQuestion) {
        lamissQuestion.listenRequestId = undefined;
    }
    window.clearInterval(lamissCountdownTimer);
}
function onLamissListenEvent(requestId, event) {
    const question = lamissQuestion;
    if (!question || question.listenRequestId !== requestId) {
        return;
    }
    switch (event.type) {
        case 'listening':
            question.phase = 'listening';
            question.listenDeadline = Date.now() + event.noSpeechTimeoutMs;
            window.clearInterval(lamissCountdownTimer);
            lamissCountdownTimer = window.setInterval(renderLamissQuestion, 250);
            break;
        case 'speech-started':
            question.phase = 'recording';
            window.clearInterval(lamissCountdownTimer);
            break;
        case 'no-speech':
            question.listenRequestId = undefined;
            question.phase = 'answering';
            question.error = 'I didn\'t hear an answer. Tap the mic to try again, or type it.';
            window.clearInterval(lamissCountdownTimer);
            break;
        case 'transcribing':
            question.phase = 'transcribing';
            break;
        case 'transcribed': {
            question.listenRequestId = undefined;
            question.phase = 'answering';
            const parts = lamissQuestionParts();
            if (parts) {
                parts.input.value = event.text;
            }
            submitLamissAnswer(event.text, event.language);
            return;
        }
        case 'failed':
            question.listenRequestId = undefined;
            question.phase = 'answering';
            window.clearInterval(lamissCountdownTimer);
            question.error = event.micDenied
                ? 'Lamiss needs the microphone. Allow it in the tab that just opened, then tap the mic. You can also type your answer.'
                : `I couldn't get your spoken answer (${event.error}). Tap the mic to try again, or type it.`;
            break;
    }
    renderLamissQuestion();
}
// --- Question card ---------------------------------------------------------------
const LAMISS_MIC_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="17" x2="12" y2="22"/></svg>';
function createLamissQuestion() {
    const overlay = document.createElement('div');
    overlay.id = LAMISS_QUESTION_ID;
    overlay.className = 'lamiss-question';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'lamiss-question-text');
    // YouTube's player shortcuts (space, k, f, j, l…) must not see our typing.
    for (const type of ['keydown', 'keyup', 'keypress']) {
        overlay.addEventListener(type, event => event.stopPropagation());
    }
    // Clicks would otherwise toggle playback on the player underneath.
    overlay.addEventListener('click', event => event.stopPropagation());
    const card = document.createElement('form');
    card.className = 'lamiss-question__card';
    const header = document.createElement('div');
    header.className = 'lamiss-question__header';
    const logo = document.createElement('span');
    logo.className = 'lamiss-question__logo';
    logo.textContent = 'L';
    const heading = document.createElement('span');
    heading.className = 'lamiss-question__heading';
    header.append(logo, heading);
    const text = document.createElement('p');
    text.id = 'lamiss-question-text';
    text.className = 'lamiss-question__text';
    const input = document.createElement('textarea');
    input.className = 'lamiss-question__input';
    input.rows = 3;
    input.setAttribute('aria-label', 'Your answer');
    const feedback = document.createElement('div');
    feedback.className = 'lamiss-question__feedback';
    feedback.hidden = true;
    const status = document.createElement('p');
    status.className = 'lamiss-question__status';
    status.setAttribute('aria-live', 'polite');
    const actions = document.createElement('div');
    actions.className = 'lamiss-question__actions';
    const mic = document.createElement('button');
    mic.type = 'button';
    mic.className = 'lamiss-question__mic';
    // Static markup with no user data.
    mic.innerHTML = LAMISS_MIC_ICON;
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'lamiss-question__submit';
    actions.append(mic, submit);
    card.append(header, text, input, feedback, status, actions);
    overlay.append(card);
    input.addEventListener('input', () => {
        // Typing takes over from the microphone.
        if (lamissQuestion && ['speaking', 'listening'].includes(lamissQuestion.phase)) {
            stopLamissSpeech();
            stopLamissListening(true);
            lamissQuestion.phase = 'answering';
        }
        renderLamissQuestion();
    });
    input.addEventListener('keydown', (event) => {
        // Enter answers; Shift+Enter adds a new line. Ignore Enter while an IME is composing.
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            card.requestSubmit();
        }
    });
    mic.addEventListener('click', onLamissMicClick);
    card.addEventListener('submit', (event) => {
        event.preventDefault();
        onLamissQuestionSubmit();
    });
    return overlay;
}
function lamissQuestionParts() {
    const overlay = document.getElementById(LAMISS_QUESTION_ID);
    if (!overlay) {
        return null;
    }
    return {
        overlay,
        heading: overlay.querySelector('.lamiss-question__heading'),
        text: overlay.querySelector('.lamiss-question__text'),
        input: overlay.querySelector('.lamiss-question__input'),
        feedback: overlay.querySelector('.lamiss-question__feedback'),
        status: overlay.querySelector('.lamiss-question__status'),
        mic: overlay.querySelector('.lamiss-question__mic'),
        submit: overlay.querySelector('.lamiss-question__submit')
    };
}
function showLamissQuestion(eventId, question) {
    // A reconnect replays the stored question; keep the conversation as it is.
    if (lamissQuestion?.eventId === eventId && lamissQuestionParts()) {
        return;
    }
    const player = getLamissPlayer();
    if (!player) {
        console.warn('Lamiss POC: no player to show the question on');
        return;
    }
    hideLamissQuestion();
    player.append(createLamissQuestion());
    const state = { eventId, question, phase: 'speaking', queued: false };
    lamissQuestion = state;
    const parts = lamissQuestionParts();
    if (!parts) {
        return;
    }
    const video = getLamissVideo();
    parts.heading.textContent = video ? `Lamiss asks · ${formatLamissPosition(video.currentTime)}` : 'Lamiss asks';
    parts.text.textContent = question;
    renderLamissQuestion();
    // Ask aloud, then listen for the spoken answer.
    void speakLamiss(question).then(() => {
        if (lamissQuestion === state && state.phase === 'speaking') {
            startLamissListening();
        }
    });
}
function hideLamissQuestion() {
    window.clearTimeout(lamissResumeTimer);
    window.clearInterval(lamissCountdownTimer);
    stopLamissSpeech();
    stopLamissListening(true);
    lamissQuestion = null;
    document.getElementById(LAMISS_QUESTION_ID)?.remove();
}
function lamissStatusText(question) {
    if (question.phase === 'feedback') {
        return '';
    }
    if (lamissLiveState === 'failed') {
        return 'Lamiss is disconnected, so your answer can\'t be saved.';
    }
    if (lamissLiveState !== 'connected') {
        return question.queued
            ? 'Reconnecting to Lamiss… your answer will be sent as soon as it\'s back.'
            : 'Reconnecting to Lamiss… your answer hasn\'t been saved yet.';
    }
    switch (question.phase) {
        case 'speaking':
            return 'Lamiss is asking…';
        case 'listening': {
            if (!question.listenDeadline) {
                return 'Opening the microphone…';
            }
            const seconds = Math.max(0, Math.ceil((question.listenDeadline - Date.now()) / 1000));
            return `Listening… start answering (${seconds}s)`;
        }
        case 'recording':
            return 'Listening… I\'ll stop when you finish talking.';
        case 'transcribing':
            return 'Getting your answer…';
        case 'sending':
            return 'Lamiss is checking your answer…';
        default:
            return question.error ?? '';
    }
}
function renderLamissQuestion() {
    const parts = lamissQuestionParts();
    const question = lamissQuestion;
    if (!parts || !question) {
        return;
    }
    const { phase } = question;
    const listening = phase === 'listening' || phase === 'recording';
    parts.overlay.dataset.phase = phase;
    parts.input.readOnly = !['speaking', 'listening', 'answering'].includes(phase);
    parts.input.placeholder = listening || phase === 'speaking' ? 'Answer out loud, or type here…' : 'Type your answer…';
    parts.mic.hidden = !['speaking', 'answering', 'listening', 'recording'].includes(phase);
    parts.mic.dataset.state = listening ? 'listening' : 'idle';
    parts.mic.disabled = phase === 'speaking';
    const micLabel = phase === 'recording' ? 'Done talking' : phase === 'listening' ? 'Stop listening' : 'Answer with your voice';
    parts.mic.title = micLabel;
    parts.mic.setAttribute('aria-label', micLabel);
    parts.submit.textContent = phase === 'feedback' ? 'Continue' : phase === 'sending' ? 'Checking…' : 'Answer';
    parts.submit.disabled = phase === 'feedback'
        ? false
        : !['speaking', 'listening', 'answering'].includes(phase) || parts.input.value.trim().length === 0;
    const status = lamissStatusText(question);
    parts.status.dataset.error = String(phase === 'answering' && Boolean(question.error));
    if (parts.status.textContent !== status) {
        parts.status.textContent = status;
    }
}
function onLamissMicClick() {
    const question = lamissQuestion;
    if (!question) {
        return;
    }
    if (question.phase === 'recording') {
        // Done talking: keep the recording and transcribe it.
        stopLamissListening(false);
    }
    else if (question.phase === 'listening') {
        stopLamissListening(true);
        question.phase = 'answering';
        question.error = undefined;
        renderLamissQuestion();
    }
    else if (question.phase === 'answering') {
        startLamissListening();
    }
}
function onLamissQuestionSubmit() {
    const parts = lamissQuestionParts();
    if (!parts || !lamissQuestion) {
        return;
    }
    if (lamissQuestion.phase === 'feedback') {
        resumeLamissVideo();
        return;
    }
    if (!['speaking', 'listening', 'answering'].includes(lamissQuestion.phase)) {
        return;
    }
    stopLamissSpeech();
    stopLamissListening(true);
    submitLamissAnswer(parts.input.value.trim());
}
// spokenLanguage comes with a transcribed answer and stays off typed ones.
function submitLamissAnswer(answer, spokenLanguage) {
    if (!lamissQuestion || !answer) {
        return;
    }
    lamissQuestion.phase = 'sending';
    lamissQuestion.answer = answer;
    lamissQuestion.answerLanguage = spokenLanguage;
    lamissQuestion.error = undefined;
    renderLamissQuestion();
    postLamissLive({ type: 'answer', answeredTo: lamissQuestion.eventId, answer, language: spokenLanguage });
}
function showLamissFeedback(correct, feedback) {
    const parts = lamissQuestionParts();
    const question = lamissQuestion;
    if (!parts || !question) {
        showLamissToast(feedback);
        return;
    }
    question.phase = 'feedback';
    parts.feedback.hidden = false;
    parts.feedback.dataset.correct = String(correct);
    parts.feedback.textContent = `${correct ? '✓ Correct. ' : '✗ Not quite. '}${feedback}`;
    renderLamissQuestion();
    parts.submit.focus();
    question.speakingFeedback = true;
    void speakLamiss(feedback).then(() => {
        question.speakingFeedback = false;
        if (lamissQuestion === question && question.resumeRequested) {
            window.clearTimeout(lamissResumeTimer);
            lamissResumeTimer = window.setTimeout(resumeLamissVideo, LAMISS_RESUME_AFTER_SPEECH_MS);
        }
    });
}
// RESUME_VIDEO arrives right after FEEDBACK. Let Lamiss finish reading the
// feedback aloud (or the user click Continue), then play.
function onLamissResume() {
    const question = lamissQuestion;
    if (!question || question.phase !== 'feedback') {
        resumeLamissVideo();
        return;
    }
    question.resumeRequested = true;
    if (!question.speakingFeedback) {
        window.clearTimeout(lamissResumeTimer);
        lamissResumeTimer = window.setTimeout(resumeLamissVideo, LAMISS_RESUME_AFTER_SPEECH_MS);
    }
}
function resumeLamissVideo() {
    hideLamissQuestion();
    getLamissVideo()?.play().catch((error) => {
        console.warn('Lamiss POC: could not resume the video:', error);
    });
}
// The backend reports problems without closing the socket. While an answer is
// being checked, the error belongs to it: let the user send it again (the
// backend keys answers on the question, so a resend can't double-count).
function onLamissError(message) {
    if (lamissQuestion?.phase === 'sending') {
        lamissQuestion.phase = 'answering';
        lamissQuestion.queued = false;
        lamissQuestion.error = `Lamiss couldn't check your answer: ${message}. Try again.`;
        renderLamissQuestion();
        return;
    }
    showLamissToast(`Lamiss: ${message}`);
}
function showLamissToast(text) {
    const player = getLamissPlayer();
    if (!player) {
        return;
    }
    let toast = document.getElementById(LAMISS_TOAST_ID);
    if (!toast) {
        toast = document.createElement('div');
        toast.id = LAMISS_TOAST_ID;
        toast.className = 'lamiss-toast';
        toast.setAttribute('role', 'status');
        player.append(toast);
    }
    toast.textContent = text;
    window.clearTimeout(lamissToastTimer);
    lamissToastTimer = window.setTimeout(() => document.getElementById(LAMISS_TOAST_ID)?.remove(), 6000);
}
// ---------------------------------------------------------------------------
// Countdown to Lamiss's next question, next to the Lamiss button. The backend
// says at which video position the next question comes (NEXT_QUESTION); the
// countdown follows playback from there, so it freezes while paused. Clicking
// it opens the question settings, which live only in this browser.
// ---------------------------------------------------------------------------
const LAMISS_TIMER_ID = 'lamiss-question-timer';
const LAMISS_SETTINGS_POPOVER_ID = 'lamiss-question-settings';
const LAMISS_TIMER_TICK_MS = 250;
const LAMISS_DIFFICULTY_CHOICES = [
    { value: 'EASY', label: 'Easy' },
    { value: 'MEDIUM', label: 'Medium' },
    { value: 'HARD', label: 'Hard' }
];
// Undefined until the backend has said; reset whenever the connection drops.
let lamissNextQuestion;
let lamissTimerTick;
let lamissQuestionSettings = LAMISS_DEFAULT_QUESTION_SETTINGS;
function ensureLamissTimer(button) {
    const existing = document.getElementById(LAMISS_TIMER_ID);
    if (!lamissLiveVideoId || lamissLiveVideoId !== lamissButtonVideoId) {
        existing?.remove();
        return;
    }
    const timer = existing ?? createLamissTimer();
    if (timer.previousElementSibling !== button) {
        button.after(timer);
    }
    renderLamissTimer();
}
function createLamissTimer() {
    const timer = document.createElement('button');
    timer.id = LAMISS_TIMER_ID;
    timer.type = 'button';
    timer.className = 'lamiss-question-timer';
    timer.title = 'Time until Lamiss\'s next question. Click to change how often and how hard.';
    timer.setAttribute('aria-haspopup', 'dialog');
    timer.setAttribute('aria-expanded', 'false');
    const icon = document.createElement('span');
    icon.className = 'lamiss-question-timer__icon';
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'lamiss-question-timer__label';
    timer.append(icon, label);
    timer.addEventListener('click', toggleLamissSettingsPopover);
    return timer;
}
function lamissTimerText() {
    if (lamissLiveState === 'failed') {
        return { text: 'Questions off', state: 'off' };
    }
    if (lamissLiveState !== 'connected') {
        return { text: 'Connecting…', state: 'idle' };
    }
    if (lamissQuestion) {
        return { text: 'Lamiss is asking', state: 'now' };
    }
    if (!lamissNextQuestion) {
        return { text: 'Next question…', state: 'idle' };
    }
    if (lamissNextQuestion.waitingForAnswer) {
        return { text: 'Waiting for your answer', state: 'now' };
    }
    if (lamissNextQuestion.atVideoMs === null) {
        return { text: 'No more questions ahead', state: 'off' };
    }
    const video = getLamissVideo();
    if (!video) {
        return { text: 'Next question…', state: 'idle' };
    }
    // Video time to wall time: at 2x speed the question comes twice as soon.
    const remainingMs = (lamissNextQuestion.atVideoMs - video.currentTime * 1000) / (video.playbackRate || 1);
    if (remainingMs <= 0) {
        return { text: 'Next question any second', state: 'soon' };
    }
    const countdown = formatLamissPosition(Math.ceil(remainingMs / 1000));
    if (video.paused) {
        return { text: `Next question in ${countdown} · paused`, state: 'paused' };
    }
    return { text: `Next question in ${countdown}`, state: remainingMs <= 10000 ? 'soon' : 'running' };
}
// Runs every tick: only touches the DOM when the text changes, since the
// page-wide MutationObserver reacts to every write.
function renderLamissTimer() {
    const timer = document.getElementById(LAMISS_TIMER_ID);
    if (!timer) {
        return;
    }
    const { text, state } = lamissTimerText();
    const label = timer.querySelector('.lamiss-question-timer__label');
    if (label && label.textContent !== text) {
        label.textContent = text;
    }
    if (timer.dataset.state !== state) {
        timer.dataset.state = state;
    }
}
function startLamissTimer() {
    window.clearInterval(lamissTimerTick);
    lamissTimerTick = window.setInterval(renderLamissTimer, LAMISS_TIMER_TICK_MS);
    void readQuestionSettings().then((settings) => {
        lamissQuestionSettings = settings;
        renderLamissSettingsPopover();
    });
}
function stopLamissTimer() {
    window.clearInterval(lamissTimerTick);
    lamissNextQuestion = undefined;
    document.getElementById(LAMISS_TIMER_ID)?.remove();
    closeLamissSettingsPopover();
}
// --- Settings popover ----------------------------------------------------------
function toggleLamissSettingsPopover() {
    if (document.getElementById(LAMISS_SETTINGS_POPOVER_ID)) {
        closeLamissSettingsPopover();
    }
    else {
        openLamissSettingsPopover();
    }
}
function openLamissSettingsPopover() {
    const timer = document.getElementById(LAMISS_TIMER_ID);
    if (!timer) {
        return;
    }
    const popover = document.createElement('div');
    popover.id = LAMISS_SETTINGS_POPOVER_ID;
    popover.className = 'lamiss-settings-popover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', 'Lamiss\'s questions');
    // Keep YouTube's shortcuts (arrows seek, space plays) out of the controls.
    for (const type of ['keydown', 'keyup', 'keypress']) {
        popover.addEventListener(type, (event) => {
            event.stopPropagation();
            if (type === 'keydown' && event.key === 'Escape') {
                closeLamissSettingsPopover();
                timer.focus();
            }
        });
    }
    const title = document.createElement('p');
    title.className = 'lamiss-settings-popover__title';
    title.textContent = 'Lamiss\'s questions';
    // How close together questions may come.
    const gapRow = document.createElement('div');
    gapRow.className = 'lamiss-settings-popover__row';
    const gapLabel = document.createElement('label');
    gapLabel.htmlFor = 'lamiss-gap-input';
    gapLabel.textContent = 'How close together';
    const gapValue = document.createElement('output');
    gapValue.className = 'lamiss-settings-popover__value';
    gapValue.htmlFor.add('lamiss-gap-input');
    gapRow.append(gapLabel, gapValue);
    const gapInput = document.createElement('input');
    gapInput.id = 'lamiss-gap-input';
    gapInput.type = 'range';
    gapInput.min = '0';
    gapInput.max = String(LAMISS_QUESTION_GAPS_SECONDS.length - 1);
    gapInput.step = '1';
    gapInput.className = 'lamiss-settings-popover__range';
    const gapScale = document.createElement('div');
    gapScale.className = 'lamiss-settings-popover__scale';
    gapScale.setAttribute('aria-hidden', 'true');
    const fewer = document.createElement('span');
    fewer.textContent = 'Fewer';
    const more = document.createElement('span');
    more.textContent = 'More';
    gapScale.append(fewer, more);
    gapInput.addEventListener('input', () => {
        gapValue.textContent = `At least ${formatQuestionGap(LAMISS_QUESTION_GAPS_SECONDS[Number(gapInput.value)])} apart`;
    });
    gapInput.addEventListener('change', () => {
        void updateLamissQuestionSettings({ minSecondsBetweenQuestions: LAMISS_QUESTION_GAPS_SECONDS[Number(gapInput.value)] });
    });
    // Difficulty as three buttons.
    const difficultyLabel = document.createElement('p');
    difficultyLabel.className = 'lamiss-settings-popover__label';
    difficultyLabel.textContent = 'Difficulty';
    const difficulty = document.createElement('div');
    difficulty.className = 'lamiss-settings-popover__segments';
    difficulty.setAttribute('role', 'radiogroup');
    difficulty.setAttribute('aria-label', 'Difficulty');
    for (const choice of LAMISS_DIFFICULTY_CHOICES) {
        const option = document.createElement('button');
        option.type = 'button';
        option.dataset.value = choice.value;
        option.setAttribute('role', 'radio');
        option.textContent = choice.label;
        option.addEventListener('click', () => void updateLamissQuestionSettings({ difficulty: choice.value }));
        difficulty.append(option);
    }
    const hint = document.createElement('p');
    hint.className = 'lamiss-settings-popover__hint';
    hint.textContent = 'Saved in this browser only. Lamiss only asks about parts you\'ve already watched.';
    popover.append(title, gapRow, gapInput, gapScale, difficultyLabel, difficulty, hint);
    document.body.append(popover);
    timer.setAttribute('aria-expanded', 'true');
    positionLamissSettingsPopover();
    renderLamissSettingsPopover();
    gapInput.focus();
}
function closeLamissSettingsPopover() {
    document.getElementById(LAMISS_SETTINGS_POPOVER_ID)?.remove();
    document.getElementById(LAMISS_TIMER_ID)?.setAttribute('aria-expanded', 'false');
}
// Fixed to the viewport under the timer: YouTube's header row clips overflow.
function positionLamissSettingsPopover() {
    const popover = document.getElementById(LAMISS_SETTINGS_POPOVER_ID);
    const timer = document.getElementById(LAMISS_TIMER_ID);
    if (!popover || !timer) {
        return;
    }
    const anchor = timer.getBoundingClientRect();
    const width = popover.offsetWidth;
    const left = Math.min(Math.max(8, anchor.left), window.innerWidth - width - 8);
    popover.style.left = `${left}px`;
    popover.style.top = `${anchor.bottom + 8}px`;
}
function renderLamissSettingsPopover() {
    const popover = document.getElementById(LAMISS_SETTINGS_POPOVER_ID);
    if (!popover) {
        return;
    }
    const settings = lamissQuestionSettings;
    const gapInput = popover.querySelector('#lamiss-gap-input');
    gapInput.value = String(questionGapIndex(settings.minSecondsBetweenQuestions));
    gapInput.dispatchEvent(new Event('input'));
    for (const option of popover.querySelectorAll('.lamiss-settings-popover__segments button')) {
        option.setAttribute('aria-checked', String(option.dataset.value === settings.difficulty));
    }
}
// Saving is enough: the background worker sends the new settings to Lamiss,
// which answers with a fresh NEXT_QUESTION for the countdown.
async function updateLamissQuestionSettings(change) {
    lamissQuestionSettings = { ...lamissQuestionSettings, ...change };
    renderLamissSettingsPopover();
    await saveQuestionSettings(lamissQuestionSettings);
}
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[LAMISS_QUESTION_SETTINGS_KEY]) {
        void readQuestionSettings().then((settings) => {
            lamissQuestionSettings = settings;
            renderLamissSettingsPopover();
        });
    }
});
document.addEventListener('pointerdown', (event) => {
    const popover = document.getElementById(LAMISS_SETTINGS_POPOVER_ID);
    const timer = document.getElementById(LAMISS_TIMER_ID);
    const target = event.target;
    if (popover && target && !popover.contains(target) && !timer?.contains(target)) {
        closeLamissSettingsPopover();
    }
}, true);
window.addEventListener('scroll', positionLamissSettingsPopover, { passive: true });
window.addEventListener('resize', positionLamissSettingsPopover);
// YouTube is a single-page app: the watch metadata is rebuilt on every
// in-app navigation, so keep re-checking instead of injecting once.
new MutationObserver(scheduleEnsureLamissButton).observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener('yt-navigate-finish', scheduleEnsureLamissButton);
scheduleEnsureLamissButton();
function redactCaptionUrl(url) {
    try {
        const parsed = new URL(url);
        const redacted = new URL(parsed.toString());
        redacted.search = '';
        return `${redacted.origin}${redacted.pathname} [query params redacted]`;
    }
    catch {
        return '[redacted caption URL]';
    }
}
