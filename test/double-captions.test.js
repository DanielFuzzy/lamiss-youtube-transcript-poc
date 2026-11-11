// Double Captions (the backend's docs/TDR-0006-Double-Captions.md): the
// worker's call, and the overlay that follows playback, run against
// compiled/content/double-captions.js with a tiny fake player.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createExtensionEnv, senders, futureIso, API_BASE_URL } = require('./helpers/extension-env');

const plain = (value) => JSON.parse(JSON.stringify(value));

async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

const words = (text, startMs) => text.split(' ').map((word, i) => ({ index: i, text: word, startMs: startMs + i * 300, endMs: startMs + (i + 1) * 300 }));
const chunk = (chunkIndex, startMs, endMs, source, status, target = []) => ({ chunkIndex, startMs, endMs, source: words(source, startMs), target, status });
const page = (fromMs, chunks) => ({ ok: true, data: { videoId: 'LeRylkDym54', sourceLanguage: 'en', targetLanguage: 'es', fromMs, toMs: fromMs + 60_000, chunks } });

// --- The worker ---------------------------------------------------------------

test('double captions: the worker calls GET /api/captions/{videoId} for the content script, and checks what it asks', async () => {
  const window = page(12_000, [chunk(3, 12_000, 15_000, 'I love pizza', 'READY', ['Me', 'encanta', 'la', 'pizza'])]);
  const env = createExtensionEnv({
    scripts: ['background.js'],
    responder: async (url) => (url === `${API_BASE_URL}/api/captions/LeRylkDym54?fromMs=12345` ? { json: window.data } : { status: 404, json: {} })
  });
  env.session.data.set('lamissAuth', { accessToken: 'secret-token', expiresAt: futureIso(), user: { id: 7, email: 'ana@example.com', username: 'ana' } });

  const result = await env.dispatchMessage({ type: 'FETCH_DOUBLE_CAPTIONS', videoId: 'LeRylkDym54', fromMs: 12_345.6 }, senders.contentScript);

  assert.deepEqual(plain(result), window);
  assert.equal(env.fetchCalls[0].headers.get('authorization'), 'Bearer secret-token');
  for (const bad of [{ videoId: '../me', fromMs: 0 }, { videoId: 'LeRylkDym54', fromMs: 'x' }, { videoId: 'LeRylkDym54', fromMs: Infinity }]) {
    assert.equal((await env.dispatchMessage({ type: 'FETCH_DOUBLE_CAPTIONS', ...bad }, senders.contentScript)).ok, false, JSON.stringify(bad));
  }
  assert.equal(env.fetchCalls.length, 1, 'nothing sent for a bad request');
  assert.equal(await env.dispatchMessage({ type: 'FETCH_DOUBLE_CAPTIONS', videoId: 'LeRylkDym54', fromMs: 0 }, senders.otherSite), undefined);
});

// --- The overlay --------------------------------------------------------------

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.id = '';
    this.className = '';
    this.children = [];
    this.parentElement = null;
    this.hidden = false;
    this.textContent = '';
    this.lang = '';
    const classes = new Set();
    this.classList = {
      contains: name => classes.has(name),
      remove: name => classes.delete(name),
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name))
    };
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
  *descendants() {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }
}

function overlayEnv({ enabled = true } = {}) {
  const documentListeners = {};
  const player = new FakeElement('div');
  player.id = 'movie_player';
  const video = new FakeElement('video');
  video.currentTime = 0;
  video.playbackRate = 1;
  player.append(video);
  const timeouts = [];
  const document = {
    addEventListener(type, listener) {
      (documentListeners[type] ??= []).push(listener);
    },
    createElement: tag => new FakeElement(tag),
    getElementById: id => [...player.descendants()].find(node => node.id === id) ?? null
  };
  const window = {
    setTimeout: (callback, ms) => timeouts.push({ callback, ms }),
    clearTimeout: (id) => {
      if (timeouts[id - 1]) {
        timeouts[id - 1].cleared = true;
      }
    }
  };
  const env = createExtensionEnv({
    scripts: ['shared/lamiss-config.js', 'shared/lamiss-i18n.js', 'shared/lamiss-api.js', 'content/double-captions.js'],
    withoutSessionStorage: true,
    globals: { window, document }
  });
  // youtube.js's player lookups.
  env.context.getLamissPlayer = () => player;
  env.context.getLamissVideo = () => video;
  env.local.data.set('lamissCaptionSettings', { enabled });
  // The worker's answers, in order; every request is recorded.
  const requests = [];
  const answers = [];
  env.chrome.runtime.sendMessage = async (message) => {
    requests.push(structuredClone(message));
    return answers.shift() ?? { ok: false, error: 'offline', retryable: true };
  };
  return {
    env,
    video,
    player,
    requests,
    answer: (...next) => answers.push(...next),
    async at(ms, type = 'timeupdate') {
      video.currentTime = ms / 1000;
      for (const listener of documentListeners[type] ?? []) {
        listener({ type, target: video });
      }
      await flush();
    },
    runTimeouts(ms) {
      for (const timeout of timeouts) {
        if (!timeout.cleared && !timeout.ran && timeout.ms === ms) {
          timeout.ran = true;
          timeout.callback();
        }
      }
    },
    setEnabled(on) {
      for (const listener of env.chrome.storage.onChanged.listeners) {
        listener({ lamissCaptionSettings: { newValue: { enabled: on } } }, 'local');
      }
    },
    lines() {
      const overlay = document.getElementById('lamiss-double-captions');
      if (!overlay || overlay.hidden) {
        return null;
      }
      const [source, target] = overlay.children;
      return { source: source.textContent, target: target.hidden ? null : target.textContent, lang: [source.lang, target.lang] };
    }
  };
}

