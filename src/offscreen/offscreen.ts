// Hidden extension page that records spoken answers to Lamiss's questions and
// plays Lamiss's voice. It runs on the extension's origin, which holds the
// microphone permission (granted once from permission.html), and it can call
// the backend directly. Voice activity detection decides when the user starts
// and stops talking.
//
// It has no storage access, so the worker sends the Lamiss access token with
// each listen and speak request; it is kept only for that request. The worker
// also sends the devices picked in the popup (micDeviceId with listen,
// speakerDeviceId and volume with speak); a missing device means the default.

const LISTEN_SAMPLE_MS = 50;
const LISTEN_CALIBRATION_MS = 300;
// The user has this long to start talking before Lamiss stops listening.
const LISTEN_NO_SPEECH_TIMEOUT_MS = 5000;
// Speech must last this long to count, so a click or a cough doesn't.
const LISTEN_SPEECH_START_MS = 200;
// This much silence after speech ends the answer.
const LISTEN_END_SILENCE_MS = 1800;
const LISTEN_MAX_ANSWER_MS = 60_000;
const LISTEN_MIN_SPEECH_LEVEL = 0.015;

type ListenSession = {
  requestId: string;
  stream: MediaStream;
  audioContext: AudioContext;
  recorder: MediaRecorder;
  chunks: Blob[];
  timer?: number;
  discard: boolean;
  accessToken?: string;
};

let listenSession: ListenSession | null = null;

// A 401 here: the worker checks the session and tells everyone if it's gone.
// The rejected token goes along, so a stale one can't end a newer session.
lamissOnSessionRejected = async (rejectedToken) => {
  await chrome.runtime.sendMessage({ type: LAMISS_SESSION_REJECTED_MESSAGE, rejectedToken }).catch(() => undefined);
};

function emitListenEvent(requestId: string, event: LamissListenEvent): void {
  void chrome.runtime.sendMessage({ source: 'lamiss-offscreen', requestId, event });
}

function audioLevel(analyser: AnalyserNode, samples: Float32Array): number {
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

async function startListening(requestId: string, accessToken: string | undefined, micDeviceId: string | undefined): Promise<void> {
  stopListening(true);

  let stream: MediaStream;
  try {
    stream = await getMicrophoneStream(micDeviceId, { echoCancellation: true, noiseSuppression: true });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    emitListenEvent(requestId, {
      type: 'failed',
      micDenied: name === 'NotAllowedError' || name === 'SecurityError',
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  const audioContext = new AudioContext();
  await audioContext.resume().catch(() => undefined);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  audioContext.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);

  const mimeType = pickRecordingMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const session: ListenSession = { requestId, stream, audioContext, recorder, chunks: [], discard: false, accessToken };
  listenSession = session;

  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size > 0) {
      session.chunks.push(event.data);
    }
  });
  recorder.addEventListener('stop', () => void finishListening(session));
  recorder.start(250);
  emitListenEvent(requestId, { type: 'listening', noSpeechTimeoutMs: LISTEN_NO_SPEECH_TIMEOUT_MS });

  if (audioContext.state !== 'running') {
    // Without audio analysis there's no way to tell speech from silence:
    // record until the user stops it, or the time limit.
    console.warn('Lamiss POC: audio analysis unavailable, state =', audioContext.state);
    emitListenEvent(requestId, { type: 'speech-started' });
    session.timer = window.setTimeout(() => stopListening(false), LISTEN_MAX_ANSWER_MS);
    return;
  }

  const startedAt = Date.now();
  let noiseTotal = 0;
  let noiseSamples = 0;
  let threshold = LISTEN_MIN_SPEECH_LEVEL;
  let loudSince = 0;
  let speechStartedAt = 0;
  let lastSpeechAt = 0;

  const tick = () => {
    if (listenSession !== session) {
      return;
    }
    const now = Date.now();
    const level = audioLevel(analyser, samples);

    if (now - startedAt < LISTEN_CALIBRATION_MS) {
      noiseTotal += level;
      noiseSamples += 1;
      threshold = Math.max(LISTEN_MIN_SPEECH_LEVEL, (noiseTotal / noiseSamples) * 2.5);
    } else if (!speechStartedAt) {
      if (level > threshold) {
        loudSince ||= now;
        if (now - loudSince >= LISTEN_SPEECH_START_MS) {
          speechStartedAt = now;
          lastSpeechAt = now;
          emitListenEvent(requestId, { type: 'speech-started' });
        }
      } else {
        loudSince = 0;
        if (now - startedAt >= LISTEN_NO_SPEECH_TIMEOUT_MS) {
          stopListening(true);
          emitListenEvent(requestId, { type: 'no-speech' });
          return;
        }
      }
    } else {
      if (level > threshold * 0.7) {
        lastSpeechAt = now;
      }
      if (now - lastSpeechAt >= LISTEN_END_SILENCE_MS || now - speechStartedAt >= LISTEN_MAX_ANSWER_MS) {
        stopListening(false);
        return;
      }
    }
    session.timer = window.setTimeout(tick, LISTEN_SAMPLE_MS);
  };
  tick();
}

