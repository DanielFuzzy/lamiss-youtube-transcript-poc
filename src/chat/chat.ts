// In-page chat with Lamiss. The content script embeds this page next to the
// video once its transcript is in Lamiss, passing the tab and video it's for.

const CHAT_MAX_RECORDING_MS = 60_000;
const CHAT_MIN_RECORDING_MS = 500;

const chatParams = new URLSearchParams(window.location.search);
const chatTabId = Number(chatParams.get('tabId'));
const chatVideoId = chatParams.get('videoId') ?? '';

const chatMessages = document.getElementById('messages') as HTMLDivElement;
// The session's conversation as Lamiss stored it; replaced on every resync.
const chatLog = document.getElementById('log') as HTMLDivElement;
// Questions still waiting for Lamiss's answer, or that failed, below the log.
const chatPending = document.getElementById('pending') as HTMLDivElement;
const chatComposer = document.getElementById('composer') as HTMLFormElement;
const chatInput = document.getElementById('questionInput') as HTMLTextAreaElement;
const chatSendButton = document.getElementById('sendButton') as HTMLButtonElement;
const chatMicButton = document.getElementById('micButton') as HTMLButtonElement;
const chatSessionStatus = document.getElementById('sessionStatus') as HTMLParagraphElement;
const chatCloseButton = document.getElementById('closeButton') as HTMLButtonElement;
const chatSettingsButton = document.getElementById('settingsButton') as HTMLButtonElement;
const chatSettings = document.getElementById('settings') as HTMLElement;
const chatAmountInput = document.getElementById('amountInput') as HTMLInputElement;
const chatAmountValue = document.getElementById('amountValue') as HTMLOutputElement;
const chatDifficultyInput = document.getElementById('difficultyInput') as HTMLInputElement;
const chatDifficultyValue = document.getElementById('difficultyValue') as HTMLOutputElement;
const chatSignIn = document.getElementById('signIn') as HTMLDivElement;
const chatSignInDetail = document.getElementById('signInDetail') as HTMLParagraphElement;
const chatSignInButton = document.getElementById('signInButton') as HTMLButtonElement;

const CHAT_DIFFICULTIES: LamissQuestionDifficulty[] = ['EASY', 'MEDIUM', 'HARD'];
const CHAT_DIFFICULTY_LABELS: Record<LamissQuestionDifficulty, string> = { EASY: 'Easy', MEDIUM: 'Medium', HARD: 'Hard' };

let chatSessionId: number | undefined;
let chatBusy = false;
let chatRecorder: MediaRecorder | null = null;
let chatRecordingStartedAt = 0;
let chatRecordingAutoStop: number | undefined;
let chatLogLoading = false;
let chatLogStale = false;
let chatSignedIn = false;
let chatStarting = false;

type ChatQuestion = {
  interactionId: string;
  videoPositionMs: number;
  text?: string;
  audio?: Blob;
};

function chatScrollToEnd(): void {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function chatAddNote(text: string): void {
  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = text;
  chatLog.append(note);
  chatScrollToEnd();
}

// "14:41" from the server's "2026-10-12T14:41:02.739911", or from now.
function chatClockTime(occurredAt?: string): string {
  if (occurredAt) {
    return occurredAt.slice(11, 16);
  }
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function chatCreateMessage(from: 'user' | 'lamiss', text: string, meta: string): HTMLDivElement {
  const message = document.createElement('div');
  message.className = `message ${from}`;

  const metaLine = document.createElement('span');
  metaLine.className = 'meta';
  metaLine.textContent = meta;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;

  message.append(metaLine, bubble);
  return message;
}

function chatAddMessage(from: 'user' | 'lamiss', text: string, meta: string, container: HTMLElement = chatLog): HTMLDivElement {
  const message = chatCreateMessage(from, text, meta);
  container.append(message);
  chatScrollToEnd();
  return message;
}

function chatSpeakerLabel(from: 'user' | 'lamiss', time: string): string {
  return `${from === 'user' ? 'You' : 'Lamiss'} · ${time}`;
}

// Lines that happened on this page, added straight away. If the history is
// loading meanwhile it may or may not include them, so load it once more.
function chatAppendLive(from: 'user' | 'lamiss', text: string): HTMLDivElement {
  if (chatLogLoading) {
    chatLogStale = true;
  }
  return chatAddMessage(from, text, chatSpeakerLabel(from, chatClockTime()));
}

// Backfills the whole conversation: when the panel opens, and when the live
// connection comes back after a drop.
async function chatLoadLog(): Promise<void> {
  if (chatSessionId === undefined) {
    return;
  }
  if (chatLogLoading) {
    chatLogStale = true;
    return;
  }
  chatLogLoading = true;
  try {
    do {
      chatLogStale = false;
      const result = await fetchSessionChat(chatSessionId);
      if (!result.ok) {
        chatAddNote(`Couldn't load the conversation so far: ${result.error}`);
        return;
      }
      if (chatLogStale) {
        continue;
      }
      chatLog.replaceChildren(...result.data.map(entry => {
        const from = entry.speaker === 'USER' ? 'user' : 'lamiss';
        return chatCreateMessage(from, entry.text, chatSpeakerLabel(from, chatClockTime(entry.occurredAt)));
      }));
      chatScrollToEnd();
    } while (chatLogStale);
  } finally {
    chatLogLoading = false;
  }
}

function chatAddTyping(): HTMLDivElement {
  const message = document.createElement('div');
  message.className = 'message lamiss';
  message.setAttribute('aria-label', 'Lamiss is thinking');

  const bubble = document.createElement('div');
  bubble.className = 'bubble typing';
  bubble.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));

  message.append(bubble);
  chatPending.append(message);
  chatScrollToEnd();
  return message;
}

