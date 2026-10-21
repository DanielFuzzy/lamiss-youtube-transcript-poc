// Lamiss backend calls shared by the extension pages (popup and in-page chat).
// Loaded as a plain script before each page's own script; extension pages hold
// the backend's host permission, so they call the backend directly. The
// content script loads it too, but never shared/lamiss-auth.js: there every
// call goes out without a token, so a content script is always signed out.

// Where the backend is: set at build time from LAMISS_API_URL (see
// scripts/build.js), which writes them to shared/lamiss-config.js. That file
// is loaded before this one everywhere.
declare const LAMISS_API_BASE_URL: string;
declare const LAMISS_WS_BASE_URL: string;

// --- Signing in ------------------------------------------------------------
// The background worker owns Google sign-in (see shared/lamiss-auth.js and
// background.ts); the other contexts ask it with these messages.

const LAMISS_SIGN_IN_MESSAGE = 'lamiss:sign-in';
const LAMISS_SIGN_OUT_MESSAGE = 'lamiss:sign-out';
const LAMISS_AUTH_STATE_MESSAGE = 'lamiss:auth-state';
// Sent by the worker (and extension pages) whenever the auth state changes.
const LAMISS_AUTH_CHANGED_MESSAGE = 'lamiss:auth-changed';
// The offscreen document saw a 401: the worker checks the session.
const LAMISS_SESSION_REJECTED_MESSAGE = 'lamiss:session-rejected';

type LamissAuthUser = { id: number; email: string; username: string };

// Content scripts only ever get the status, never the user or the token.
type LamissAuthState =
  | { status: 'signedOut' }
  | { status: 'signedIn'; user: LamissAuthUser; expiresAt: string }
  | { status: 'expired' };

type LamissAuthChangedMessage = { type: typeof LAMISS_AUTH_CHANGED_MESSAGE; state: LamissAuthState | { status: LamissAuthState['status'] } };

type LamissSignInResult =
  | { ok: true; state: LamissAuthState }
  | { ok: false; error: string; reason: LamissSignInFailure };

type LamissSignInFailure = 'cancelled' | 'interaction_required' | 'state_mismatch' | 'nonce_mismatch' | 'not_configured' | 'rejected' | 'failed';

const LAMISS_SIGN_IN_REQUIRED_MESSAGE = 'Sign in to use Lamiss.';
const LAMISS_SIGN_IN_AGAIN_MESSAGE = 'Please sign in again.';

// Where calls get the access token, and what a rejected token triggers.
// shared/lamiss-auth.js replaces both where it is loaded (the worker, popup
// and chat); elsewhere calls carry no token. The rejected token is passed on:
// a late 401 for an older session must not end a newer one.
let lamissReadAccessToken: () => Promise<string | undefined> = async () => undefined;
let lamissOnSessionRejected: (rejectedToken: string) => Promise<void> = async () => undefined;

type LamissLearningSession = {
  learningSessionId: number;
  videoId: number;
  videoExternalId: string;
  resumed: boolean;
  aiKnowledgeReady: boolean;
};

type LamissAnswer = {
  question?: string;
  answer?: string;
  userId?: number;
  name?: string;
};

// How often and how hard Lamiss's own questions are. Kept in extension
// storage; the background worker sends it over the live connection.
type LamissQuestionDifficulty = 'EASY' | 'MEDIUM' | 'HARD';

type LamissQuestionSettings = {
  difficulty: LamissQuestionDifficulty;
  minSecondsBetweenQuestions: number;
};

const LAMISS_QUESTION_SETTINGS_KEY = 'lamissQuestionSettings';

// Slider stops for the minimum time watched between questions, fewest
// questions first. The backend accepts 15 s to 30 min.
const LAMISS_QUESTION_GAPS_SECONDS = [600, 300, 180, 120, 90, 60, 45, 30, 15];

const LAMISS_DEFAULT_QUESTION_SETTINGS: LamissQuestionSettings = { difficulty: 'MEDIUM', minSecondsBetweenQuestions: 120 };

async function readQuestionSettings(): Promise<LamissQuestionSettings> {
  try {
    const stored = await chrome.storage.local.get(LAMISS_QUESTION_SETTINGS_KEY);
    return { ...LAMISS_DEFAULT_QUESTION_SETTINGS, ...(stored[LAMISS_QUESTION_SETTINGS_KEY] as Partial<LamissQuestionSettings> | undefined) };
  } catch {
    return LAMISS_DEFAULT_QUESTION_SETTINGS;
  }
}

