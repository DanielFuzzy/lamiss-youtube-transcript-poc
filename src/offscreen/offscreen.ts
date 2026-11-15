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
// The user has this long to start talking before Lamiss stops listening.
const LISTEN_NO_SPEECH_TIMEOUT_MS = 8000;
// Speech must last this long to count, so a click or a cough doesn't; dips
// between syllables up to LISTEN_SPEECH_GAP_MS don't restart the count.
const LISTEN_SPEECH_START_MS = 200;
const LISTEN_SPEECH_GAP_MS = 100;
// This much silence after speech ends the answer.
const LISTEN_END_SILENCE_MS = 1800;
const LISTEN_MAX_ANSWER_MS = 60_000;
const LISTEN_MIN_SPEECH_LEVEL = 0.015;
// Background noise is the 10th percentile of the levels of the last
// LISTEN_NOISE_WINDOW_MS (Lamiss#87): speech has pauses between words, so
// speech that starts at once can't pass itself off as noise, as it could
// when the first 300 ms were averaged. Speech counts above 2.5× that.
const LISTEN_NOISE_WINDOW_MS = 2500;
const LISTEN_NOISE_PERCENTILE = 0.1;
const LISTEN_SPEECH_OVER_NOISE = 2.5;
// Until LISTEN_NOISE_MIN_HISTORY_MS of levels exist, only a clearly spoken
// level counts as speech, so an answer that starts immediately is caught.
const LISTEN_NOISE_MIN_HISTORY_MS = 500;
const LISTEN_EARLY_SPEECH_LEVEL = 0.05;
// The microphone stays open this long after an attempt, so a retry starts at
// once, with the background noise already known.
const LISTEN_MIC_IDLE_MS = 15_000;

type LevelSample = { at: number; level: number };

// The background noise level: the LISTEN_NOISE_PERCENTILE of the levels of the
// last LISTEN_NOISE_WINDOW_MS, or undefined until LISTEN_NOISE_MIN_HISTORY_MS of them exist.
function lamissNoiseFloor(history: LevelSample[], now: number): number | undefined {
  const recent = history.filter(sample => now - sample.at <= LISTEN_NOISE_WINDOW_MS);
  if (recent.length === 0 || now - recent[0].at < LISTEN_NOISE_MIN_HISTORY_MS) {
    return undefined;
  }
  const levels = recent.map(sample => sample.level).sort((a, b) => a - b);
  return levels[Math.floor(LISTEN_NOISE_PERCENTILE * (levels.length - 1))];
}

type SpeechDecision = 'waiting' | 'speech-started' | 'speaking' | 'speech-ended' | 'no-speech';

// Decides, from a level sampled every LISTEN_SAMPLE_MS, when speech starts and
// ends. history: the microphone's recent levels, newest last, including the
// one being fed; it may reach back before this attempt (a warm microphone).
class SpeechDetector {
  threshold = LISTEN_EARLY_SPEECH_LEVEL;
  floor: number | undefined;
  peak = 0;
  private loudSince: number | undefined;
  private lastLoudAt = 0;
  private speechStartedAt: number | undefined;
  private lastSpeechAt = 0;

  constructor(private readonly history: LevelSample[], private readonly startedAt: number) {}

  feed(level: number, now: number): SpeechDecision {
    this.peak = Math.max(this.peak, level);
    if (this.speechStartedAt === undefined) {
      this.floor = lamissNoiseFloor(this.history, now);
      this.threshold = this.floor === undefined
        ? LISTEN_EARLY_SPEECH_LEVEL
        : Math.max(LISTEN_MIN_SPEECH_LEVEL, this.floor * LISTEN_SPEECH_OVER_NOISE);
      if (level > this.threshold) {
        this.loudSince ??= now;
        this.lastLoudAt = now;
        if (now - this.loudSince >= LISTEN_SPEECH_START_MS) {
          this.speechStartedAt = now;
          this.lastSpeechAt = now;
          return 'speech-started';
        }
        return 'waiting';
      }
      if (this.loudSince !== undefined && now - this.lastLoudAt > LISTEN_SPEECH_GAP_MS) {
        this.loudSince = undefined;
      }
      return this.loudSince === undefined && now - this.startedAt >= LISTEN_NO_SPEECH_TIMEOUT_MS ? 'no-speech' : 'waiting';
    }
    // The threshold stays as it was when speech started: the window now holds
    // speech, which would raise it and cut the answer short.
    if (level > this.threshold * 0.7) {
      this.lastSpeechAt = now;
    }
    if (now - this.lastSpeechAt >= LISTEN_END_SILENCE_MS || now - this.speechStartedAt >= LISTEN_MAX_ANSWER_MS) {
      return 'speech-ended';
    }
    return 'speaking';
  }
}

