"use strict";
const MAX_QUESTION_DURATION_MS = 60000;
const MIN_QUESTION_DURATION_MS = 500;
const loadTranscriptButton = document.getElementById('loadTranscript');
const statusBox = document.getElementById('status');
const askButton = document.getElementById('askButton');
const askHint = document.getElementById('askHint');
const answerBox = document.getElementById('answer');
const answerText = document.getElementById('answerText');
const answerMeta = document.getElementById('answerMeta');
function setStatus(message) {
    if (statusBox) {
        statusBox.textContent = message;
    }
}
// The background worker owns the ingest call so the popup and the in-page
// Lamiss button send transcripts the same way.
function sendTranscriptToBackend(payload) {
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
loadTranscriptButton?.addEventListener('click', async () => {
    setStatus('Status: Loading...');
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const activeTab = tabs[0];
        if (!activeTab?.id) {
            setStatus('Status: No active tab');
            return;
        }
        if (!activeTab.url) {
            setStatus('Status: Active tab has no URL');
            return;
        }
        const parsedActiveTabUrl = new URL(activeTab.url);
        if (parsedActiveTabUrl.hostname !== 'www.youtube.com' && parsedActiveTabUrl.hostname !== 'youtube.com') {
            setStatus('Status: Active tab is not a YouTube watch page');
            return;
        }
        if (parsedActiveTabUrl.pathname !== '/watch') {
            setStatus('Status: Active tab is not a YouTube watch page');
            return;
        }
        if (!parsedActiveTabUrl.searchParams.get('v')) {
            setStatus('Status: Active tab is not a YouTube watch page');
            return;
        }
        chrome.tabs.sendMessage(activeTab.id, {
            type: 'LOAD_TRANSCRIPT',
            tabId: activeTab.id
        }, async (response) => {
            if (chrome.runtime.lastError) {
                setStatus('Status: Content script unavailable');
                console.error('Content script error:', chrome.runtime.lastError.message);
                return;
            }
            if (!response?.success) {
                setStatus(`Status: ${response?.error ?? 'Transcript failed'}`);
                return;
            }
            const loadedNote = `Video ${response.videoId ?? 'unknown'} loaded in ${response.language ?? 'unknown'}`;
            setStatus(`Status: ${loadedNote} — sending to Lamiss...`);
            const uploadResult = await sendTranscriptToBackend({
                videoExternalId: response.videoId,
                videoPlatform: 'YOUTUBE',
                videoTitle: response.videoTitle,
                videoDurationSeconds: response.videoDurationSeconds,
                language: response.language,
                translated: response.translated,
                rawCaptionResponse: response.rawCaptionResponse
            });
            if (!uploadResult.ok) {
                console.error('Lamiss backend upload failed:', uploadResult.error ?? uploadResult.status);
                setStatus(`Status: ${loadedNote} — upload failed`);
                return;
            }
            setStatus(`Status: ${loadedNote} — sent to Lamiss`);
        });
    }
    catch (error) {
        console.error('Popup error:', error);
        setStatus('Status: Failed to load transcript');
    }
});
let askState = 'idle';
let mediaRecorder = null;
let recordedChunks = [];
let recordingStartedAt = 0;
let recordingTimer;
let recordingAutoStop;
let questionVideoPositionMs = 0;
let questionVideoId = '';
function setAskState(state, hint) {
    askState = state;
    if (askButton) {
        askButton.dataset.state = state;
        askButton.disabled = state === 'sending';
        askButton.setAttribute('aria-label', state === 'recording' ? 'Stop recording and send question' : 'Start recording your question');
    }
    if (askHint) {
        askHint.textContent = hint;
    }
}
function showAnswer(text, meta, isError = false) {
    if (!answerBox || !answerText || !answerMeta) {
        return;
    }
    answerBox.hidden = false;
    answerBox.classList.toggle('error', isError);
    answerText.textContent = text;
    answerMeta.textContent = meta;
}
// The question is asked about the video in the active tab: its learning
// session, and its playback position when recording started.
async function readActiveVideo() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) {
        return null;
    }
    const url = new URL(tab.url);
    const videoId = url.searchParams.get('v');
    if ((url.hostname !== 'www.youtube.com' && url.hostname !== 'youtube.com') || url.pathname !== '/watch' || !videoId) {
        return null;
    }
    return { tabId: tab.id, videoId };
}
function clearRecordingTimers() {
    window.clearInterval(recordingTimer);
    window.clearTimeout(recordingAutoStop);
    recordingTimer = undefined;
    recordingAutoStop = undefined;
}
async function startRecording() {
    const activeVideo = await readActiveVideo();
    if (!activeVideo) {
        setAskState('idle', 'Open a YouTube video to ask about it');
        return;
    }
    setAskState('sending', 'Opening microphone…');
    let stream;
    try {
        stream = await openMicrophone();
    }
    catch (error) {
        console.error('Lamiss POC: microphone error:', error);
        setAskState('idle', 'Could not open the microphone');
        return;
    }
    if (!stream) {
        setAskState('idle', 'Allow microphone access in the new tab, then try again');
        return;
    }
    questionVideoId = activeVideo.videoId;
    questionVideoPositionMs = await readVideoPositionMs(activeVideo.tabId);
    const mimeType = pickRecordingMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recordedChunks = [];
    recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) {
            recordedChunks.push(event.data);
        }
    });
    recorder.addEventListener('stop', () => {
        stream?.getTracks().forEach(track => track.stop());
        const durationMs = Date.now() - recordingStartedAt;
        const containerType = (recorder.mimeType || 'audio/webm').split(';')[0];
        const audio = new Blob(recordedChunks, { type: containerType });
        if (durationMs < MIN_QUESTION_DURATION_MS || audio.size === 0) {
            setAskState('idle', 'That was too short — tap and ask again');
            return;
        }
        void sendQuestion(audio, questionVideoId, questionVideoPositionMs);
    });
    mediaRecorder = recorder;
    recordingStartedAt = Date.now();
    recorder.start();
    setAskState('recording', 'Listening… 0:00 — tap to send');
    recordingTimer = window.setInterval(() => {
        setAskState('recording', `Listening… ${formatVideoPosition(Date.now() - recordingStartedAt)} — tap to send`);
    }, 250);
    recordingAutoStop = window.setTimeout(stopRecording, MAX_QUESTION_DURATION_MS);
}
function stopRecording() {
    clearRecordingTimers();
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        setAskState('sending', 'Sending your question…');
        mediaRecorder.stop();
    }
    mediaRecorder = null;
}
async function sendQuestion(audio, videoId, videoPositionMs) {
    setAskState('sending', 'Lamiss is thinking…');
    const meta = `Asked at ${formatVideoPosition(videoPositionMs)}`;
    console.log('Lamiss POC: user-ask audio type =', audio.type, 'size =', audio.size, 'videoPositionMs =', videoPositionMs);
    const session = await startLearningSession(videoId);
    if (!session.ok) {
        showAnswer(session.status === 404 ? 'Click "Start using Lamiss" on the video first.' : session.error, meta, true);
        setAskState('idle', 'Tap the mic to try again');
        return;
    }
    const result = await askLamiss({
        interactionId: crypto.randomUUID(),
        learningSessionId: session.data.learningSessionId,
        videoPositionMs,
        audio
    });
    if (!result.ok) {
        showAnswer(`Lamiss couldn't answer: ${result.error}`, meta, true);
        setAskState('idle', 'Tap the mic to try again');
        return;
    }
    const askedMeta = result.data.question ? `${meta} · "${result.data.question}"` : meta;
    showAnswer(result.data.answer?.trim() || 'Lamiss returned an empty answer.', askedMeta);
    setAskState('idle', 'Tap the mic to ask another question');
}
askButton?.addEventListener('click', () => {
    if (askState === 'idle') {
        void startRecording();
    }
    else if (askState === 'recording') {
        stopRecording();
    }
});