function stopListening(discard: boolean): void {
  const session = listenSession;
  if (!session) {
    return;
  }
  listenSession = null;
  session.discard = discard;
  window.clearTimeout(session.timer);
  if (session.recorder.state !== 'inactive') {
    session.recorder.stop();
  }
  session.stream.getTracks().forEach(track => track.stop());
  void session.audioContext.close();
}

async function finishListening(session: ListenSession): Promise<void> {
  if (session.discard) {
    return;
  }
  const audio = new Blob(session.chunks, { type: (session.recorder.mimeType || 'audio/webm').split(';')[0] });
  if (audio.size === 0) {
    emitListenEvent(session.requestId, { type: 'no-speech' });
    return;
  }

  emitListenEvent(session.requestId, { type: 'transcribing' });
  const result = await transcribeSpeech(audio, session.accessToken ?? '');
  if (result.ok && result.data.text?.trim()) {
    emitListenEvent(session.requestId, { type: 'transcribed', text: result.data.text.trim(), language: result.data.language ?? undefined });
  } else if (!result.ok && result.status === 422) {
    emitListenEvent(session.requestId, { type: 'no-speech' });
  } else {
    emitListenEvent(session.requestId, { type: 'failed', error: result.ok ? 'Empty transcription' : result.error });
  }
}

// --- Lamiss's voice --------------------------------------------------------------

let speaking: { requestId: string; audio: HTMLAudioElement; url: string } | null = null;

function emitSpeechEvent(requestId: string, speech: LamissSpeechEvent): void {
  void chrome.runtime.sendMessage({ source: 'lamiss-offscreen', requestId, speech });
}

function stopSpeaking(): void {
  if (speaking) {
    speaking.audio.pause();
    URL.revokeObjectURL(speaking.url);
    speaking = null;
  }
}

type SpeakOutput = { speakerDeviceId?: string; volume?: number };

async function speak(requestId: string, text: string, language: string | undefined, accessToken: string | undefined, output: SpeakOutput = {}): Promise<void> {
  stopSpeaking();
  const result = await synthesizeSpeech(text, language, accessToken ?? '');
  if (!result.ok) {
    emitSpeechEvent(requestId, { type: 'failed', error: result.error });
    return;
  }

  const url = URL.createObjectURL(result.data);
  const audio = new Audio(url);
  audio.volume = clampVolume(output.volume);
  speaking = { requestId, audio, url };
  const finish = (event: LamissSpeechEvent) => {
    if (speaking?.requestId === requestId) {
      stopSpeaking();
    }
    emitSpeechEvent(requestId, event);
  };
  audio.addEventListener('ended', () => finish({ type: 'ended' }));
  audio.addEventListener('error', () => finish({ type: 'failed', error: 'The audio could not be played' }));
  try {
    await routeAudioToSpeaker(audio, output.speakerDeviceId);
    if (speaking?.requestId !== requestId) {
      // Stopped while the speaker was being switched.
      return;
    }
    await audio.play();
    emitSpeechEvent(requestId, { type: 'started' });
  } catch (error) {
    finish({ type: 'failed', error: error instanceof Error ? error.message : String(error) });
  }
}

type OffscreenCommand = {
  target?: string;
  type?: string;
  requestId?: string;
  discard?: boolean;
  text?: string;
  language?: string;
  accessToken?: unknown;
  micDeviceId?: unknown;
  speakerDeviceId?: unknown;
  volume?: unknown;
};

const optionalString = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;

chrome.runtime.onMessage.addListener((message: OffscreenCommand, sender) => {
  if (message?.target !== 'lamiss-offscreen' || !isFromExtensionPage(sender)) {
    return false;
  }
  const accessToken = typeof message.accessToken === 'string' ? message.accessToken : undefined;
  if (message.type === 'speak' && typeof message.requestId === 'string' && typeof message.text === 'string') {
    void speak(message.requestId, message.text, message.language, accessToken, {
      speakerDeviceId: optionalString(message.speakerDeviceId),
      volume: typeof message.volume === 'number' ? message.volume : undefined
    });
    return false;
  }
  if (message.type === 'stop-speaking') {
    if (speaking?.requestId === message.requestId) {
      stopSpeaking();
    }
    return false;
  }
  if (message.type === 'listen' && typeof message.requestId === 'string') {
    void startListening(message.requestId, accessToken, optionalString(message.micDeviceId));
  } else if (message.type === 'stop-listening' && listenSession?.requestId === message.requestId) {
    stopListening(message.discard === true);
  }
  return false;
});