test('double captions: a line shows from its start until a little after it ends, the last one started winning', () => {
  const { env } = overlayEnv();
  env.context.sample = [chunk(0, 0, 3000, 'a', 'READY'), chunk(1, 2500, 6000, 'b', 'READY'), chunk(2, 10_000, 12_000, 'c', 'READY')];
  const at = ms => env.run(`lamissCaptionAt(sample, ${ms})?.chunkIndex`);
  assert.equal(at(0), 0);
  assert.equal(at(2600), 1, 'the newer line replaces the older one');
  assert.equal(at(6500), 1, 'held 800 ms after its end');
  assert.equal(at(6900), undefined, 'then nothing until the next line');
  assert.equal(at(10_000), 2);
});

test('double captions: a new window when there is none, after a seek, or 30 s of watching before the current one ends', () => {
  const { env } = overlayEnv();
  env.context.range = { fromMs: 0, toMs: 60_000 };
  const need = (ms, rate = 1) => env.run(`lamissCaptionsNeedWindow(range, ${ms}, ${rate})`);
  assert.equal(env.run('lamissCaptionsNeedWindow(undefined, 0, 1)'), true);
  assert.equal(need(10_000), false);
  assert.equal(need(31_000), true, 'less than 30 s left');
  assert.equal(need(10_000, 1.25), false);
  assert.equal(need(24_000, 1.25), true, 'at 1.25x, 30 s of watching is 37.5 s of video');
  assert.equal(need(10_000, 2), false, 'never more than 45 s of video ahead');
  assert.equal(need(16_000, 2), true);
  assert.equal(need(70_000), true, 'seeked past it');
});

test('double captions: the source shows at once, the translation when ready, polling while lines are pending', async () => {
  const page$ = overlayEnv();
  page$.answer(page(0, [chunk(0, 0, 3000, 'I love pizza', 'READY', ['Me', 'encanta', 'la', 'pizza']), chunk(1, 3000, 6000, 'It is cheap', 'PENDING')]));
  page$.env.run('startLamissCaptions("LeRylkDym54")');
  await flush();
  await page$.at(1000);

  assert.deepEqual(plain(page$.requests), [{ type: 'FETCH_DOUBLE_CAPTIONS', videoId: 'LeRylkDym54', fromMs: 0 }]);
  assert.deepEqual(page$.lines(), { source: 'I love pizza', target: 'Me encanta la pizza', lang: ['en', 'es'] });
  assert.equal(page$.player.classList.contains('lamiss-double-captions-on'), true, "YouTube's captions hidden");

  await page$.at(4000);
  assert.deepEqual(page$.lines(), { source: 'It is cheap', target: '…', lang: ['en', 'es'] });

  // The poll for the pending line.
  page$.answer(page(0, [chunk(0, 0, 3000, 'I love pizza', 'READY', ['Me', 'encanta', 'la', 'pizza']), chunk(1, 3000, 6000, 'It is cheap', 'READY', ['Es', 'barata'])]));
  page$.runTimeouts(2500);
  await flush();
  assert.equal(page$.requests.length, 2, 'only the poll');
  assert.equal(page$.requests[1].fromMs, 0);
  assert.deepEqual(page$.lines(), { source: 'It is cheap', target: 'Es barata', lang: ['en', 'es'] });

  // Between lines: nothing, and YouTube's captions are back.
  await page$.at(8000);
  assert.equal(page$.lines(), null);
  assert.equal(page$.player.classList.contains('lamiss-double-captions-on'), false);
});

test('double captions: a seek asks for the window there; a failed line shows the source only', async () => {
  const page$ = overlayEnv();
  page$.answer(page(0, [chunk(0, 0, 3000, 'one', 'READY', ['uno'])]));
  page$.env.run('startLamissCaptions("LeRylkDym54")');
  await flush();
  await page$.at(0);

  page$.answer(page(300_000, [chunk(50, 300_000, 303_000, 'far away', 'UNAVAILABLE')]));
  await page$.at(300_500, 'seeking');

  assert.equal(page$.requests.at(-1).fromMs, 300_500);
  assert.deepEqual(page$.lines(), { source: 'far away', target: null, lang: ['en', 'es'] });
});

test('double captions: off by default, on and off from the popup, and stopped with the session', async () => {
  const page$ = overlayEnv({ enabled: false });
  page$.env.run('startLamissCaptions("LeRylkDym54")');
  await flush();
  await page$.at(1000);
  assert.equal(page$.requests.length, 0);

  page$.answer(page(1000, [chunk(0, 0, 3000, 'hello', 'READY', ['hola'])]));
  page$.setEnabled(true);
  await flush();
  await page$.at(1000);
  assert.equal(page$.lines().target, 'hola');

  page$.setEnabled(false);
  assert.equal(page$.lines(), null);
  assert.equal(page$.player.classList.contains('lamiss-double-captions-on'), false);

  page$.setEnabled(true);
  page$.env.run('stopLamissCaptions()');
  await page$.at(1000);
  assert.equal(page$.lines(), null, 'no session, nothing shown');
});

test('double captions: no native language (422) stops asking for this video; a network error retries later', async () => {
  const page$ = overlayEnv();
  page$.answer({ ok: false, status: 422, error: 'Choose your native language to see translated captions', retryable: false });
  page$.env.run('startLamissCaptions("LeRylkDym54")');
  await flush();
  await page$.at(5000);
  await page$.at(90_000, 'seeking');
  assert.equal(page$.requests.length, 1);

  const retry = overlayEnv();
  retry.env.run('startLamissCaptions("LeRylkDym54")');
  await flush();
  await retry.at(1000);
  await retry.at(2000);
  assert.equal(retry.requests.length, 1, 'no new request within 15 s of a failure');
});