// The open microphone: sampled every LISTEN_SAMPLE_MS while open, kept
// LISTEN_MIC_IDLE_MS after an attempt.
type Microphone = {
  deviceId: string | undefined;
  stream: MediaStream;
  audioContext: AudioContext;
  analyser: AnalyserNode;
  samples: Float32Array;
  history: LevelSample[];
  sampler?: number;
  idleTimer?: number;
};

type ListenSession = {
  requestId: string;
  microphone: Microphone;
  recorder: MediaRecorder;
  chunks: Blob[];
  detector?: SpeechDetector;
  startedAt: number;
  micReadyMs: number;
  timer?: number;
  discard: boolean;
  outcome?: string;
  accessToken?: string;
};

let microphone: Microphone | null = null;
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

// The microphone that was asked for: the warm one if it is the same device
// and still live, otherwise a newly opened one.
async function acquireMicrophone(deviceId: string | undefined): Promise<Microphone> {
  if (microphone && microphone.deviceId === deviceId && microphone.stream.getTracks().every(track => track.readyState !== 'ended')) {
    window.clearTimeout(microphone.idleTimer);
    return microphone;
  }
  releaseMicrophone();
  const stream = await getMicrophoneStream(deviceId, { echoCancellation: true, noiseSuppression: true });
  const audioContext = new AudioContext();
  await audioContext.resume().catch(() => undefined);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  audioContext.createMediaStreamSource(stream).connect(analyser);
  const opened: Microphone = { deviceId, stream, audioContext, analyser, samples: new Float32Array(analyser.fftSize), history: [] };
  if (audioContext.state === 'running') {
    opened.sampler = window.setInterval(() => sampleMicrophone(opened), LISTEN_SAMPLE_MS);
  }
  microphone = opened;
  return opened;
}

function releaseMicrophone(): void {
  const open = microphone;
  if (!open) {
    return;
  }
  microphone = null;
  window.clearInterval(open.sampler);
  window.clearTimeout(open.idleTimer);
  open.stream.getTracks().forEach(track => track.stop());
  void open.audioContext.close();
}

function sampleMicrophone(open: Microphone): void {
  if (microphone !== open) {
    return;
  }
  const now = Date.now();
  const level = audioLevel(open.analyser, open.samples);
  open.history.push({ at: now, level });
  while (open.history.length > 0 && now - open.history[0].at > LISTEN_NOISE_WINDOW_MS) {
    open.history.shift();
  }
  const session = listenSession;
  if (!session?.detector || session.microphone !== open) {
    return;
  }
  switch (session.detector.feed(level, now)) {
    case 'speech-started':
      emitListenEvent(session.requestId, { type: 'speech-started' });
      break;
    case 'no-speech':
      session.outcome = 'no speech';
      stopListening(true);
      emitListenEvent(session.requestId, { type: 'no-speech' });
      break;
    case 'speech-ended':
      session.outcome = 'speech ended';
      stopListening(false);
      break;
  }
}

