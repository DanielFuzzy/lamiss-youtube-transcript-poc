"use strict";
// Lamiss backend calls shared by the extension pages (popup and in-page chat).
// Loaded as a plain script before each page's own script; extension pages hold
// the localhost host permission, so they call the backend directly.
const LAMISS_API_BASE_URL = 'http://localhost:8080';
const LAMISS_WS_BASE_URL = 'ws://localhost:8080';
// There are no accounts yet: the backend hardcodes this local mock user too.
const LAMISS_USER_ID = 1001;
const LAMISS_QUESTION_SETTINGS_KEY = 'lamissQuestionSettings';
// Slider stops for the minimum time watched between questions, fewest
// questions first. The backend accepts 15 s to 30 min.
const LAMISS_QUESTION_GAPS_SECONDS = [600, 300, 180, 120, 90, 60, 45, 30, 15];
const LAMISS_DEFAULT_QUESTION_SETTINGS = { difficulty: 'MEDIUM', minSecondsBetweenQuestions: 120 };
async function readQuestionSettings() {
    try {
        const stored = await chrome.storage.local.get(LAMISS_QUESTION_SETTINGS_KEY);
        return { ...LAMISS_DEFAULT_QUESTION_SETTINGS, ...stored[LAMISS_QUESTION_SETTINGS_KEY] };
    }
    catch {
        return LAMISS_DEFAULT_QUESTION_SETTINGS;
    }
}
function formatQuestionGap(seconds) {
    if (seconds < 60) {
        return `${seconds} s`;
    }
    const minutes = seconds / 60;
    return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} min`;
}
// The slider stop closest to a stored gap.
function questionGapIndex(seconds) {
    const gaps = LAMISS_QUESTION_GAPS_SECONDS;
    return gaps.reduce((best, gap, index) => Math.abs(gap - seconds) < Math.abs(gaps[best] - seconds) ? index : best, 0);
}
function saveQuestionSettings(settings) {
    return chrome.storage.local.set({ [LAMISS_QUESTION_SETTINGS_KEY]: settings });
}
async function callLamiss(path, init) {
    try {
        const response = await fetch(`${LAMISS_API_BASE_URL}${path}`, init);
        if (!response.ok) {
            // Errors are RFC 9457 problem details with a "retryable" flag.
            const problem = await response.json().catch(() => undefined);
            console.error('Lamiss POC: backend call failed:', path, response.status, problem);
            return {
                ok: false,
                status: response.status,
                error: problem?.detail ?? `HTTP ${response.status}`,
                retryable: problem?.retryable ?? response.status >= 500
            };
        }
        return { ok: true, data: await response.json() };
    }
    catch (error) {
        console.error('Lamiss POC: backend unreachable:', path, error);
        return { ok: false, error: 'Could not reach the Lamiss backend. Is it running on localhost:8080?', retryable: true };
    }
}
// Resumes the (hardcoded, local) user's open session on the video, or starts one.
function startLearningSession(videoExternalId) {
    return callLamiss('/api/learning-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoExternalId })
    });
}
function askLamiss(question) {
    const form = new FormData();
    form.append('interactionId', question.interactionId);
    form.append('learningSessionId', String(question.learningSessionId));
    form.append('videoPositionMs', String(question.videoPositionMs));
    if ('text' in question) {
        form.append('question', question.text);
    }
    else {
        const extension = question.audio.type === 'audio/ogg' ? 'ogg' : 'webm';
        form.append('audio', question.audio, `question.${extension}`);
    }
    // No explicit Content-Type: fetch sets multipart/form-data with the boundary.
    return callLamiss('/api/user-interaction/user-asks', {
        method: 'POST',
        headers: { accept: 'application/json' },
        body: form
    });
}
// Speech to text only: used for spoken answers to Lamiss's questions.
function transcribeSpeech(audio) {
    const form = new FormData();
    const extension = audio.type === 'audio/ogg' ? 'ogg' : 'webm';
    form.append('audio', audio, `answer.${extension}`);
    return callLamiss('/api/speech/transcriptions', {
        method: 'POST',
        headers: { accept: 'application/json' },
        body: form
    });
}
// Lamiss's own voice (a kind teacher), as MP3 audio. language (ISO 639-1)
// picks the voice when the backend uses Kokoro, whose voices speak one language each.
async function synthesizeSpeech(text, language) {
    try {
        const response = await fetch(`${LAMISS_API_BASE_URL}/api/speech/synthesis`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', accept: 'audio/mpeg' },
            body: JSON.stringify(language ? { text, language } : { text })
        });
        if (!response.ok) {
            const problem = await response.json().catch(() => undefined);
            return { ok: false, status: response.status, error: problem?.detail ?? `HTTP ${response.status}`, retryable: problem?.retryable ?? response.status >= 500 };
        }
        return { ok: true, data: await response.blob() };
    }
    catch {
        return { ok: false, error: 'Could not reach the Lamiss backend. Is it running on localhost:8080?', retryable: true };
    }
}
async function readVideoPositionMs(tabId) {
    try {
        const [result] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                const video = document.querySelector('video');
                return video ? Math.round(video.currentTime * 1000) : 0;
            }
        });
        return typeof result?.result === 'number' ? result.result : 0;
    }
    catch (error) {
        console.error('Lamiss POC: unable to read video position:', error);
        return 0;
    }
}
function formatVideoPosition(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
// The backend was verified with audio/ogg. Prefer it when this Chrome can
// record it; otherwise fall back to WebM, which carries the same Opus audio.
function pickRecordingMimeType() {
    const candidates = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm'];
    return candidates.find(type => MediaRecorder.isTypeSupported(type)) ?? '';
}
async function openMicrophone() {
    try {
        return await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    catch (error) {
        const name = error instanceof DOMException ? error.name : '';
        if (name === 'NotAllowedError' || name === 'SecurityError') {
            // Chrome can't always show the mic prompt inside the popup or an embedded
            // frame. Granting it once from a regular extension tab covers every
            // extension page, since they share the chrome-extension:// origin.
            await chrome.tabs.create({ url: chrome.runtime.getURL('permission/permission.html') });
            return null;
        }
        throw error;
    }
}
