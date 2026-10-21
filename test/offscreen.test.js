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
    scripts: ['shared/lamiss-config.js', 'shared/lamiss-api.js', 'offscreen/offscreen.js'],
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
    scripts: ['shared/lamiss-config.js', 'shared/lamiss-api.js', 'offscreen/offscreen.js'],
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
    scripts: ['shared/lamiss-config.js', 'shared/lamiss-api.js', 'offscreen/offscreen.js'],
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
    scripts: ['shared/lamiss-config.js', 'shared/lamiss-api.js', 'offscreen/offscreen.js'],
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
