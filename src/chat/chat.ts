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
(document.getElementById('privacyLink') as HTMLAnchorElement).href = LAMISS_PRIVACY_POLICY_URL;

const CHAT_DIFFICULTIES: LamissQuestionDifficulty[] = ['EASY', 'MEDIUM', 'HARD'];
const CHAT_DIFFICULTY_LABELS: Record<LamissQuestionDifficulty, LamissMessageKey> = { EASY: 'common.easy', MEDIUM: 'common.medium', HARD: 'common.hard' };

let chatSessionId: number | undefined;
let chatBusy = false;
let chatRecorder: MediaRecorder | null = null;
let chatRecordingStartedAt = 0;
let chatRecordingAutoStop: number | undefined;
let chatLogLoading = false;
let chatLogStale = false;
let chatSignedIn = false;
let chatStarting = false;
// The header's status line, rebuilt when the app language changes.
let chatStatus: () => string = () => lamissT('chat.starting');

function chatSetStatus(status: () => string): void {
  chatStatus = status;
  chatSessionStatus.textContent = status();
}

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
  return `${from === 'user' ? lamissT('chat.you') : 'Lamiss'} · ${time}`;
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
        chatAddNote(lamissT('chat.couldNotLoad', { error: result.error }));
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
  message.setAttribute('aria-label', lamissT('chat.thinking'));

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
  chatMicButton.setAttribute('aria-label', lamissT(recording ? 'chat.stopRecordingAndSend' : 'chat.askVoice'));
  chatMicButton.title = lamissT(recording ? 'chat.stopAndSend' : 'chat.askVoice');
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
  chatSetStatus(lamissSignInRequiredMessage);
  chatSignIn.hidden = false;
  chatSignInDetail.textContent = detail?.text ?? lamissT('chat.signInDetail');
  chatSignInDetail.classList.toggle('error', detail?.error === true);
  chatSignInButton.disabled = false;
  chatSignInButton.textContent = lamissT('privacy.agreeAndSignIn');
  chatRender();
}

// Follows the sign-in kept by the worker: starts the session once signed in.
async function chatSyncAuth(): Promise<void> {
  const state = await readAuthState();
  if (state.status !== 'signedIn') {
    if (chatSignedIn || chatSignIn.hidden) {
      chatShowSignIn(state.status === 'expired' ? { text: lamissSignInAgainMessage() } : undefined);
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
  chatSignInButton.textContent = lamissT('common.signingIn');
  chatSignInDetail.textContent = lamissT('chat.continueInGoogle');
  chatSignInDetail.classList.remove('error');
  // The button says "Agree and sign in": clicking it accepts the notice above it.
  const result = await chrome.runtime.sendMessage({ type: LAMISS_SIGN_IN_MESSAGE, acceptPrivacyNotice: true })
    .catch((error: unknown): LamissSignInResult => ({ ok: false, reason: 'failed', error: error instanceof Error ? error.message : String(error) })) as LamissSignInResult | undefined;
  if (!result?.ok) {
    chatShowSignIn({ text: result?.error ?? lamissT('common.signInFailed'), error: result?.reason !== 'cancelled' });
    return;
  }
  await chatSyncAuth();
});

async function chatStartSession(): Promise<void> {
  if (!chatVideoId || !Number.isInteger(chatTabId)) {
    chatSetStatus(() => lamissT('chat.openFromVideo'));
    return;
  }
  if (chatStarting) {
    return;
  }

  chatSetStatus(() => lamissT('chat.starting'));
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
    chatSetStatus(() => lamissT('chat.couldNotStart'));
    chatAddNote(session.error);
    return;
  }
  if (!chatSignedIn) {
    // Signed out while the session was starting.
    return;
  }

  const sessionId = session.data.learningSessionId;
  const resumed = session.data.resumed;
  chatSessionId = sessionId;
  chatSetStatus(() => lamissT(resumed ? 'chat.resumed' : 'chat.started', { id: sessionId }));
  if (!session.data.aiKnowledgeReady) {
    chatAddNote(lamissT('chat.notReady'));
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
    chatAppendLive('lamiss', result.data.answer?.trim() || lamissT('chat.emptyAnswer'));
    return;
  }

  if (result.signInRequired) {
    chatShowSignIn({ text: result.error });
  }
  const failure = chatAddMessage('lamiss', lamissT('chat.couldNotAnswer', { error: result.error }), 'Lamiss', chatPending);
  failure.classList.add('error');
  if (result.retryable) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'retry';
    retry.textContent = lamissT('common.tryAgain');
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
  const userMessage = chatAddMessage('user', text, `${lamissT('chat.you')} · ${formatVideoPosition(videoPositionMs)}`, chatPending);
  await chatSend({ interactionId: crypto.randomUUID(), videoPositionMs, text }, userMessage);
}

async function chatStartRecording(): Promise<void> {
  let stream: MediaStream | null;
  try {
    stream = await openMicrophone();
  } catch (error) {
    console.error('Lamiss POC: microphone error:', error);
    chatAddNote(lamissT('common.micFailed'));
    return;
  }
  if (!stream) {
    chatAddNote(lamissT('chat.allowMicTab'));
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
      chatAddNote(lamissT('chat.tooShort'));
      return;
    }

    // The backend returns the transcribed question; it replaces this placeholder.
    const userMessage = chatAddMessage('user', lamissT('chat.voiceQuestion'), `${lamissT('chat.you')} · ${formatVideoPosition(videoPositionMs)}`, chatPending);
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
  chatAmountValue.textContent = lamissT('common.gapApart', { gap: formatQuestionGap(LAMISS_QUESTION_GAPS_SECONDS[Number(chatAmountInput.value)]) });
  chatDifficultyValue.textContent = lamissT(CHAT_DIFFICULTY_LABELS[CHAT_DIFFICULTIES[Number(chatDifficultyInput.value)]]);
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

// The app language changed on another page (TDR-0003): the static text, the
// labels and the conversation's "You · 14:41" lines follow.
onAppLanguageChange(() => {
  applyLamissTranslations();
  chatSessionStatus.textContent = chatStatus();
  chatRender();
  chatRenderSettingLabels();
  if (!chatSignIn.hidden) {
    chatSignInDetail.textContent = lamissT('chat.signInDetail');
    chatSignInButton.textContent = lamissT('privacy.agreeAndSignIn');
  }
  void chatLoadLog();
});

void (async () => {
  try {
    await loadAppLanguage();
    applyLamissTranslations();
    chatSessionStatus.textContent = chatStatus();
  } finally {
    document.documentElement.removeAttribute('data-lamiss-i18n');
  }
  chatRender();
  void chatLoadSettings();
  void chatSyncAuth();
})();