function formatQuestionGap(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} s`;
  }
  const minutes = seconds / 60;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} min`;
}

// The slider stop closest to a stored gap.
function questionGapIndex(seconds: number): number {
  const gaps = LAMISS_QUESTION_GAPS_SECONDS;
  return gaps.reduce((best, gap, index) =>
    Math.abs(gap - seconds) < Math.abs(gaps[best] - seconds) ? index : best, 0);
}

function saveQuestionSettings(settings: LamissQuestionSettings): Promise<void> {
  return chrome.storage.local.set({ [LAMISS_QUESTION_SETTINGS_KEY]: settings });
}

// The microphone and speaker this browser profile uses for Lamiss, and its
// voice volume (0–1). Device IDs belong to this machine and profile, so they
// stay in extension storage and never go to the backend (TDR-0002).
type LamissDeviceSettings = {
  micDeviceId?: string;
  speakerDeviceId?: string;
  volume: number;
};

const LAMISS_DEVICE_SETTINGS_KEY = 'lamissDeviceSettings';

const LAMISS_DEFAULT_DEVICE_SETTINGS: LamissDeviceSettings = { volume: 1 };

function clampVolume(volume: unknown): number {
  return typeof volume === 'number' && Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
}

async function readDeviceSettings(): Promise<LamissDeviceSettings> {
  try {
    const stored = await chrome.storage.local.get(LAMISS_DEVICE_SETTINGS_KEY);
    const value = stored[LAMISS_DEVICE_SETTINGS_KEY] as Partial<LamissDeviceSettings> | undefined;
    return {
      ...(typeof value?.micDeviceId === 'string' && value.micDeviceId ? { micDeviceId: value.micDeviceId } : {}),
      ...(typeof value?.speakerDeviceId === 'string' && value.speakerDeviceId ? { speakerDeviceId: value.speakerDeviceId } : {}),
      volume: clampVolume(value?.volume ?? LAMISS_DEFAULT_DEVICE_SETTINGS.volume)
    };
  } catch {
    return { ...LAMISS_DEFAULT_DEVICE_SETTINGS };
  }
}

// Merges the change into what is stored. An empty device ID means "default".
async function saveDeviceSettings(change: Partial<LamissDeviceSettings>): Promise<LamissDeviceSettings> {
  const merged: LamissDeviceSettings = { ...(await readDeviceSettings()), ...change };
  const next: LamissDeviceSettings = {
    ...(merged.micDeviceId ? { micDeviceId: merged.micDeviceId } : {}),
    ...(merged.speakerDeviceId ? { speakerDeviceId: merged.speakerDeviceId } : {}),
    volume: clampVolume(merged.volume)
  };
  await chrome.storage.local.set({ [LAMISS_DEVICE_SETTINGS_KEY]: next });
  return next;
}

// --- Popup ↔ content script (TDR-0002) -------------------------------------------

// Popup → the active YouTube tab: same as clicking the in-page Lamiss button.
const LAMISS_START_LEARNING_MESSAGE = 'lamiss:start-learning';
// Popup → the active YouTube tab: replies { videoId, buttonState }.
const LAMISS_PAGE_STATUS_MESSAGE = 'lamiss:page-status';

type LamissPageStatus = { videoId: string | null; buttonState: string };

// A page of this extension (popup, chat, offscreen) or its worker, never a
// content script: those share the extension ID but run in a tab.
function isFromExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !sender.tab
    && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
}

const LAMISS_UNREACHABLE_MESSAGE = `Could not reach Lamiss at ${LAMISS_API_BASE_URL}. Check your connection and try again.`;

// signInRequired: the backend answered 401, so only signing in again helps.
type LamissCallResult<T> =
  | { ok: true; data: T }
  | { ok: false; status?: number; error: string; retryable: boolean; signInRequired?: boolean; errorCode?: string };

type LamissCallOptions = {
  // The public sign-in endpoints: no token is sent, and a 401 is an ordinary error.
  anonymous?: boolean;
  // The offscreen document has no storage access; the worker passes the token.
  accessToken?: string;
};

type LamissProblem = { detail?: string; retryable?: boolean; errorCode?: string };

async function resolveAccessToken(options: LamissCallOptions): Promise<string | undefined> {
  if (options.anonymous) {
    return undefined;
  }
  if (options.accessToken !== undefined) {
    return options.accessToken || undefined;
  }
  try {
    return await lamissReadAccessToken();
  } catch {
    return undefined;
  }
}

