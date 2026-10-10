"use strict";
// In-page chat with Lamiss. The content script embeds this page next to the
// video once its transcript is in Lamiss, passing the tab and video it's for.
const CHAT_MAX_RECORDING_MS = 60000;
const CHAT_MIN_RECORDING_MS = 500;
const chatParams = new URLSearchParams(window.location.search);
const chatTabId = Number(chatParams.get('tabId'));
const chatVideoId = chatParams.get('videoId') ?? '';
const chatMessages = document.getElementById('messages');
const chatComposer = document.getElementById('composer');
const chatInput = document.getElementById('questionInput');
const chatSendButton = document.getElementById('sendButton');
const chatMicButton = document.getElementById('micButton');
const chatSessionStatus = document.getElementById('sessionStatus');
const chatCloseButton = document.getElementById('closeButton');
const chatSettingsButton = document.getElementById('settingsButton');
const chatSettings = document.getElementById('settings');
const chatAmountInput = document.getElementById('amountInput');
const chatAmountValue = document.getElementById('amountValue');
const chatDifficultyInput = document.getElementById('difficultyInput');
const chatDifficultyValue = document.getElementById('difficultyValue');
const CHAT_DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD'];
const CHAT_DIFFICULTY_LABELS = { EASY: 'Easy', MEDIUM: 'Medium', HARD: 'Hard' };
let chatSessionId;
let chatBusy = false;
let chatRecorder = null;
let chatRecordingStartedAt = 0;
let chatRecordingAutoStop;
function chatScrollToEnd() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
}
function chatAddNote(text) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = text;
    chatMessages.append(note);
    chatScrollToEnd();
}
function chatAddMessage(from, text, meta) {
    const message = document.createElement('div');
    message.className = `message ${from}`;
    const metaLine = document.createElement('span');
    metaLine.className = 'meta';
    metaLine.textContent = meta;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    message.append(metaLine, bubble);
    chatMessages.append(message);
    chatScrollToEnd();
    return message;
}
function chatAddTyping() {
    const message = document.createElement('div');
    message.className = 'message lamiss';
    message.setAttribute('aria-label', 'Lamiss is thinking');
    const bubble = document.createElement('div');
    bubble.className = 'bubble typing';
    bubble.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
    message.append(bubble);
    chatMessages.append(message);
    chatScrollToEnd();
    return message;
}
function chatRender() {
    const ready = chatSessionId !== undefined;
    const recording = chatRecorder !== null;
    chatInput.disabled = !ready;
    chatSendButton.disabled = !ready || chatBusy || recording || chatInput.value.trim().length === 0;
    chatMicButton.disabled = !ready || (chatBusy && !recording);
    chatMicButton.dataset.state = recording ? 'recording' : 'idle';
    chatMicButton.setAttribute('aria-label', recording ? 'Stop recording and send' : 'Ask with your voice');
    chatMicButton.title = recording ? 'Stop and send' : 'Ask with your voice';
}
function chatResizeInput() {
    chatInput.style.height = 'auto';
    chatInput.style.height = `${chatInput.scrollHeight}px`;
}
async function chatStartSession() {
    if (!chatVideoId || !Number.isInteger(chatTabId)) {
        chatSessionStatus.textContent = 'Open this chat from a YouTube video';
        return;
    }
    const session = await startLearningSession(chatVideoId);
    if (!session.ok) {
        chatSessionStatus.textContent = 'Could not start a session';
        chatAddNote(session.error);
        return;
    }
    chatSessionId = session.data.learningSessionId;
    chatSessionStatus.textContent = `${session.data.resumed ? 'Resumed' : 'Started'} session ${chatSessionId}`;
    if (!session.data.aiKnowledgeReady) {
        chatAddNote('Lamiss hasn\'t finished learning this video yet, so questions may fail for a moment.');
    }
    chatRender();
    chatInput.focus();
}
// One question, from asking to answer. The user bubble stays in place; a
// failed attempt offers a retry that resends the same interactionId, so the
// backend returns the stored answer instead of asking the AI twice.
async function chatSend(question, userMessage) {
    if (chatSessionId === undefined) {
        return;
    }
    chatBusy = true;
    chatRender();
    const typing = chatAddTyping();
    const result = await askLamiss({
        interactionId: question.interactionId,
        learningSessionId: chatSessionId,
        videoPositionMs: question.videoPositionMs,
        ...(question.text !== undefined ? { text: question.text } : { audio: question.audio })
    });
    typing.remove();
    chatBusy = false;
    chatRender();
    const userBubble = userMessage.querySelector('.bubble');
    if (result.ok && result.data.question && userBubble.classList.contains('pending-voice')) {
        userBubble.classList.remove('pending-voice');
        userBubble.textContent = result.data.question;
    }
    if (result.ok) {
        chatAddMessage('lamiss', result.data.answer?.trim() || 'Lamiss returned an empty answer.', 'Lamiss');
        return;
    }
    const failure = chatAddMessage('lamiss', `Lamiss couldn't answer: ${result.error}`, 'Lamiss');
    failure.classList.add('error');
    if (result.retryable) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'retry';
        retry.textContent = 'Try again';
        retry.addEventListener('click', () => {
            if (chatBusy) {
                return;
            }
            failure.remove();
            void chatSend(question, userMessage);
        });
        failure.append(retry);
    }
}
async function chatSendText() {
    const text = chatInput.value.trim();
    if (!text || chatBusy || chatSessionId === undefined) {
        return;
    }
    chatInput.value = '';
    chatResizeInput();
    const videoPositionMs = await readVideoPositionMs(chatTabId);
    const userMessage = chatAddMessage('user', text, `You · ${formatVideoPosition(videoPositionMs)}`);
    await chatSend({ interactionId: crypto.randomUUID(), videoPositionMs, text }, userMessage);
}
async function chatStartRecording() {
    let stream;
    try {
        stream = await openMicrophone();
    }
    catch (error) {
        console.error('Lamiss POC: microphone error:', error);
        chatAddNote('Could not open the microphone.');
        return;
    }
    if (!stream) {
        chatAddNote('Allow microphone access in the tab that just opened, then tap the mic again.');
        return;
    }
    const videoPositionMs = await readVideoPositionMs(chatTabId);
    const mimeType = pickRecordingMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) {
            chunks.push(event.data);
        }
    });
    recorder.addEventListener('stop', () => {
        stream?.getTracks().forEach(track => track.stop());
        chatRecorder = null;
        chatRender();
        const audio = new Blob(chunks, { type: (recorder.mimeType || 'audio/webm').split(';')[0] });
        if (Date.now() - chatRecordingStartedAt < CHAT_MIN_RECORDING_MS || audio.size === 0) {
            chatAddNote('That was too short. Tap the mic and ask again.');
            return;
        }
        // The backend returns the transcribed question; it replaces this placeholder.
        const userMessage = chatAddMessage('user', 'Voice question…', `You · ${formatVideoPosition(videoPositionMs)}`);
        userMessage.querySelector('.bubble')?.classList.add('pending-voice');
        void chatSend({ interactionId: crypto.randomUUID(), videoPositionMs, audio }, userMessage);
    });
    chatRecorder = recorder;
    chatRecordingStartedAt = Date.now();
    recorder.start();
    chatRecordingAutoStop = window.setTimeout(chatStopRecording, CHAT_MAX_RECORDING_MS);
    chatRender();
}
function chatStopRecording() {
    window.clearTimeout(chatRecordingAutoStop);
    if (chatRecorder && chatRecorder.state !== 'inactive') {
        chatRecorder.stop();
    }
}
chatComposer.addEventListener('submit', (event) => {
    event.preventDefault();
    void chatSendText();
});
chatInput.addEventListener('keydown', (event) => {
    // Enter sends; Shift+Enter adds a new line. Ignore Enter while an IME is composing.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void chatSendText();
    }
});
chatInput.addEventListener('input', () => {
    chatResizeInput();
    chatRender();
});
chatMicButton.addEventListener('click', () => {
    if (chatRecorder) {
        chatStopRecording();
    }
    else if (!chatBusy) {
        void chatStartRecording();
    }
});
function chatRenderSettingLabels() {
    chatAmountValue.textContent = `At least ${formatQuestionGap(LAMISS_QUESTION_GAPS_SECONDS[Number(chatAmountInput.value)])} apart`;
    chatDifficultyValue.textContent = CHAT_DIFFICULTY_LABELS[CHAT_DIFFICULTIES[Number(chatDifficultyInput.value)]];
}
async function chatLoadSettings() {
    const settings = await readQuestionSettings();
    chatAmountInput.max = String(LAMISS_QUESTION_GAPS_SECONDS.length - 1);
    chatAmountInput.value = String(questionGapIndex(settings.minSecondsBetweenQuestions));
    chatDifficultyInput.value = String(Math.max(0, CHAT_DIFFICULTIES.indexOf(settings.difficulty)));
    chatRenderSettingLabels();
}
function chatSaveSettings() {
    chatRenderSettingLabels();
    void saveQuestionSettings({
        difficulty: CHAT_DIFFICULTIES[Number(chatDifficultyInput.value)],
        minSecondsBetweenQuestions: LAMISS_QUESTION_GAPS_SECONDS[Number(chatAmountInput.value)]
    });
}
chatAmountInput.addEventListener('input', chatRenderSettingLabels);
chatDifficultyInput.addEventListener('input', chatRenderSettingLabels);
// Save when the thumb is released, not on every step while dragging.
chatAmountInput.addEventListener('change', chatSaveSettings);
chatDifficultyInput.addEventListener('change', chatSaveSettings);
// The settings can also change from the timer next to the Lamiss button.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[LAMISS_QUESTION_SETTINGS_KEY]) {
        void chatLoadSettings();
    }
});
chatSettingsButton.addEventListener('click', () => {
    const open = chatSettings.hidden;
    chatSettings.hidden = !open;
    chatSettingsButton.setAttribute('aria-expanded', String(open));
});
chatCloseButton.addEventListener('click', () => {
    // The content script owns the panel; it only accepts this from its own frame.
    window.parent.postMessage({ type: 'lamiss:close-chat' }, 'https://www.youtube.com');
});
chatRender();
void chatLoadSettings();
void chatStartSession();
