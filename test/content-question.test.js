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
    this.style = {};
    this.classList = { contains: () => false };
  }
  getBoundingClientRect() {
    return { left: 900, right: 940, top: 500, bottom: 536 };
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
  const body = new FakeElement('body');
  const windowListeners = {};
  const document = {
    documentElement: {},
    body,
    addEventListener(type, listener) {
      (documentListeners[type] ??= []).push(listener);
    },
    removeEventListener() {},
    createElement: tag => new FakeElement(tag),
    getElementById: id => (id === player.id ? player : [...player.descendants(), ...body.descendants()].find(node => node.id === id) ?? null),
    querySelector: selector => (selector === '#movie_player video' ? video : null),
    querySelectorAll: () => []
  };
  const window = {
    addEventListener(type, listener) {
      (windowListeners[type] ??= []).push(listener);
    },
    removeEventListener() {},
    innerWidth: 1280,
    innerHeight: 800,
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
    scripts: ['shared/lamiss-config.js', 'shared/lamiss-i18n.js', 'shared/lamiss-api.js', 'content/double-captions.js', 'content/video-frames.js', 'content/youtube.js'],
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
    body,
    posted,
    server,
    // Delivers an event to the page's own document or window listeners.
    fire(target, type, event) {
      for (const listener of (target === 'window' ? windowListeners : documentListeners)[type] ?? []) {
        listener({ type, ...event });
      }
    },
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

// TDR-0003: the question comes in the tutor language, which picks the voice;
// the caption language is only the fallback.
test('tutor language: a question in another language than the captions is read with its own voice', async () => {
  const page = questionEnv();
  await flush();
  page.env.run('lamissCaptionLanguage = "en";');
  page.server({ type: 'PAUSE_VIDEO' });
  page.server({ type: 'ASK_QUESTION', eventId: 'e1', question: '¿Qué dijo ella?', language: 'es' });
  const speak = page.posted.filter(message => message.type === 'speak').at(-1);
  assert.equal(speak.text, '¿Qué dijo ella?');
  assert.equal(speak.language, 'es');

  await page.speechEnded();
  // Feedback without a language of its own follows the question's.
  page.server({ type: 'FEEDBACK', correct: true, feedback: '¡Muy bien!' });
  assert.equal(page.posted.filter(message => message.type === 'speak').at(-1).language, 'es');
});

test('tutor language: without one (an older backend), the question is read in the caption language as before', async () => {
  const page = questionEnv();
  await flush();
  page.env.run('lamissCaptionLanguage = "en";');
  page.server({ type: 'ASK_QUESTION', eventId: 'e1', question: 'What did she say?' });
  assert.equal(page.posted.filter(message => message.type === 'speak').at(-1).language, 'en');
});

test('app language: the open question card switches language at once, the question itself does not', async () => {
  const page = questionEnv();
  await flush();
  page.server({ type: 'ASK_QUESTION', eventId: 'e1', question: 'What did she say?', language: 'en' });
  const card = page.player.querySelector('.lamiss-question__card');
  const submit = card.querySelector('.lamiss-question__submit');
  assert.equal(submit.textContent, 'Answer');

  for (const listener of page.env.chrome.storage.onChanged.listeners) {
    listener({ lamissAppLanguage: { newValue: 'es' } }, 'local');
  }
  assert.equal(submit.textContent, 'Responder');
  assert.equal(card.querySelector('.lamiss-question__heading').textContent, 'Lamiss pregunta · 0:42');
  assert.equal(card.querySelector('.lamiss-question__text').textContent, 'What did she say?');
});

// --- Ask Lamiss card (Lamiss#84) ----------------------------------------------

test('ask lamiss: the card opens listening, sends the spoken question, reads the answer over the quieter video, then closes', async () => {
  const page = questionEnv();
  await flush();
  page.video.volume = 0.8;

  page.env.run('openLamissAsk()');
  assert.equal(page.cardOpen(), true);
  assert.equal(page.phase(), 'listening');
  assert.equal(page.posted.at(-1).type, 'listen');
  assert.equal(page.video.volume, 0.2, 'quieter while Lamiss listens');
  assert.equal(page.video.paused, false, 'the video keeps playing');

  page.listenEvent({ type: 'transcribed', text: 'What is he holding?' });
  // Sent once the video's frames are captured (Lamiss#88): none here, the fake video has no picture.
  await flush();
  const ask = page.posted.at(-1);
  assert.equal(ask.type, 'ask');
  assert.equal(ask.question, 'What is he holding?');
  assert.equal(ask.positionMs, 42_000);
  assert.equal(page.phase(), 'sending');

  page.env.context.onLamissLiveMessage({ type: 'ask-result', requestId: ask.requestId, ok: true, answer: 'Un paraguas rojo.', language: 'es' });
  assert.equal(page.phase(), 'feedback');
  const feedback = page.player.querySelector('.lamiss-question__feedback');
  assert.equal(feedback.textContent, 'Un paraguas rojo.', 'not graded: no "Correct" in front');
  assert.deepEqual(page.posted.filter(message => message.type === 'speak').at(-1).language, 'es');

  await page.speechEnded();
  page.runTimeouts(4000);
  assert.equal(page.cardOpen(), false);
  assert.equal(page.video.volume, 0.8, 'volume back');
  assert.equal(page.video.paused, false);
});

test('ask lamiss: a failed answer can be sent again with the same interactionId, and Escape cancels', async () => {
  const page = questionEnv();
  await flush();
  page.env.run('openLamissAsk()');
  page.listenEvent({ type: 'transcribed', text: 'Why?' });
  await flush();
  const first = page.posted.at(-1);
  page.env.context.onLamissLiveMessage({ type: 'ask-result', requestId: first.requestId, ok: false, error: 'AI down', retryable: true });
  assert.equal(page.phase(), 'answering');
  assert.equal(page.player.querySelector('.lamiss-question__status').textContent, "Lamiss couldn't answer: AI down");

  page.env.run('onLamissQuestionSubmit()');
  await flush();
  assert.equal(page.posted.at(-1).type, 'ask');
  assert.equal(page.posted.at(-1).requestId, first.requestId);

  const overlay = page.env.context.document.getElementById('lamiss-question');
  for (const listener of overlay.listeners.keydown) {
    listener({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  }
  assert.equal(page.cardOpen(), false);
});

test('ask lamiss: a question Lamiss is asking comes first', async () => {
  const page = questionEnv();
  await flush();
  page.server({ type: 'ASK_QUESTION', eventId: 'e1', question: 'What did she say?' });
  const listens = page.posted.filter(message => message.type === 'listen').length;

  page.env.run('openLamissAsk()');

  assert.equal(page.env.run('lamissQuestion.mode'), 'answer');
  assert.equal(page.posted.filter(message => message.type === 'listen').length, listens);
});

// --- Daily goal celebration (Lamiss#98) ---

const celebrationOpen = page => Boolean(page.env.context.document.getElementById('lamiss-celebration'));

function pressOnCelebration(page, key) {
  const overlay = page.env.context.document.getElementById('lamiss-celebration');
  for (const listener of overlay.listeners.keydown) {
    listener({ key, preventDefault() {}, stopPropagation() {} });
  }
}

test('daily goal: the video pauses, the card congratulates, the chime plays, and Continue plays the video again', async () => {
  const page = questionEnv();
  await flush();
  page.server({ type: 'DAILY_GOAL_REACHED', practicedMinutes: 20, goalMinutes: 20 });

  assert.equal(celebrationOpen(page), true);
  assert.equal(page.video.paused, true);
  assert.equal(page.posted.at(-1).type, 'chime');
  assert.equal(page.player.querySelector('lamiss-celebration__title').textContent, 'Congratulations! 🎉');
  assert.equal(page.player.querySelector('lamiss-celebration__line').textContent, 'You reached your daily goal: 20 minutes of practice today.');

  const plays = page.video.plays;
  page.player.querySelector('lamiss-celebration__continue').listeners.click[0]();
  assert.equal(celebrationOpen(page), false);
  assert.equal(page.video.paused, false);
  assert.equal(page.video.plays, plays + 1);
});

test('daily goal: Escape closes it, and a video the user had paused stays paused', async () => {
  const page = questionEnv();
  await flush();
  page.video.pause();
  page.server({ type: 'DAILY_GOAL_REACHED', practicedMinutes: 31, goalMinutes: 30 });
  assert.equal(page.player.querySelector('lamiss-celebration__line').textContent, 'You reached your daily goal: 31 minutes of practice today.');

  pressOnCelebration(page, 'Escape');
  assert.equal(celebrationOpen(page), false);
  assert.equal(page.video.paused, true);
  assert.equal(page.video.plays, 0);
});

test('daily goal: it waits for an open question, and Continue then plays the video Lamiss paused for it', async () => {
  const page = questionEnv();
  await flush();
  page.server({ type: 'PAUSE_VIDEO' });
  page.server({ type: 'ASK_QUESTION', eventId: 'e1', question: 'What did she say?' });
  page.server({ type: 'DAILY_GOAL_REACHED', practicedMinutes: 20, goalMinutes: 20 });
  assert.equal(celebrationOpen(page), false);
  assert.ok(!page.posted.some(message => message.type === 'chime'));

  page.server({ type: 'FEEDBACK', correct: true, feedback: 'Well done.' });
  page.server({ type: 'RESUME_VIDEO' });
  await page.speechEnded();
  page.runTimeouts(0);
  page.env.run('resumeLamissVideo()');

  assert.equal(page.cardOpen(), false);
  assert.equal(celebrationOpen(page), true);
  assert.equal(page.video.paused, true, 'the celebration holds the video');
  assert.equal(page.posted.at(-1).type, 'chime');

  pressOnCelebration(page, 'Escape');
  assert.equal(page.video.paused, false);
});

// A page whose canvas can draw, and whose system asks for reduced motion or not.
function celebrationPage(reducedMotion) {
  const page = questionEnv();
  const { document, window } = page.env.context;
  const createElement = document.createElement;
  document.createElement = (tag) => {
    const element = createElement(tag);
    if (tag === 'canvas') {
      const noop = () => undefined;
      element.getContext = () => ({ scale: noop, clearRect: noop, save: noop, translate: noop, rotate: noop, fillRect: noop, restore: noop });
    }
    return element;
  };
  window.matchMedia = query => ({ matches: reducedMotion && query === '(prefers-reduced-motion: reduce)' });
  page.env.context.performance = { now: () => 0 };
  return page;
}

test('daily goal: confetti falls, unless the system asks for reduced motion: then only the card and the chime', async () => {
  const moving = celebrationPage(false);
  await flush();
  moving.server({ type: 'DAILY_GOAL_REACHED', practicedMinutes: 20, goalMinutes: 20 });
  assert.equal(celebrationOpen(moving), true);
  assert.ok(moving.player.querySelector('lamiss-celebration__confetti'), 'confetti with motion allowed');

  const still = celebrationPage(true);
  await flush();
  still.server({ type: 'DAILY_GOAL_REACHED', practicedMinutes: 20, goalMinutes: 20 });
  assert.equal(celebrationOpen(still), true);
  assert.equal(still.player.querySelector('lamiss-celebration__confetti'), null, 'no confetti');
  assert.equal(still.posted.at(-1).type, 'chime');
  assert.equal(still.video.paused, true);
  assert.equal(still.player.querySelector('lamiss-celebration__title').textContent, 'Congratulations! 🎉');
});

// --- The extension's menu under the video ---

function menuPage() {
  const page = questionEnv();
  const gear = page.env.run('createLamissMenuButton()');
  page.player.append(gear);
  const frame = () => page.env.context.document.getElementById('lamiss-menu-frame');
  return { ...page, gear, frame };
}

test('menu: the gear opens the toolbar menu in a frame under it, and closes it again', async () => {
  const page = menuPage();
  await flush();
  assert.equal(page.gear.getAttribute('aria-haspopup'), 'dialog');

  page.gear.listeners.click[0]({ stopPropagation() {} });
  const frame = page.frame();
  assert.ok(frame, 'the menu is open');
  assert.equal(frame.src, `chrome-extension://${page.env.run('chrome.runtime.id')}/popup/popup.html?embedded=1`);
  assert.equal(frame.allow, 'microphone');
  assert.equal(frame.title, 'Lamiss settings');
  assert.equal(page.gear.getAttribute('aria-expanded'), 'true');
  // Right above the gear (top 500), its right edge lined up with the gear's, before the menu says its height.
  assert.equal(frame.dataset.placement, 'above');
  assert.equal(frame.style.left, '580px');
  assert.equal(frame.style.width, '360px');
  assert.equal(frame.style.height, '480px');
  assert.equal(frame.style.top, '12px');

  page.gear.listeners.click[0]({ stopPropagation() {} });
  assert.equal(page.frame(), null);
  assert.equal(page.gear.getAttribute('aria-expanded'), 'false');
});

test('menu: a click elsewhere on the page or Escape closes it; a click on the gear does not count as elsewhere', async () => {
  const page = menuPage();
  await flush();
  page.env.run('openLamissMenu()');
  page.fire('document', 'pointerdown', { target: page.gear });
  assert.ok(page.frame(), 'the gear toggles it itself');
  page.fire('document', 'pointerdown', { target: page.video });
  assert.equal(page.frame(), null);

  page.env.run('openLamissMenu()');
  page.fire('document', 'keydown', { key: 'Escape' });
  assert.equal(page.frame(), null);
});

test('menu: only its own frame may close it', async () => {
  const page = menuPage();
  await flush();
  page.env.run('openLamissMenu()');
  const frame = page.frame();
  frame.contentWindow = {};

  page.fire('window', 'message', { source: {}, data: { type: 'lamiss:close-menu' } });
  assert.ok(page.frame(), 'another frame or the page itself is ignored');
  page.fire('window', 'message', { source: frame.contentWindow, data: { type: 'something-else' } });
  assert.ok(page.frame());
  page.fire('window', 'message', { source: frame.contentWindow, data: { type: 'lamiss:close-menu' } });
  assert.equal(page.frame(), null);
});

test('menu: it is as tall as the menu says and stays right above the gear; with no room above, it opens below', async () => {
  const page = menuPage();
  await flush();
  page.env.run('openLamissMenu()');
  const frame = page.frame();
  frame.contentWindow = {};

  page.fire('window', 'message', { source: frame.contentWindow, data: { type: 'lamiss:menu-size', height: 300 } });
  assert.equal(frame.style.height, '300px');
  assert.equal(frame.style.top, '192px', '500 - 8 - 300');
  // Never taller than 600 px, nor than the room above the gear.
  page.fire('window', 'message', { source: frame.contentWindow, data: { type: 'lamiss:menu-size', height: 2000 } });
  assert.equal(frame.style.height, '484px');
  assert.equal(frame.style.top, '8px');
  // Another frame can't resize it.
  page.fire('window', 'message', { source: {}, data: { type: 'lamiss:menu-size', height: 250 } });
  assert.equal(frame.style.height, '484px');

  // Scrolled so the gear is near the top of the window: below it.
  page.gear.getBoundingClientRect = () => ({ left: 900, right: 940, top: 60, bottom: 96 });
  page.fire('window', 'message', { source: frame.contentWindow, data: { type: 'lamiss:menu-size', height: 300 } });
  assert.equal(frame.dataset.placement, 'below');
  assert.equal(frame.style.top, '104px');
  assert.equal(frame.style.height, '300px');
});

test('daily limits (Lamiss#107): past the limit of checked answers, the card says so as it is, without "try again"', async () => {
  const page = questionEnv();
  await flush();
  page.server({ type: 'PAUSE_VIDEO' });
  page.server({ type: 'ASK_QUESTION', eventId: 'e1', question: 'What did she say?' });
  page.env.run("lamissQuestion.phase = 'sending'; lamissQuestion.answer = 'Hello';");

  page.server({ type: 'ERROR', message: 'You have reached today\'s limit for answers checked by Lamiss.', errorCode: 'daily_limit_reached', limit: 'ANSWER' });

  assert.equal(page.phase(), 'answering');
  assert.equal(page.env.run('lamissQuestion.error'), "You've reached today's limit of answers Lamiss can check. It resets at midnight UTC.");

  // Any other error still offers to try again.
  page.env.run("lamissQuestion.phase = 'sending'");
  page.server({ type: 'ERROR', message: 'AI down' });
  assert.equal(page.env.run('lamissQuestion.error'), "Lamiss couldn't check your answer: AI down. Try again.");
});

test('visual questions (Lamiss#89): asked for frames, the page answers with what it could capture', async () => {
  const page = questionEnv();
  await flush();

  page.server({ type: 'CAPTURE_FRAMES', requestId: 'v-1' });
  await flush();

  // The fake video has no picture yet: nothing could be captured, and the page says so.
  assert.deepEqual(page.posted.at(-1), { type: 'visual-frames', requestId: 'v-1', frames: [] });
});