function chatRender(): void {
  const ready = chatSessionId !== undefined;
  const recording = chatRecorder !== null;
  chatInput.disabled = !ready;
  chatSendButton.disabled = !ready || chatBusy || recording || chatInput.value.trim().length === 0;
  chatMicButton.disabled = !ready || (chatBusy && !recording);
  chatMicButton.dataset.state = recording ? 'recording' : 'idle';
  chatMicButton.setAttribute('aria-label', recording ? 'Stop recording and send' : 'Ask with your voice');
  chatMicButton.title = recording ? 'Stop and send' : 'Ask with your voice';
}

function chatResizeInput(): void {
  chatInput.style.height = 'auto';
  chatInput.style.height = `${chatInput.scrollHeight}px`;
}

// Signed out (or the session ran out): no conversation until the user signs in.
function chatShowSignIn(detail?: { text: string; error?: boolean }): void {
  chatSignedIn = false;
  chatSessionId = undefined;
  // The conversation belongs to the account that just left.
  chatLog.replaceChildren();
  chatPending.replaceChildren();
  chatSessionStatus.textContent = LAMISS_SIGN_IN_REQUIRED_MESSAGE;
  chatSignIn.hidden = false;
  chatSignInDetail.textContent = detail?.text ?? 'Your conversations are saved to your Lamiss account.';
  chatSignInDetail.classList.toggle('error', detail?.error === true);
  chatSignInButton.disabled = false;
  chatSignInButton.textContent = 'Sign in with Google';
  chatRender();
}

// Follows the sign-in kept by the worker: starts the session once signed in.
async function chatSyncAuth(): Promise<void> {
  const state = await readAuthState();
  if (state.status !== 'signedIn') {
    if (chatSignedIn || chatSignIn.hidden) {
      chatShowSignIn(state.status === 'expired' ? { text: LAMISS_SIGN_IN_AGAIN_MESSAGE } : undefined);
    }
    return;
  }
  chatSignIn.hidden = true;
  if (!chatSignedIn) {
    chatSignedIn = true;
    await chatStartSession();
  }
}

chatSignInButton.addEventListener('click', async () => {
  chatSignInButton.disabled = true;
  chatSignInButton.textContent = 'Signing in…';
  chatSignInDetail.textContent = 'Continue in the Google window.';
  chatSignInDetail.classList.remove('error');
  const result = await chrome.runtime.sendMessage({ type: LAMISS_SIGN_IN_MESSAGE })
    .catch((error: unknown): LamissSignInResult => ({ ok: false, reason: 'failed', error: error instanceof Error ? error.message : String(error) })) as LamissSignInResult | undefined;
  if (!result?.ok) {
    chatShowSignIn({ text: result?.error ?? 'Sign-in failed. Please try again.', error: result?.reason !== 'cancelled' });
    return;
  }
  await chatSyncAuth();
});

async function chatStartSession(): Promise<void> {
  if (!chatVideoId || !Number.isInteger(chatTabId)) {
    chatSessionStatus.textContent = 'Open this chat from a YouTube video';
    return;
  }
  if (chatStarting) {
    return;
  }

  chatSessionStatus.textContent = 'Starting your session…';
  chatStarting = true;
  // Through the worker, so this is the same session as Lamiss's live questions.
  const session = await chrome.runtime.sendMessage({ type: LAMISS_START_SESSION_MESSAGE, videoId: chatVideoId })
    .catch((error: unknown) => ({ ok: false, error: String(error), retryable: true })) as LamissCallResult<LamissLearningSession>;
  chatStarting = false;
  if (!session.ok) {
    if (session.signInRequired) {
      chatShowSignIn({ text: session.error });
      return;
    }
    chatSessionStatus.textContent = 'Could not start a session';
    chatAddNote(session.error);
    return;
  }
  if (!chatSignedIn) {
    // Signed out while the session was starting.
    return;
  }

  chatSessionId = session.data.learningSessionId;
  chatSessionStatus.textContent = `${session.data.resumed ? 'Resumed' : 'Started'} session ${chatSessionId}`;
  if (!session.data.aiKnowledgeReady) {
    chatAddNote('Lamiss hasn\'t finished learning this video yet, so questions may fail for a moment.');
  }
  chatRender();
  chatInput.focus();
  await chatLoadLog();
}

