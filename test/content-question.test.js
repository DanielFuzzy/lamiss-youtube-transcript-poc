// The in-page question card and the video (TDR-0002 decision 9): the video
// stays paused during a question only if PAUSE_VIDEO came for it; otherwise
// it plays on at 20% volume while Lamiss speaks or listens, and the user's
// volume comes back afterwards. Runs compiled/content/youtube.js against a
// tiny fake DOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createExtensionEnv } = require('./helpers/extension-env');

const WATCH_URL = 'https://www.youtube.com/watch?v=LeRylkDym54';

async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

// Just the parts of an element the question card uses.
class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.id = '';
    this.className = '';
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.hidden = false;
    this.textContent = '';
    this.value = '';
    this.classList = { contains: () => false };
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
  }
  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter(child => child !== this);
      this.parentElement = null;
    }
  }
  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  focus() {}
  requestSubmit() {}
  *descendants() {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }
  contains(node) {
    return node === this || [...this.descendants()].includes(node);
  }
  querySelector(selector) {
    const className = selector.replace(/^\./, '');
    return [...this.descendants()].find(node => node.className.split(' ').includes(className)) ?? null;
  }
}

class FakeVideo extends FakeElement {
  constructor() {
    super('video');
    this.paused = false;
    this.currentTime = 42;
    this.volume = 1;
    this.plays = 0;
  }
  pause() {
    this.paused = true;
  }
  play() {
    this.paused = false;
    this.plays += 1;
    return Promise.resolve();
  }
}

function questionEnv() {
  const documentListeners = {};
  const player = new FakeElement('div');
  player.id = 'movie_player';
  const video = new FakeVideo();
  player.append(video);
  const timeouts = [];
  const document = {
    documentElement: {},
    addEventListener(type, listener) {
      (documentListeners[type] ??= []).push(listener);
    },
    removeEventListener() {},
    createElement: tag => new FakeElement(tag),
    getElementById: id => (id === player.id ? player : [...player.descendants()].find(node => node.id === id) ?? null),
    querySelector: selector => (selector === '#movie_player video' ? video : null),
    querySelectorAll: () => []
  };
  const window = {
    addEventListener() {},
    removeEventListener() {},
    location: { href: WATCH_URL },
    // Timeouts run only when a test asks; intervals never do.
    setTimeout: (callback, ms) => timeouts.push({ callback, ms }),
    clearTimeout: (id) => {
      if (timeouts[id - 1]) {
        timeouts[id - 1].cleared = true;
      }
    },
    setInterval: () => 0,
    clearInterval: () => undefined
  };
  const env = createExtensionEnv({
    scripts: ['shared/lamiss-config.js', 'shared/lamiss-api.js', 'content/youtube.js'],
    withoutSessionStorage: true,
    globals: {
      window,
      document,
      HTMLVideoElement: FakeVideo,
      MutationObserver: class {
        observe() {}
      },
      requestAnimationFrame: () => 0
    }
  });
  // The live connection to the worker.
  const posted = [];
  env.context.fakePort = { postMessage: message => posted.push(structuredClone(message)), disconnect() {} };
  env.run('lamissLivePort = fakePort; lamissLiveState = "connected"; lamissLiveVideoId = "LeRylkDym54";');

  const server = message => env.context.onLamissLiveMessage({ type: 'server', message });
  const lastRequest = type => posted.filter(message => message.type === type).at(-1)?.requestId;
  return {
    env,
    video,
    player,
    posted,
    server,
    dispatch(type, target = video) {
      for (const listener of documentListeners[type] ?? []) {
        listener({ type, target });
      }
    },
    // Lamiss finished reading the text she was asked to say.
    async speechEnded() {
      env.context.onLamissLiveMessage({ type: 'speech-event', requestId: lastRequest('speak'), event: { type: 'ended' } });
      await flush();
    },
    listenEvent(event) {
      env.context.onLamissLiveMessage({ type: 'listen-event', requestId: lastRequest('listen'), event });
    },
    // Runs the pending timeouts set for exactly `ms` (the card's own delays).
    runTimeouts(ms) {
      for (const timeout of timeouts) {
        if (!timeout.cleared && !timeout.ran && timeout.ms === ms) {
          timeout.ran = true;
          timeout.callback();
        }
      }
    },
    phase: () => env.run('lamissQuestion?.phase'),
    cardOpen: () => Boolean(document.getElementById('lamiss-question'))
  };
}

test('auto-pause on: PAUSE_VIDEO holds the video paused for the question, at full volume', async () => {
  const page = questionEnv();
  await flush();
  page.video.volume = 0.8;
  page.server({ type: 'PAUSE_VIDEO' });
  page.server({ type: 'ASK_QUESTION', eventId: 'e1', question: 'What did she say?' });
  assert.equal(page.video.paused, true);
  assert.equal(page.cardOpen(), true);
  assert.equal(page.video.volume, 0.8, 'no ducking while paused');

  // Pressing play during the question pauses again.
  page.video.play();
  page.dispatch('play');
  assert.equal(page.video.paused, true);

  page.server({ type: 'FEEDBACK', correct: true, feedback: 'Well done.', language: 'en' });
  page.server({ type: 'RESUME_VIDEO' });
  await page.speechEnded();
  page.runTimeouts(1200);
  assert.equal(page.cardOpen(), false);
  assert.equal(page.video.paused, false, 'resumed');
});

