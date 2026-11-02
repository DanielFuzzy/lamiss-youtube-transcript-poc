// Lamiss backend calls shared by the extension pages (popup and in-page chat).
// Loaded as a plain script after shared/lamiss-i18n.js (its messages follow the
// app language) and before each page's own script; extension pages hold
// the backend's host permission, so they call the backend directly. The
// content script loads it too, but never shared/lamiss-auth.js: there every
// call goes out without a token, so a content script is always signed out.

// Where the backend is: set at build time from LAMISS_API_URL (see
// scripts/build.js), which writes them to shared/lamiss-config.js. That file
// is loaded before this one everywhere.
declare const LAMISS_ENVIRONMENT: string;
declare const LAMISS_API_BASE_URL: string;
declare const LAMISS_WS_BASE_URL: string;

// Why the packaged backend address can't be used, or undefined when it can.
// scripts/build.js already refuses such a build; this keeps a hand-edited or
// broken lamiss-config.js from sending anything (the token included) to an
// insecure or malformed address. Outside development: https and wss only.
function lamissBackendConfigProblem(): string | undefined {
  let api: URL;
  let ws: URL;
  try {
    api = new URL(LAMISS_API_BASE_URL);
    ws = new URL(LAMISS_WS_BASE_URL);
  } catch {
    return 'the server address is not a valid URL';
  }
  if (!['http:', 'https:'].includes(api.protocol) || !['ws:', 'wss:'].includes(ws.protocol) || api.host !== ws.host) {
    return 'the REST and WebSocket addresses do not match';
  }
  if (LAMISS_ENVIRONMENT !== 'development' && (api.protocol !== 'https:' || ws.protocol !== 'wss:')) {
    return 'the server address is not secure (https/wss)';
  }
  return undefined;
}

// The failure every backend call returns when the address can't be used.
function lamissMisconfigured(): { ok: false; error: string; retryable: false; errorCode: string } | undefined {
  const problem = lamissBackendConfigProblem();
  if (!problem) {
    return undefined;
  }
  console.error(`Lamiss POC: not calling the backend: ${problem} (${LAMISS_ENVIRONMENT} build).`);
  return { ok: false, error: lamissT('common.misconfigured'), retryable: false, errorCode: 'misconfigured' };
}

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

type LamissSignInFailure = 'cancelled' | 'interaction_required' | 'state_mismatch' | 'nonce_mismatch' | 'not_configured' | 'rejected' | 'failed' | 'consent_required';

// --- Privacy notice (store/privacy-data-flow.md) ---------------------------------
// Sign-in needs the user to have accepted, on an extension page, the notice
// of what LAMISS sends where. Bump the version when that changes, and every
// user is asked again at their next sign-in.

const LAMISS_PRIVACY_POLICY_URL = 'https://danielfuzzy.github.io/lamiss-youtube-transcript-poc/privacy-policy.html';
const LAMISS_PRIVACY_NOTICE_KEY = 'lamissPrivacyNotice';
const LAMISS_PRIVACY_NOTICE_VERSION = 1;

async function hasAcceptedPrivacyNotice(): Promise<boolean> {
  try {
    const stored = await chrome.storage.local.get(LAMISS_PRIVACY_NOTICE_KEY);
    return (stored[LAMISS_PRIVACY_NOTICE_KEY] as { version?: number } | undefined)?.version === LAMISS_PRIVACY_NOTICE_VERSION;
  } catch {
    return false;
  }
}

function acceptPrivacyNotice(): Promise<void> {
  return chrome.storage.local.set({ [LAMISS_PRIVACY_NOTICE_KEY]: { version: LAMISS_PRIVACY_NOTICE_VERSION, acceptedAt: new Date().toISOString() } });
}

// Functions, not constants: they follow the app language at the time they are shown.
function lamissSignInRequiredMessage(): string {
  return lamissT('common.signInRequired');
}

function lamissSignInAgainMessage(): string {
  return lamissT('common.signInAgain');
}

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

