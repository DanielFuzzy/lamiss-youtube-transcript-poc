// The offscreen document only takes commands from the worker and extension
// pages, never from content scripts (which share the extension ID).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createExtensionEnv, senders, EXTENSION_ID, API_BASE_URL } = require('./helpers/extension-env');

const worker = { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/background.js` };

async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

function offscreenEnv() {
  // Synthesis answers 401, so speak() stops before it needs an <audio> element.
  return createExtensionEnv({
    scripts: ['shared/lamiss-config.js', 'shared/lamiss-i18n.js', 'shared/lamiss-api.js', 'offscreen/offscreen.js'],
    withoutSessionStorage: true,
    responder: async () => ({ status: 401, json: { detail: 'Unauthenticated' } })
  });
}

const speak = { target: 'lamiss-offscreen', type: 'speak', requestId: 'r-1', text: 'Hola', language: 'es', accessToken: 'worker-token' };

test('the offscreen document ignores commands from content scripts and other senders', async () => {
  const env = offscreenEnv();
  for (const sender of [senders.contentScript, senders.chat, senders.otherExtension, senders.otherExtensionContentScript, senders.otherSite]) {
    await env.dispatchMessage(speak, sender);
  }
  await flush();
  assert.equal(env.fetchCalls.length, 0);
  assert.equal(env.runtimeSent.length, 0);
});

test('the offscreen document speaks for the worker with the token it was sent', async () => {
  const env = offscreenEnv();
  await env.dispatchMessage(speak, worker);
  await flush();
  assert.equal(env.fetchCalls.length, 1);
  assert.equal(env.fetchCalls[0].url, `${API_BASE_URL}/api/speech/synthesis`);
  assert.equal(env.fetchCalls[0].headers.get('authorization'), 'Bearer worker-token');
  // The 401 goes to the worker with the token it was for.
  assert.deepEqual(env.runtimeSent, [
    { type: 'lamiss:session-rejected', rejectedToken: 'worker-token' },
    { source: 'lamiss-offscreen', requestId: 'r-1', speech: { type: 'failed', error: 'Please sign in again.' } }
  ]);
});

// getUserMedia stub: records each request and answers with results in order.
function fakeMediaDevices(results) {
  const requests = [];
  return {
    requests,
    mediaDevices: {
      async getUserMedia(constraints) {
        requests.push(JSON.parse(JSON.stringify(constraints)));
        const next = results.shift();
        if (next instanceof Error) {
          throw next;
        }
        return next;
      }
    }
  };
}

function domError(name) {
  return new DOMException(name, name);
}

test('listen records with the chosen microphone, and falls back to the default when it is gone', async () => {
  // The fallback is refused too, so listening stops before it needs audio analysis.
  const media = fakeMediaDevices([domError('OverconstrainedError'), domError('NotAllowedError')]);
  const env = createExtensionEnv({
    scripts: ['shared/lamiss-config.js', 'shared/lamiss-i18n.js', 'shared/lamiss-api.js', 'offscreen/offscreen.js'],
    withoutSessionStorage: true,
    globals: { navigator: { mediaDevices: media.mediaDevices } }
  });
  await env.dispatchMessage({ target: 'lamiss-offscreen', type: 'listen', requestId: 'r-1', accessToken: 't', micDeviceId: 'mic-2' }, worker);
  await flush();

  assert.deepEqual(media.requests, [
    { audio: { echoCancellation: true, noiseSuppression: true, deviceId: { exact: 'mic-2' } } },
    { audio: { echoCancellation: true, noiseSuppression: true } }
  ]);
  assert.equal(env.runtimeSent.length, 1);
  assert.equal(env.runtimeSent[0].event.type, 'failed');
  assert.equal(env.runtimeSent[0].event.micDenied, true);
});

test('listen without a chosen microphone uses the default one directly', async () => {
  const media = fakeMediaDevices([domError('NotAllowedError')]);
  const env = createExtensionEnv({
    scripts: ['shared/lamiss-config.js', 'shared/lamiss-i18n.js', 'shared/lamiss-api.js', 'offscreen/offscreen.js'],
    withoutSessionStorage: true,
    globals: { navigator: { mediaDevices: media.mediaDevices } }
  });
  await env.dispatchMessage({ target: 'lamiss-offscreen', type: 'listen', requestId: 'r-1', accessToken: 't' }, worker);
  await flush();
  assert.deepEqual(media.requests, [{ audio: { echoCancellation: true, noiseSuppression: true } }]);
});

// An <audio> stand-in that records what the offscreen document did with it.
function fakeAudioClass(played, sinkResults = []) {
  return class FakeAudio {
    constructor(url) {
      this.url = url;
      this.volume = 1;
      this.sinks = [];
      this.listeners = {};
      played.push(this);
    }
    async setSinkId(id) {
      this.sinks.push(id);
      const next = sinkResults.shift();
      if (next instanceof Error) {
        throw next;
      }
    }
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    }
    async play() {
      this.playing = true;
    }
    pause() {
      this.playing = false;
    }
  };
}

function speakingEnv(played, sinkResults) {
  const Audio = fakeAudioClass(played, sinkResults);
  return createExtensionEnv({
    scripts: ['shared/lamiss-config.js', 'shared/lamiss-i18n.js', 'shared/lamiss-api.js', 'offscreen/offscreen.js'],
    withoutSessionStorage: true,
    responder: async () => ({ body: 'mp3-bytes' }),
    // setSinkId support is detected on the prototype.
    globals: { Audio, HTMLMediaElement: Audio }
  });
}

test('speak plays on the chosen speaker at the chosen volume', async () => {
  const played = [];
  const env = speakingEnv(played);
  await env.dispatchMessage({ ...speak, speakerDeviceId: 'speaker-3', volume: 0.4 }, worker);
  await flush();
  assert.equal(played.length, 1);
  assert.deepEqual(played[0].sinks, ['speaker-3']);
  assert.equal(played[0].volume, 0.4);
  assert.equal(played[0].playing, true);
  assert.deepEqual(env.runtimeSent, [{ source: 'lamiss-offscreen', requestId: 'r-1', speech: { type: 'started' } }]);
});

test('speak falls back to the default speaker when the chosen one fails, and clamps the volume', async () => {
  const played = [];
  const env = speakingEnv(played, [domError('NotFoundError')]);
  await env.dispatchMessage({ ...speak, speakerDeviceId: 'unplugged', volume: 7 }, worker);
  await flush();
  assert.deepEqual(played[0].sinks, ['unplugged', '']);
  assert.equal(played[0].volume, 1);
  assert.equal(played[0].playing, true);
});

test('speak without device settings keeps the default speaker and full volume', async () => {
  const played = [];
  const env = speakingEnv(played);
  await env.dispatchMessage(speak, worker);
  await flush();
  assert.deepEqual(played[0].sinks, []);
  assert.equal(played[0].volume, 1);
});

// --- Speech detection (Lamiss#87) -------------------------------------------

// Feeds one level every 50 ms into a SpeechDetector, keeping the last 2.5 s as
// the microphone does, and returns the decisions other than waiting/speaking,
// up to the first that ends listening (as the offscreen page then stops).
function detect(levels) {
  const env = offscreenEnv();
  env.context.levels = levels;
  return JSON.parse(JSON.stringify(env.run(`(() => {
    const history = [];
    const detector = new SpeechDetector(history, 0);
    const decisions = [];
    for (let i = 0; i < levels.length; i += 1) {
      const at = i * 50;
      history.push({ at, level: levels[i] });
      while (history.length > 0 && at - history[0].at > 2500) history.shift();
      const decision = detector.feed(levels[i], at);
      if (decision !== 'waiting' && decision !== 'speaking') decisions.push([at, decision]);
      if (decision === 'no-speech' || decision === 'speech-ended') break;
    }
    return decisions;
  })()`)));
}

const repeat = (level, ms) => Array.from({ length: ms / 50 }, () => level);
// Speech with short pauses between words: 200 ms at `level`, 50 ms near silence.
const speech = (level, ms, pause = 0.008) => Array.from({ length: ms / 50 }, (_, i) => (i % 5 === 4 ? pause : level));

test('speech detection: an answer that starts the moment the mic opens is heard', () => {
  // A quiet voice from the first sample, under the "clearly spoken" level: the
  // old calibration averaged it into the threshold (×2.5) and never heard it.
  const decisions = detect([...speech(0.035, 3000), ...repeat(0.004, 3000)]);
  assert.equal(decisions[0][1], 'speech-started');
  assert.ok(decisions[0][0] <= 1000, `heard at ${decisions[0][0]} ms`);
  assert.deepEqual(decisions.map(([, decision]) => decision), ['speech-started', 'speech-ended']);
});

test('speech detection: a clearly spoken answer counts after 200 ms, short dips between syllables included', () => {
  // The dip at 200 ms doesn't restart the count; heard at 250 ms.
  assert.deepEqual(detect([...speech(0.08, 2000), ...repeat(0.004, 2500)])[0], [250, 'speech-started']);
  // A click (100 ms) is not speech.
  assert.deepEqual(detect([...repeat(0.2, 100), ...repeat(0.002, 9000)]), [[8000, 'no-speech']]);
});

test('speech detection: speech over the video playing at 20% is heard, and ends when only the video is left', () => {
  const video = (ms) => Array.from({ length: ms / 50 }, (_, i) => 0.02 + (i % 3) * 0.002);
  const decisions = detect([...video(1500), ...speech(0.07, 2000, 0.02), ...video(3000)]);
  assert.deepEqual(decisions.map(([, decision]) => decision), ['speech-started', 'speech-ended']);
  assert.ok(decisions[0][0] >= 1500 && decisions[0][0] <= 2000, `heard at ${decisions[0][0]} ms`);
});

test('speech detection: the video alone, or silence, ends with "no speech" after 8 s', () => {
  const video = Array.from({ length: 9000 / 50 }, (_, i) => 0.02 + (i % 3) * 0.002);
  assert.deepEqual(detect(video), [[8000, 'no-speech']]);
  assert.deepEqual(detect(repeat(0.002, 9000)), [[8000, 'no-speech']]);
});

// Fakes for the audio APIs the listening code opens.
function audioEnv(media) {
  const timeouts = [];
  const intervals = [];
  class FakeRecorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; this.listeners = {}; this.mimeType = 'audio/webm'; }
    addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; for (const listener of this.listeners.stop ?? []) listener(); }
  }
  class FakeAudioContext {
    constructor() { this.state = 'running'; }
    async resume() {}
    async close() { this.state = 'closed'; }
    createAnalyser() { return { fftSize: 0, getFloatTimeDomainData(samples) { samples.fill(0); } }; }
    createMediaStreamSource() { return { connect() {} }; }
  }
  const env = createExtensionEnv({
    scripts: ['shared/lamiss-config.js', 'shared/lamiss-i18n.js', 'shared/lamiss-api.js', 'offscreen/offscreen.js'],
    withoutSessionStorage: true,
    globals: {
      navigator: { mediaDevices: media.mediaDevices },
      AudioContext: FakeAudioContext,
      MediaRecorder: FakeRecorder,
      window: {
        setTimeout: (callback, ms) => timeouts.push({ callback, ms }),
        clearTimeout: (id) => { if (timeouts[id - 1]) timeouts[id - 1].cleared = true; },
        setInterval: (callback, ms) => intervals.push({ callback, ms }),
        clearInterval: (id) => { if (intervals[id - 1]) intervals[id - 1].cleared = true; }
      }
    }
  });
  return {
    env,
    intervals,
    runTimeouts(ms) {
      for (const timeout of timeouts) {
        if (!timeout.cleared && !timeout.ran && timeout.ms === ms) {
          timeout.ran = true;
          timeout.callback();
        }
      }
    }
  };
}

function fakeStream() {
  const track = { readyState: 'live', stopped: false, stop() { this.stopped = true; this.readyState = 'ended'; } };
  return { track, getTracks: () => [track] };
}

test('listening: a retry reuses the warm microphone, which is released 15 s after the last attempt', async () => {
  const stream = fakeStream();
  const media = fakeMediaDevices([stream]);
  const page = audioEnv(media);
  const listen = (requestId) => page.env.dispatchMessage({ target: 'lamiss-offscreen', type: 'listen', requestId, accessToken: 't' }, worker);
  const stop = (requestId) => page.env.dispatchMessage({ target: 'lamiss-offscreen', type: 'stop-listening', requestId, discard: true }, worker);

  await listen('r-1');
  await flush();
  assert.deepEqual(page.env.runtimeSent.at(-1), { source: 'lamiss-offscreen', requestId: 'r-1', event: { type: 'listening', noSpeechTimeoutMs: 8000 } });
  assert.equal(page.intervals.filter(interval => !interval.cleared).length, 1, 'sampling while open');
  await stop('r-1');
  assert.equal(stream.track.stopped, false, 'kept warm');
  assert.ok(page.env.logs.some(entry => entry.text.startsWith('Lamiss POC: listen attempt =') && entry.text.includes('"outcome":"cancelled"')));

  await listen('r-2');
  await flush();
  assert.equal(media.requests.length, 1, 'no new getUserMedia for the retry');
  // The first attempt's release timer no longer applies.
  page.runTimeouts(15_000);
  assert.equal(stream.track.stopped, false);

  await stop('r-2');
  page.runTimeouts(15_000);
  assert.equal(stream.track.stopped, true, 'released after 15 s');
  assert.equal(page.intervals.filter(interval => !interval.cleared).length, 0);
});

test('listening: another microphone chosen in the popup opens that one', async () => {
  const first = fakeStream();
  const media = fakeMediaDevices([first, fakeStream()]);
  const page = audioEnv(media);
  await page.env.dispatchMessage({ target: 'lamiss-offscreen', type: 'listen', requestId: 'r-1', accessToken: 't' }, worker);
  await flush();
  await page.env.dispatchMessage({ target: 'lamiss-offscreen', type: 'stop-listening', requestId: 'r-1', discard: true }, worker);
  await page.env.dispatchMessage({ target: 'lamiss-offscreen', type: 'listen', requestId: 'r-2', accessToken: 't', micDeviceId: 'mic-2' }, worker);
  await flush();

  assert.equal(media.requests.length, 2);
  assert.equal(first.track.stopped, true, 'the other microphone is released');
});
