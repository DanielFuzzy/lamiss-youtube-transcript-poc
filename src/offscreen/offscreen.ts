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
