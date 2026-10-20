// The content script answers the popup's Start Learning and status messages
// (TDR-0002), and only from this extension's own pages.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createExtensionEnv, senders } = require('./helpers/extension-env');

const WATCH_URL = 'https://www.youtube.com/watch?v=LeRylkDym54';

async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

// Just enough of a YouTube page for compiled/content/youtube.js to load.
function contentEnv(href = WATCH_URL) {
  const listeners = () => ({ addEventListener() {}, removeEventListener() {} });
  const document = {
    ...listeners(),
    documentElement: {},
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => []
  };
  return createExtensionEnv({
    scripts: ['shared/lamiss-config.js', 'shared/lamiss-api.js', 'content/youtube.js'],
    withoutSessionStorage: true,
    globals: {
      window: { ...listeners(), location: { href } },
      document,
      MutationObserver: class {
        observe() {}
      },
      requestAnimationFrame: (callback) => setTimeout(callback, 0)
    }
  });
}

test('the page status answers the popup with the video and the Lamiss button state', async () => {
  const env = contentEnv();
  await flush();
  const status = await env.dispatchMessage({ type: 'lamiss:page-status' }, senders.popup);
  assert.deepEqual(JSON.parse(JSON.stringify(status)), { videoId: 'LeRylkDym54', buttonState: 'idle' });
});

test('the page status reports no video outside a watch page', async () => {
  const env = contentEnv('https://www.youtube.com/');
  await flush();
  const status = await env.dispatchMessage({ type: 'lamiss:page-status' }, senders.popup);
  assert.equal(status.videoId, null);
});

test('start learning from the popup runs the in-page button flow', async () => {
  const env = contentEnv();
  await flush();
  const before = env.runtimeSent.length;
  const status = await env.dispatchMessage({ type: 'lamiss:start-learning' }, senders.popup);
  assert.equal(status.buttonState, 'loading');
  // The button flow starts by asking the worker for its own tab ID.
  assert.ok(env.runtimeSent.slice(before).some(message => message.type === 'GET_SENDER_TAB_ID'));
});

test('content scripts, the chat frame and other extensions cannot start learning or read the status', async () => {
  for (const sender of [senders.contentScript, senders.chat, senders.otherExtension, senders.otherExtensionContentScript, senders.otherSite]) {
    const env = contentEnv();
    await flush();
    const before = env.runtimeSent.length;
    assert.equal(await env.dispatchMessage({ type: 'lamiss:page-status' }, sender), undefined);
    assert.equal(await env.dispatchMessage({ type: 'lamiss:start-learning' }, sender), undefined);
    assert.equal(env.runtimeSent.length, before);
  }
});