async function startListening(requestId: string, accessToken: string | undefined, micDeviceId: string | undefined): Promise<void> {
  stopListening(true);

  const startedAt = Date.now();
  let open: Microphone;
  try {
    open = await acquireMicrophone(micDeviceId);
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    emitListenEvent(requestId, {
      type: 'failed',
      micDenied: name === 'NotAllowedError' || name === 'SecurityError',
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  const mimeType = pickRecordingMimeType();
  const recorder = new MediaRecorder(open.stream, mimeType ? { mimeType } : undefined);
  const session: ListenSession = {
    requestId, microphone: open, recorder, chunks: [], startedAt: Date.now(), micReadyMs: Date.now() - startedAt, discard: false, accessToken
  };
  listenSession = session;

  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size > 0) {
      session.chunks.push(event.data);
    }
  });
  recorder.addEventListener('stop', () => void finishListening(session));
  recorder.start(250);
  emitListenEvent(requestId, { type: 'listening', noSpeechTimeoutMs: LISTEN_NO_SPEECH_TIMEOUT_MS });

  if (open.sampler === undefined) {
    // Without audio analysis there's no way to tell speech from silence:
    // record until the user stops it, or the time limit.
    console.warn('Lamiss POC: audio analysis unavailable, state =', open.audioContext.state);
    emitListenEvent(requestId, { type: 'speech-started' });
    session.timer = window.setTimeout(() => stopListening(false), LISTEN_MAX_ANSWER_MS);
    return;
  }
  session.detector = new SpeechDetector(open.history, session.startedAt);
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
  logListenAttempt(session, discard);
  // Kept warm for a retry, then released.
  const open = session.microphone;
  window.clearTimeout(open.idleTimer);
  open.idleTimer = window.setTimeout(() => {
    if (microphone === open && !listenSession) {
      releaseMicrophone();
    }
  }, LISTEN_MIC_IDLE_MS);
}

// One line per attempt (Lamiss#87): levels only, never audio or text.
function logListenAttempt(session: ListenSession, discard: boolean): void {
  const detector = session.detector;
  const round = (value: number | undefined) => value === undefined ? 'n/a' : value.toFixed(3);
  console.log('Lamiss POC: listen attempt =', JSON.stringify({
    outcome: session.outcome ?? (discard ? 'cancelled' : 'stopped'),
    micReadyMs: session.micReadyMs,
    listenedMs: Date.now() - session.startedAt,
    noiseFloor: round(detector?.floor),
    threshold: round(detector?.threshold),
    peak: round(detector?.peak)
  }));
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
    wakeQuietUntil = Date.now() + WAKE_QUIET_AFTER_SPEECH_MS;
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

// --- "Hey Lamiss" (Lamiss#85) -----------------------------------------------------

// After a detection, none for this long; nor while Lamiss speaks and this
// long after, nor while she listens for an answer or a question: her voice
// and the learner's answer must not trigger it.
const WAKE_COOLDOWN_MS = 3000;
const WAKE_QUIET_AFTER_SPEECH_MS = 1000;

type WakeListener = {
  stream: MediaStream;
  audioContext: AudioContext;
  pipeline: WakeWordPipeline;
  config: LamissWakeWordConfig;
  // Chunks are scored one after the other.
  queue: Promise<void>;
  lastDetectedAt: number;
};

let wakeListener: WakeListener | null = null;
let wakeStarting = false;
let wakeQuietUntil = 0;
let wakePipeline: Promise<{ pipeline: WakeWordPipeline; config: LamissWakeWordConfig }> | undefined;

// Whether a score is a detection: at or above the model's threshold, and
// not while detections are held back.
function lamissWakeDetected(score: number, threshold: number, now: number, lastDetectedAt: number, quietUntil: number, busy: boolean): boolean {
  return score >= threshold && !busy && now >= quietUntil && now - lastDetectedAt >= WAKE_COOLDOWN_MS;
}

function emitWakeEvent(event: { type: 'detected' } | { type: 'failed'; error: string; micDenied?: boolean }): void {
  void chrome.runtime.sendMessage({ source: 'lamiss-offscreen', wake: event });
}

// onnxruntime-web, loaded the first time the wake word is turned on: its
// WebAssembly is large and only builds with a wake word model ship it.
function loadOnnxRuntime(): Promise<WakeOrt> {
  const scope = globalThis as unknown as { ort?: WakeOrt & { env: { wasm: { numThreads: number; wasmPaths: string } } } };
  const configure = () => {
    const runtime = scope.ort!;
    // Extension pages aren't cross-origin isolated: no threads.
    runtime.env.wasm.numThreads = 1;
    runtime.env.wasm.wasmPaths = chrome.runtime.getURL('vendor/onnxruntime/');
    return runtime;
  };
  if (scope.ort) {
    return Promise.resolve(configure());
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('vendor/onnxruntime/ort.wasm.min.js');
    script.addEventListener('load', () => resolve(configure()));
    script.addEventListener('error', () => reject(new Error('onnxruntime-web is missing from this build')));
    document.head.append(script);
  });
}

