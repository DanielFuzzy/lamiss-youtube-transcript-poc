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