function lamissUnreachableMessage(): string {
  return lamissT('common.unreachable', { url: LAMISS_API_BASE_URL });
}

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
    error: tokenSent ? lamissSignInAgainMessage() : lamissSignInRequiredMessage(),
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
  const misconfigured = lamissMisconfigured();
  if (misconfigured) {
    return misconfigured;
  }
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
    // 204 No Content (DELETE /api/me) has no body.
    return { ok: true, data: (response.status === 204 ? undefined : await response.json()) as T };
  } catch (error) {
    console.error('Lamiss POC: backend unreachable:', path, error);
    return { ok: false, error: lamissUnreachableMessage(), retryable: true };
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
  const misconfigured = lamissMisconfigured();
  if (misconfigured) {
    return misconfigured;
  }
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
    return { ok: false, error: lamissUnreachableMessage(), retryable: true };
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

// The languages the backend knows (its Language enum), as ISO 639-1 codes,
// with their English names. Shown in the app language (lamissLanguageName).
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

// The language's name in the app language, as it reads inside a sentence
// ("inglés" in Spanish); the English name where Intl can't name it.
function lamissLanguageName(code: string | null | undefined): string {
  const english = LAMISS_LANGUAGES.find(language => language.code === code)?.name ?? (code ?? '');
  if (!code || lamissAppLanguage === 'en') {
    return english;
  }
  try {
    return new Intl.DisplayNames([lamissAppLanguage], { type: 'language' }).of(code) ?? english;
  } catch {
    return english;
  }
}

// The same name as a list entry: capitalized ("Inglés").
function lamissLanguageLabel(code: string | null | undefined): string {
  const name = lamissLanguageName(code);
  return name.charAt(0).toLocaleUpperCase(lamissAppLanguage) + name.slice(1);
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
  // The language the tutor asks, explains and gives feedback in (TDR-0003);
  // null: the video's language. Never derived from the caption language.
  // Optional: a backend before TDR-0003 only knows tutor.explanationLanguage.
  tutorLanguage?: string | null;
  proficiencyLevel: LamissProficiencyLevel | null;
  // null: no goal.
  learningGoal?: LamissLearningGoal | null;
  // 5–240, or null: no daily goal.
  dailyGoalMinutes?: number | null;
  tutor: {
    kindness: LamissKindness;
    responseLength: LamissResponseLength;
    encouragement: boolean;
    // tutorLanguage's earlier name, still sent by the backend with the same
    // value. Read through lamissTutorLanguage; never sent back (savePreferences).
    explanationLanguage?: string | null;
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

// The tutor language, from either name the backend may use for it.
function lamissTutorLanguage(preferences: LamissPreferences): string | null {
  return preferences.tutorLanguage !== undefined ? preferences.tutorLanguage : preferences.tutor.explanationLanguage ?? null;
}

// Always the full object; the backend answers with what it saved. Only
// tutorLanguage is sent: a stale explanationLanguage left next to a cleared
// tutorLanguage would otherwise set it again.
function savePreferences(preferences: LamissPreferences): Promise<LamissCallResult<LamissPreferences>> {
  const { explanationLanguage: _legacy, ...tutor } = preferences.tutor;
  return callLamiss<LamissPreferences>('/api/me/preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ ...preferences, tutorLanguage: lamissTutorLanguage(preferences), tutor })
  });
}

function fetchVoices(): Promise<LamissCallResult<LamissVoiceList>> {
  return callLamiss<LamissVoiceList>('/api/speech/voices', { headers: { accept: 'application/json' } });
}

function fetchProfile(): Promise<LamissCallResult<LamissProfile>> {
  return callLamiss<LamissProfile>('/api/auth/me', { headers: { accept: 'application/json' } });
}

// --- Goals and profile editing (TDR-0002 addendum) ----------------------------------

const LAMISS_LEARNING_GOALS: ReadonlyArray<{ goal: LamissLearningGoal; label: () => string }> = [
  { goal: 'CONVERSATION', label: () => lamissT('goal.CONVERSATION') },
  { goal: 'VOCABULARY', label: () => lamissT('goal.VOCABULARY') },
  { goal: 'GRAMMAR', label: () => lamissT('goal.GRAMMAR') },
  { goal: 'LISTENING', label: () => lamissT('goal.LISTENING') },
  { goal: 'PRONUNCIATION', label: () => lamissT('goal.PRONUNCIATION') }
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
  return minutes ? lamissT('common.minutes', { minutes }) : lamissT('common.off');
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

// A zone the backend doesn't know (e.g. ICU's "Etc/Unknown" when the system
// zone can't be detected) falls back to UTC rather than hiding the progress.
async function fetchPracticeToday(timeZone: string = lamissLocalTimeZone()): Promise<LamissCallResult<LamissPracticeToday>> {
  const ask = (zone: string) => callLamiss<LamissPracticeToday>(`/api/me/practice/today?timeZone=${encodeURIComponent(zone)}`, {
    headers: { accept: 'application/json' }
  });
  const result = await ask(timeZone);
  if (!result.ok && result.errorCode === 'invalid_time_zone' && timeZone !== 'UTC') {
    return ask('UTC');
  }
  return result;
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
    text: lamissT('practice.progress', { practiced, goal }),
    fraction: Math.min(1, practiced / goal),
    done: practiced >= goal
  };
}

// Same rules as the backend's domain.Username (TDR-0002 decision 12).
const LAMISS_USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;
function lamissUsernameRules(): string {
  return lamissT('username.rules');
}

// Why a username can't be saved, or undefined when it can.
function usernameProblem(username: string): string | undefined {
  return LAMISS_USERNAME_PATTERN.test(username) ? undefined : lamissUsernameRules();
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
    return lamissT('username.taken');
  }
  if (result.errorCode === 'invalid_username') {
    return lamissUsernameRules();
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

// --- Recent videos (TDR-0004) ------------------------------------------------------

// GET /api/me/recent-videos. playback (where the video stopped) and
// learningProgress (questions answered) are separate measures: neither says
// the video was finished. Optional fields are null when unknown.
type LamissRecentVideo = {
  videoId: number;
  platform: string | null;
  externalVideoId: string | null;
  title: string | null;
  thumbnailUrl: string | null;
  videoUrl: string | null;
  durationSeconds: number | null;
  lastStudiedAt: string;
  playback: { lastPositionMs: number } | null;
  learningProgress: { questionsAnswered: number };
};

const LAMISS_RECENT_VIDEOS_LIMIT = 20;

function fetchRecentVideos(limit = LAMISS_RECENT_VIDEOS_LIMIT): Promise<LamissCallResult<{ videos: LamissRecentVideo[] }>> {
  return callLamiss<{ videos: LamissRecentVideo[] }>(`/api/me/recent-videos?limit=${limit}`, { headers: { accept: 'application/json' } });
}

// Where to resume: the YouTube watch page at the saved position, or undefined
// when the video has no YouTube address. Nothing but youtube.com/watch is opened.
function lamissResumeUrl(video: LamissRecentVideo): string | undefined {
  if (!video.videoUrl) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(video.videoUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'www.youtube.com' || url.pathname !== '/watch' || !url.searchParams.get('v')) {
    return undefined;
  }
  const seconds = Math.floor((video.playback?.lastPositionMs ?? 0) / 1000);
  if (seconds > 0) {
    url.searchParams.set('t', `${seconds}s`);
  }
  return url.toString();
}

// "3:05", or "1:02:03" past an hour.
function formatLamissDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

// "2 hours ago", "yesterday"… in the app language.
function formatLamissRelativeTime(iso: string, now: number = Date.now()): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) {
    return '';
  }
  const seconds = Math.round((time - now) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000], ['month', 2_592_000], ['week', 604_800], ['day', 86_400], ['hour', 3600], ['minute', 60]
  ];
  const format = new Intl.RelativeTimeFormat(lamissAppLanguage, { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return format.format(Math.round(seconds / size), unit);
    }
  }
  return format.format(0, 'second');
}

// --- Account (TDR-0005) ---------------------------------------------------------------

// Permanently deletes the signed-in user's account and its data.
function deleteAccount(): Promise<LamissCallResult<void>> {
  return callLamiss<void>('/api/me', { method: 'DELETE' });
}