async function loadWakeModel(file: string): Promise<Uint8Array> {
  const response = await fetch(chrome.runtime.getURL(`wakeword/${file}`));
  if (!response.ok) {
    throw new Error(`wake word model ${file} is missing from this build`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function createWakePipeline(): Promise<{ pipeline: WakeWordPipeline; config: LamissWakeWordConfig }> {
  wakePipeline ??= (async () => {
    const config = await readWakeWordConfig();
    if (!config) {
      throw new Error('this build has no wake word model');
    }
    const [runtime, melspectrogram, embedding, wakeWord] = await Promise.all([
      loadOnnxRuntime(), loadWakeModel('melspectrogram.onnx'), loadWakeModel('embedding_model.onnx'), loadWakeModel(config.model)
    ]);
    return { pipeline: await WakeWordPipeline.create(runtime, { melspectrogram, embedding, wakeWord }), config };
  })().catch((error: unknown) => {
    wakePipeline = undefined;
    throw error;
  });
  return wakePipeline;
}

async function startWakeListening(micDeviceId: string | undefined): Promise<void> {
  if (wakeListener || wakeStarting) {
    return;
  }
  wakeStarting = true;
  try {
    const { pipeline, config } = await createWakePipeline();
    const stream = await getMicrophoneStream(micDeviceId, { echoCancellation: true, noiseSuppression: true });
    if (!wakeStarting) {
      // Turned off while starting.
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    const audioContext = new AudioContext({ sampleRate: WAKE_SAMPLE_RATE });
    await audioContext.audioWorklet.addModule(chrome.runtime.getURL('offscreen/wake-worklet.js'));
    const node = new AudioWorkletNode(audioContext, 'lamiss-wake-capture');
    audioContext.createMediaStreamSource(stream).connect(node);
    const listener: WakeListener = { stream, audioContext, pipeline, config, queue: Promise.resolve(), lastDetectedAt: 0 };
    wakeListener = listener;
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      // Web Audio's [-1, 1] floats, as the int16 values openWakeWord expects.
      const samples = Float32Array.from(event.data, sample => sample * 32767);
      listener.queue = listener.queue.then(async () => {
        if (wakeListener !== listener) {
          return;
        }
        const score = await listener.pipeline.process(samples);
        const now = Date.now();
        if (score !== undefined && lamissWakeDetected(score, listener.config.threshold, now, listener.lastDetectedAt, wakeQuietUntil, speaking !== null || listenSession !== null)) {
          listener.lastDetectedAt = now;
          console.log('Lamiss POC: wake word detected, score =', score.toFixed(3));
          emitWakeEvent({ type: 'detected' });
        }
      }).catch((error: unknown) => console.warn('Lamiss POC: wake word scoring failed:', error));
    };
    await audioContext.resume().catch(() => undefined);
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    console.warn('Lamiss POC: wake word listening failed:', error);
    emitWakeEvent({
      type: 'failed',
      error: error instanceof Error ? error.message : String(error),
      micDenied: name === 'NotAllowedError' || name === 'SecurityError'
    });
  } finally {
    wakeStarting = false;
  }
}

function stopWakeListening(): void {
  wakeStarting = false;
  const listener = wakeListener;
  if (!listener) {
    return;
  }
  wakeListener = null;
  listener.stream.getTracks().forEach(track => track.stop());
  void listener.audioContext.close();
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
  if (message.type === 'wake-start') {
    void startWakeListening(optionalString(message.micDeviceId));
    return false;
  }
  if (message.type === 'wake-stop') {
    stopWakeListening();
    return false;
  }
  if (message.type === 'listen' && typeof message.requestId === 'string') {
    void startListening(message.requestId, accessToken, optionalString(message.micDeviceId));
  } else if (message.type === 'stop-listening' && listenSession?.requestId === message.requestId) {
    stopListening(message.discard === true);
  }
  return false;
});
