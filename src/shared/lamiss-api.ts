// Lamiss backend calls shared by the extension pages (popup and in-page chat).
// Loaded as a plain script before each page's own script; extension pages hold
// the backend's host permission, so they call the backend directly.

// Where the backend is: set at build time from LAMISS_API_URL (see
// scripts/build.js), which writes them to shared/lamiss-config.js. That file
// is loaded before this one everywhere.
declare const LAMISS_API_BASE_URL: string;
declare const LAMISS_WS_BASE_URL: string;

// There are no accounts yet: the backend hardcodes this local mock user too.
const LAMISS_USER_ID = 1001;

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

const LAMISS_UNREACHABLE_MESSAGE = `Could not reach Lamiss at ${LAMISS_API_BASE_URL}. Check your connection and try again.`;

type LamissCallResult<T> =
  | { ok: true; data: T }
  | { ok: false; status?: number; error: string; retryable: boolean };

type LamissQuestion = {
  // Generated once per question and reused on retries, so a retry gets the
  // stored answer instead of asking the AI again.
  interactionId: string;
  learningSessionId: number;
  videoPositionMs: number;
} & ({ text: string } | { audio: Blob });

async function callLamiss<T>(path: string, init: RequestInit): Promise<LamissCallResult<T>> {
  try {
    const response = await fetch(`${LAMISS_API_BASE_URL}${path}`, init);
    if (!response.ok) {
      // Errors are RFC 9457 problem details with a "retryable" flag.
      const problem = await response.json().catch(() => undefined) as { detail?: string; retryable?: boolean } | undefined;
      console.error('Lamiss POC: backend call failed:', path, response.status, problem);
      return {
        ok: false,
        status: response.status,
        error: problem?.detail ?? `HTTP ${response.status}`,
        retryable: problem?.retryable ?? response.status >= 500
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

// Resumes the (hardcoded, local) user's open session on the video, or starts one.
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
function transcribeSpeech(audio: Blob): Promise<LamissCallResult<{ text?: string; language?: string | null }>> {
  const form = new FormData();
  const extension = audio.type === 'audio/ogg' ? 'ogg' : 'webm';
  form.append('audio', audio, `answer.${extension}`);
  return callLamiss<{ text?: string; language?: string | null }>('/api/speech/transcriptions', {
    method: 'POST',
    headers: { accept: 'application/json' },
    body: form
  });
}

// Lamiss's own voice (a kind teacher), as MP3 audio. language (ISO 639-1)
// picks the voice when the backend uses Kokoro, whose voices speak one language each.
async function synthesizeSpeech(text: string, language?: string): Promise<LamissCallResult<Blob>> {
  try {
    const response = await fetch(`${LAMISS_API_BASE_URL}/api/speech/synthesis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify(language ? { text, language } : { text })
    });
    if (!response.ok) {
      const problem = await response.json().catch(() => undefined) as { detail?: string; retryable?: boolean } | undefined;
      return { ok: false, status: response.status, error: problem?.detail ?? `HTTP ${response.status}`, retryable: problem?.retryable ?? response.status >= 500 };
    }
    return { ok: true, data: await response.blob() };
  } catch {
    return { ok: false, error: LAMISS_UNREACHABLE_MESSAGE, retryable: true };
  }
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

async function openMicrophone(): Promise<MediaStream | null> {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true });
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