// One question, from asking to answer. The user bubble stays in place; a
// failed attempt offers a retry that resends the same interactionId, so the
// backend returns the stored answer instead of asking the AI twice.
async function chatSend(question: ChatQuestion, userMessage: HTMLDivElement): Promise<void> {
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
    ...(question.text !== undefined ? { text: question.text } : { audio: question.audio as Blob })
  });

  typing.remove();
  chatBusy = false;
  chatRender();

  const userBubble = userMessage.querySelector('.bubble') as HTMLDivElement;
  if (result.ok && result.data.question && userBubble.classList.contains('pending-voice')) {
    userBubble.classList.remove('pending-voice');
    userBubble.textContent = result.data.question;
  }

  if (result.ok) {
    // Answered, so both lines are now in the session's history.
    userMessage.remove();
    chatAppendLive('user', userBubble.textContent ?? '');
    chatAppendLive('lamiss', result.data.answer?.trim() || 'Lamiss returned an empty answer.');
    return;
  }

  if (result.signInRequired) {
    chatShowSignIn({ text: result.error });
  }
  const failure = chatAddMessage('lamiss', `Lamiss couldn't answer: ${result.error}`, 'Lamiss', chatPending);
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

async function chatSendText(): Promise<void> {
  const text = chatInput.value.trim();
  if (!text || chatBusy || chatSessionId === undefined) {
    return;
  }

  chatInput.value = '';
  chatResizeInput();
  const videoPositionMs = await readVideoPositionMs(chatTabId);
  const userMessage = chatAddMessage('user', text, `You · ${formatVideoPosition(videoPositionMs)}`, chatPending);
  await chatSend({ interactionId: crypto.randomUUID(), videoPositionMs, text }, userMessage);
}

async function chatStartRecording(): Promise<void> {
  let stream: MediaStream | null;
  try {
    stream = await openMicrophone();
  } catch (error) {
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
  const chunks: Blob[] = [];

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
    const userMessage = chatAddMessage('user', 'Voice question…', `You · ${formatVideoPosition(videoPositionMs)}`, chatPending);
    userMessage.querySelector('.bubble')?.classList.add('pending-voice');
    void chatSend({ interactionId: crypto.randomUUID(), videoPositionMs, audio }, userMessage);
  });

  chatRecorder = recorder;
  chatRecordingStartedAt = Date.now();
  recorder.start();
  chatRecordingAutoStop = window.setTimeout(chatStopRecording, CHAT_MAX_RECORDING_MS);
  chatRender();
}

function chatStopRecording(): void {
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
  } else if (!chatBusy) {
    void chatStartRecording();
  }
});

function chatRenderSettingLabels(): void {
  chatAmountValue.textContent = `At least ${formatQuestionGap(LAMISS_QUESTION_GAPS_SECONDS[Number(chatAmountInput.value)])} apart`;
  chatDifficultyValue.textContent = CHAT_DIFFICULTY_LABELS[CHAT_DIFFICULTIES[Number(chatDifficultyInput.value)]];
}

async function chatLoadSettings(): Promise<void> {
  const settings = await readQuestionSettings();
  chatAmountInput.max = String(LAMISS_QUESTION_GAPS_SECONDS.length - 1);
  chatAmountInput.value = String(questionGapIndex(settings.minSecondsBetweenQuestions));
  chatDifficultyInput.value = String(Math.max(0, CHAT_DIFFICULTIES.indexOf(settings.difficulty)));
  chatRenderSettingLabels();
}

function chatSaveSettings(): void {
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

// Lamiss's questions, the user's answers and the feedback, from the live
// connection of the tab this panel is in.
chrome.runtime.onMessage.addListener((message: Partial<LamissLiveLogMessage> & { type?: string } | undefined, sender) => {
  if (sender.id !== chrome.runtime.id) {
    return false;
  }
  if (message?.type === LAMISS_AUTH_CHANGED_MESSAGE) {
    void chatSyncAuth();
    return false;
  }
  if (message?.source !== LAMISS_LIVE_LOG_SOURCE || message.tabId !== chatTabId
    || chatSessionId === undefined || message.learningSessionId !== chatSessionId || !message.event) {
    return false;
  }
  const event = message.event;
  switch (event.type) {
    case 'lamiss-asked':
      chatAppendLive('lamiss', event.question);
      break;
    case 'answered':
      chatAppendLive('user', event.answer);
      chatAppendLive('lamiss', event.feedback);
      break;
    case 'resync':
      void chatLoadLog();
      break;
  }
  return false;
});

chatRender();
void chatLoadSettings();
void chatSyncAuth();