test('auto-pause off: the video plays on at 20% while Lamiss asks and listens, then gets its volume back', async () => {
  const page = questionEnv();
  await flush();
  page.video.volume = 0.8;
  page.server({ type: 'ASK_QUESTION', eventId: 'e1', question: 'What did she say?' });
  assert.equal(page.video.paused, false);
  assert.equal(page.cardOpen(), true, 'the card shows over the playing video');
  assert.equal(page.phase(), 'speaking');
  assert.equal(page.video.volume, 0.2);

  // Playing is fine: nothing pauses it.
  page.dispatch('play');
  assert.equal(page.video.paused, false);

  await page.speechEnded();
  assert.equal(page.phase(), 'listening');
  assert.equal(page.video.volume, 0.2, 'still lowered while listening');

  // No answer heard: the user types instead, at their own volume.
  page.listenEvent({ type: 'no-speech' });
  assert.equal(page.phase(), 'answering');
  assert.equal(page.video.volume, 0.8);
});

test('auto-pause off: feedback is read over the lowered video, and the card closes without RESUME_VIDEO', async () => {
  const page = questionEnv();
  await flush();
  page.video.volume = 0.6;
  page.server({ type: 'ASK_QUESTION', eventId: 'e1', question: 'What did she say?' });
  await page.speechEnded();
  page.listenEvent({ type: 'transcribed', text: 'Hello', language: 'en' });
  assert.equal(page.phase(), 'sending');
  assert.equal(page.video.volume, 0.2);
  assert.ok(page.posted.some(message => message.type === 'answer' && message.answer === 'Hello'));

  page.server({ type: 'FEEDBACK', correct: true, feedback: 'Well done.', language: 'en' });
  assert.equal(page.video.volume, 0.2, 'lowered while the feedback is read');
  await page.speechEnded();
  assert.equal(page.video.volume, 0.6, 'restored once Lamiss is done');
  assert.equal(page.cardOpen(), true);
  page.runTimeouts(4000);
  assert.equal(page.cardOpen(), false, 'closed by itself');
  assert.equal(page.video.plays, 0, 'nothing to resume');
});

test('auto-pause off: a video the user paused during the question stays paused when the card closes', async () => {
  const page = questionEnv();
  await flush();
  page.server({ type: 'ASK_QUESTION', eventId: 'e1', question: 'Why?' });
  page.video.pause();
  page.server({ type: 'FEEDBACK', correct: false, feedback: 'Not quite.', language: 'en' });
  // "Close" on the feedback.
  page.env.context.onLamissQuestionSubmit();
  assert.equal(page.cardOpen(), false);
  assert.equal(page.video.paused, true);
});

test('a volume the user changed while lowered is kept', async () => {
  const page = questionEnv();
  await flush();
  page.video.volume = 0.9;
  page.server({ type: 'ASK_QUESTION', eventId: 'e1', question: 'Why?' });
  assert.equal(page.video.volume, 0.2);
  page.video.volume = 0.5;
  page.dispatch('volumechange');
  page.env.context.hideLamissQuestion();
  assert.equal(page.video.volume, 0.5);
});

test('a quiet video is never made louder, and leaving the video restores the volume', async () => {
  const page = questionEnv();
  await flush();
  page.video.volume = 0.1;
  page.server({ type: 'ASK_QUESTION', eventId: 'e1', question: 'Why?' });
  assert.equal(page.video.volume, 0.1);
  page.env.context.hideLamissQuestion();

  page.video.volume = 0.7;
  page.server({ type: 'ASK_QUESTION', eventId: 'e2', question: 'How?' });
  assert.equal(page.video.volume, 0.2);
  // Navigating away stops Lamiss on this video.
  page.env.context.stopLamissLive();
  assert.equal(page.cardOpen(), false);
  assert.equal(page.video.volume, 0.7);
});

test('a PAUSE_VIDEO is used by the question it announces only', async () => {
  const page = questionEnv();
  await flush();
  page.server({ type: 'PAUSE_VIDEO' });
  page.server({ type: 'ASK_QUESTION', eventId: 'e1', question: 'Why?' });
  assert.equal(page.env.run('lamissQuestion.holdPaused'), true);
  page.env.context.hideLamissQuestion();

  page.video.play();
  page.server({ type: 'ASK_QUESTION', eventId: 'e2', question: 'How?' });
  assert.equal(page.env.run('lamissQuestion.holdPaused'), false);
  page.dispatch('play');
  assert.equal(page.video.paused, false);
});