function withAuthorization(init: RequestInit, accessToken: string | undefined): RequestInit {
  if (!accessToken) {
    return init;
  }
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${accessToken}`);
  return { ...init, headers };
}

// A 401 on an authenticated call: the token is gone or expired. It is never
// retried; the user has to sign in again.
// rejectedToken: the token the rejected request carried, if any.
async function lamissUnauthorized(rejectedToken: string | undefined): Promise<{ ok: false; status: number; error: string; retryable: false; signInRequired: true }> {
  const tokenSent = Boolean(rejectedToken);
  if (rejectedToken) {
    await lamissOnSessionRejected(rejectedToken).catch(() => undefined);
  }
  return {
    ok: false,
    status: 401,
    error: tokenSent ? LAMISS_SIGN_IN_AGAIN_MESSAGE : LAMISS_SIGN_IN_REQUIRED_MESSAGE,
    retryable: false,
    signInRequired: true
  };
}

type LamissQuestion = {
  // Generated once per question and reused on retries, so a retry gets the
  // stored answer instead of asking the AI again.
  interactionId: string;
  learningSessionId: number;
  videoPositionMs: number;
} & ({ text: string } | { audio: Blob });

async function callLamiss<T>(path: string, init: RequestInit, options: LamissCallOptions = {}): Promise<LamissCallResult<T>> {
  try {
    const accessToken = await resolveAccessToken(options);
    const response = await fetch(`${LAMISS_API_BASE_URL}${path}`, withAuthorization(init, accessToken));
    if (!response.ok) {
      // Only the status is logged: bodies and headers can carry credentials.
      console.error('Lamiss POC: backend call failed:', path, response.status);
      if (response.status === 401 && !options.anonymous) {
        return await lamissUnauthorized(accessToken);
      }
      // Errors are RFC 9457 problem details with a "retryable" flag.
      const problem = await response.json().catch(() => undefined) as LamissProblem | undefined;
      return {
        ok: false,
        status: response.status,
        error: problem?.detail ?? `HTTP ${response.status}`,
        retryable: problem?.retryable ?? response.status >= 500,
        // TDR-0001: the machine-readable reason, when the backend gives one.
        ...(typeof problem?.errorCode === 'string' ? { errorCode: problem.errorCode } : {})
      };
    }
    return { ok: true, data: await response.json() as T };
  } catch (error) {
    console.error('Lamiss POC: backend unreachable:', path, error);
    return { ok: false, error: LAMISS_UNREACHABLE_MESSAGE, retryable: true };
  }
}

// One line of a learning session's conversation, in either direction: the
// user's questions and Lamiss's answers, and Lamiss's questions, the user's
// answers and Lamiss's feedback. occurredAt is the server's local time,
// without an offset.
type LamissChatEntry = {
  speaker: 'USER' | 'LAMISS';
  text: string;
  occurredAt: string;
};

// What the background worker tells the chat panel as it happens on the live
// connection, so the panel doesn't have to poll the history.
type LamissLiveLogEvent =
  | { type: 'lamiss-asked'; question: string }
  | { type: 'answered'; answer: string; feedback: string }
  // Something may have been missed (the connection dropped): reload the history.
  | { type: 'resync' };

const LAMISS_LIVE_LOG_SOURCE = 'lamiss-live-log';

type LamissLiveLogMessage = {
  source: typeof LAMISS_LIVE_LOG_SOURCE;
  tabId: number;
  learningSessionId: number;
  event: LamissLiveLogEvent;
};

// The whole session's conversation, oldest first.
function fetchSessionChat(learningSessionId: number): Promise<LamissCallResult<LamissChatEntry[]>> {
  return callLamiss<LamissChatEntry[]>(`/api/learning-sessions/${learningSessionId}/chat`, {
    headers: { accept: 'application/json' }
  });
}

const LAMISS_START_SESSION_MESSAGE = 'lamiss:start-session';

// Resumes the signed-in user's open session on the video, or starts one.
function startLearningSession(videoExternalId: string): Promise<LamissCallResult<LamissLearningSession>> {
  return callLamiss<LamissLearningSession>('/api/learning-sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoExternalId })
  });
}

function askLamiss(question: LamissQuestion): Promise<LamissCallResult<LamissAnswer>> {
  const form = new FormData();
  form.append('interactionId', question.interactionId);
  form.append('learningSessionId', String(question.learningSessionId));
  form.append('videoPositionMs', String(question.videoPositionMs));
  if ('text' in question) {
    form.append('question', question.text);
  } else {
    const extension = question.audio.type === 'audio/ogg' ? 'ogg' : 'webm';
    form.append('audio', question.audio, `question.${extension}`);
  }

  // No explicit Content-Type: fetch sets multipart/form-data with the boundary.
  return callLamiss<LamissAnswer>('/api/user-interaction/user-asks', {
    method: 'POST',
    headers: { accept: 'application/json' },
    body: form
  });
}

// Speech to text only: used for spoken answers to Lamiss's questions.
// language is the backend's name for what it heard ("ENGLISH", "SPANISH", …),
// or null when it couldn't tell.
// accessToken: the offscreen document gets it from the worker with each request.
function transcribeSpeech(audio: Blob, accessToken?: string): Promise<LamissCallResult<{ text?: string; language?: string | null }>> {
  const form = new FormData();
  const extension = audio.type === 'audio/ogg' ? 'ogg' : 'webm';
  form.append('audio', audio, `answer.${extension}`);
  return callLamiss<{ text?: string; language?: string | null }>('/api/speech/transcriptions', {
    method: 'POST',
    headers: { accept: 'application/json' },
    body: form
  }, { accessToken });
}

// Lamiss's own voice (a kind teacher), as MP3 audio. language (ISO 639-1)
// picks the voice when the backend uses Kokoro, whose voices speak one language each.
async function synthesizeSpeech(text: string, language?: string, accessToken?: string): Promise<LamissCallResult<Blob>> {
  try {
    const token = await resolveAccessToken({ accessToken });
    const response = await fetch(`${LAMISS_API_BASE_URL}/api/speech/synthesis`, withAuthorization({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify(language ? { text, language } : { text })
    }, token));
    if (response.status === 401) {
      return await lamissUnauthorized(token);
    }
    if (!response.ok) {
      const problem = await response.json().catch(() => undefined) as LamissProblem | undefined;
      return { ok: false, status: response.status, error: problem?.detail ?? `HTTP ${response.status}`, retryable: problem?.retryable ?? response.status >= 500 };
    }
    return { ok: true, data: await response.blob() };
  } catch {
    return { ok: false, error: LAMISS_UNREACHABLE_MESSAGE, retryable: true };
  }
}

// The language to read a text in: the one the backend reported for it (an
// ISO 639-1 code, e.g. FEEDBACK's language), else the fallback (the video's).
function lamissSpeechLanguage(reported: unknown, fallback: string | undefined): string | undefined {
  return typeof reported === 'string' && /^[a-z]{2}$/.test(reported) ? reported : fallback;
}

async function readVideoPositionMs(tabId: number): Promise<number> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const video = document.querySelector('video');
        return video ? Math.round(video.currentTime * 1000) : 0;
      }
    });
    return typeof result?.result === 'number' ? result.result : 0;
  } catch (error) {
    console.error('Lamiss POC: unable to read video position:', error);
    return 0;
  }
}

function formatVideoPosition(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// The backend was verified with audio/ogg. Prefer it when this Chrome can
// record it; otherwise fall back to WebM, which carries the same Opus audio.
function pickRecordingMimeType(): string {
  const candidates = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm'];
  return candidates.find(type => MediaRecorder.isTypeSupported(type)) ?? '';
}

// The microphone the user picked in the popup, or the default one when none
// was picked or it is gone (unplugged, or a new browser profile).
async function getMicrophoneStream(deviceId: string | undefined, audio: MediaTrackConstraints = {}): Promise<MediaStream> {
  if (!deviceId) {
    return navigator.mediaDevices.getUserMedia({ audio: Object.keys(audio).length > 0 ? audio : true });
  }
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: { exact: deviceId } } });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : (error as { name?: string } | null)?.name;
    if (name !== 'OverconstrainedError' && name !== 'NotFoundError') {
      throw error;
    }
    return navigator.mediaDevices.getUserMedia({ audio: Object.keys(audio).length > 0 ? audio : true });
  }
}

// Plays on the speaker the user picked, falling back to the default one.
async function routeAudioToSpeaker(audio: HTMLMediaElement, speakerDeviceId: string | undefined): Promise<void> {
  const element = audio as HTMLMediaElement & { setSinkId?: (sinkId: string) => Promise<void> };
  if (!speakerDeviceId || typeof element.setSinkId !== 'function') {
    return;
  }
  try {
    await element.setSinkId(speakerDeviceId);
  } catch (error) {
    console.warn('Lamiss POC: chosen speaker unavailable, using the default one:', error);
    await element.setSinkId('').catch(() => undefined);
  }
}

async function openMicrophone(): Promise<MediaStream | null> {
  try {
    const { micDeviceId } = await readDeviceSettings();
    return await getMicrophoneStream(micDeviceId);
  } catch (error) {
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

// --- Settings (TDR-0002) ---------------------------------------------------------

// The languages the backend knows (its Language enum), as ISO 639-1 codes.
const LAMISS_LANGUAGES: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'ar', name: 'Arabic' },
  { code: 'hi', name: 'Hindi' },
  { code: 'bn', name: 'Bengali' },
  { code: 'ur', name: 'Urdu' },
  { code: 'ta', name: 'Tamil' },
  { code: 'te', name: 'Telugu' },
  { code: 'ru', name: 'Russian' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'pl', name: 'Polish' },
  { code: 'cs', name: 'Czech' },
  { code: 'tr', name: 'Turkish' },
  { code: 'el', name: 'Greek' },
  { code: 'nl', name: 'Dutch' },
  { code: 'sv', name: 'Swedish' },
  { code: 'no', name: 'Norwegian' },
  { code: 'da', name: 'Danish' },
  { code: 'fi', name: 'Finnish' },
  { code: 'he', name: 'Hebrew' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'th', name: 'Thai' },
  { code: 'id', name: 'Indonesian' }
];

function lamissLanguageName(code: string | null | undefined): string {
  return LAMISS_LANGUAGES.find(language => language.code === code)?.name ?? (code ?? '');
}

type LamissProficiencyLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
type LamissKindness = 'GENTLE' | 'BALANCED' | 'STRICT';
type LamissResponseLength = 'SHORT' | 'NORMAL' | 'DETAILED';
type LamissLearningGoal = 'CONVERSATION' | 'VOCABULARY' | 'GRAMMAR' | 'LISTENING' | 'PRONUNCIATION';

// The fields added by the TDR-0002 addendum are optional here: an older
// backend leaves them out, and a PUT without them means "not set".
type LamissPreferences = {
  nativeLanguage: string | null;
  learningLanguage: string | null;
  proficiencyLevel: LamissProficiencyLevel | null;
  // null: no goal.
  learningGoal?: LamissLearningGoal | null;
  // 5–240, or null: no daily goal.
  dailyGoalMinutes?: number | null;
  tutor: {
    kindness: LamissKindness;
    responseLength: LamissResponseLength;
    encouragement: boolean;
    // null: the video's language.
    explanationLanguage: string | null;
    // Pause the video while Lamiss asks (the backend reads back true when not set).
    autoPause?: boolean;
  };
  voice: {
    // null: each language's default voice.
    voiceId: string | null;
    speed: number;
  };
};

// language null: the voice speaks every language (the OpenAI provider).
type LamissVoice = { id: string; label: string; language: string | null; default: boolean };

type LamissVoiceList = {
  provider: string;
  selectable: boolean;
  defaultSpeed: number;
  voices: LamissVoice[];
};

// GET /api/auth/me
type LamissProfile = LamissAuthUser & { displayName: string | null; pictureUrl: string | null };

function fetchPreferences(): Promise<LamissCallResult<LamissPreferences>> {
  return callLamiss<LamissPreferences>('/api/me/preferences', { headers: { accept: 'application/json' } });
}

// Always the full object; the backend answers with what it saved.
function savePreferences(preferences: LamissPreferences): Promise<LamissCallResult<LamissPreferences>> {
  return callLamiss<LamissPreferences>('/api/me/preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(preferences)
  });
}

function fetchVoices(): Promise<LamissCallResult<LamissVoiceList>> {
  return callLamiss<LamissVoiceList>('/api/speech/voices', { headers: { accept: 'application/json' } });
}

function fetchProfile(): Promise<LamissCallResult<LamissProfile>> {
  return callLamiss<LamissProfile>('/api/auth/me', { headers: { accept: 'application/json' } });
}

// --- Goals and profile editing (TDR-0002 addendum) ----------------------------------

const LAMISS_LEARNING_GOALS: ReadonlyArray<{ goal: LamissLearningGoal; label: string }> = [
  { goal: 'CONVERSATION', label: 'Conversation' },
  { goal: 'VOCABULARY', label: 'Vocabulary' },
  { goal: 'GRAMMAR', label: 'Grammar' },
  { goal: 'LISTENING', label: 'Listening' },
  { goal: 'PRONUNCIATION', label: 'Pronunciation' }
];

const LAMISS_DAILY_GOAL_MIN_MINUTES = 5;
const LAMISS_DAILY_GOAL_MAX_MINUTES = 240;

// The daily-goal slider: 0 is "Off", then 5–240 minutes.
function dailyGoalFromSlider(value: number): number | null {
  if (!Number.isFinite(value) || value < LAMISS_DAILY_GOAL_MIN_MINUTES) {
    return null;
  }
  return Math.min(LAMISS_DAILY_GOAL_MAX_MINUTES, Math.round(value));
}

function formatDailyGoal(minutes: number | null | undefined): string {
  return minutes ? `${minutes} min` : 'Off';
}

type LamissPracticeToday = { date: string; practicedMinutes: number; goalMinutes: number | null };

// The browser's IANA time zone, which decides where "today" starts.
function lamissLocalTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function fetchPracticeToday(timeZone: string = lamissLocalTimeZone()): Promise<LamissCallResult<LamissPracticeToday>> {
  return callLamiss<LamissPracticeToday>(`/api/me/practice/today?timeZone=${encodeURIComponent(timeZone)}`, {
    headers: { accept: 'application/json' }
  });
}

// "12 of 30 min today" and how far along the bar is (0–1), or undefined when
// there is no daily goal.
function describePracticeProgress(practice: LamissPracticeToday | undefined): { text: string; fraction: number; done: boolean } | undefined {
  const goal = practice?.goalMinutes;
  if (!practice || !goal || goal <= 0) {
    return undefined;
  }
  const practiced = Math.max(0, Math.floor(practice.practicedMinutes || 0));
  return {
    text: `${practiced} of ${goal} min today`,
    fraction: Math.min(1, practiced / goal),
    done: practiced >= goal
  };
}

// Same rules as the backend's domain.Username (TDR-0002 decision 12).
const LAMISS_USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;
const LAMISS_USERNAME_RULES = 'Use 3–20 letters, numbers or underscores.';

// Why a username can't be saved, or undefined when it can.
function usernameProblem(username: string): string | undefined {
  return LAMISS_USERNAME_PATTERN.test(username) ? undefined : LAMISS_USERNAME_RULES;
}

function updateUsername(username: string): Promise<LamissCallResult<LamissProfile>> {
  return callLamiss<LamissProfile>('/api/me/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ username })
  });
}

// A friendly message for a failed username change.
function describeUsernameFailure(result: { ok: false; status?: number; error: string; errorCode?: string }): string {
  if (result.status === 409 || result.errorCode === 'username_taken') {
    return 'That username is already taken. Try another one.';
  }
  if (result.errorCode === 'invalid_username') {
    return LAMISS_USERNAME_RULES;
  }
  return result.error;
}

// The voices to offer for a learning language: that language's, or all of
// them (grouped by language by the caller) when none is set.
function voicesForLanguage(voices: LamissVoice[], language: string | null): LamissVoice[] {
  return language ? voices.filter(voice => voice.language === language) : voices;
}

// Whether the server has a voice for the language: a voice of that language,
// or one that speaks every language. Without one the backend reads the text
// with its fallback voice, which speaks another language.
function lamissHasVoiceFor(list: LamissVoiceList | undefined, language: string): boolean {
  return Boolean(list?.voices.some(voice => voice.language === null || voice.language === language));
}

// The question-frequency choices of the popup, as the existing gap setting.
const LAMISS_QUESTION_FREQUENCIES = [
  { key: 'LESS', seconds: 300 },
  { key: 'NORMAL', seconds: 120 },
  { key: 'MORE', seconds: 60 }
] as const;

type LamissQuestionFrequency = typeof LAMISS_QUESTION_FREQUENCIES[number]['key'];

// The choice closest to a stored gap (the chat panel's slider has more stops).
function questionFrequencyFor(seconds: number): LamissQuestionFrequency {
  return LAMISS_QUESTION_FREQUENCIES.reduce((best, choice) =>
    Math.abs(choice.seconds - seconds) < Math.abs(best.seconds - seconds) ? choice : best).key;
}
