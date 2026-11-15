// Recent videos in the extension (the backend's docs/TDR-0004-Recent-Videos.md):
// the call, where Resume goes, and how times are written. Run against compiled/.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createExtensionEnv, futureIso, API_BASE_URL } = require('./helpers/extension-env');

const plain = (value) => JSON.parse(JSON.stringify(value));

const video = {
  videoId: 42,
  platform: 'YOUTUBE',
  externalVideoId: 'LeRylkDym54',
  title: 'How to learn any language',
  thumbnailUrl: 'https://i.ytimg.com/vi/LeRylkDym54/mqdefault.jpg',
  videoUrl: 'https://www.youtube.com/watch?v=LeRylkDym54',
  durationSeconds: 612,
  lastStudiedAt: '2026-11-01T19:42:10Z',
  playback: { lastPositionMs: 185_400 },
  learningProgress: { questionsAnswered: 4 }
};

function pageEnv(responder) {
  const env = createExtensionEnv({ responder });
  env.session.data.set('lamissAuth', { accessToken: 'secret-token', expiresAt: futureIso(), user: { id: 7, email: 'ana@example.com', username: 'ana' } });
  return env;
}

test('recent videos: GET /api/me/recent-videos with the token and a bounded limit', async () => {
  const env = pageEnv(async (url) => (url === `${API_BASE_URL}/api/me/recent-videos?limit=20` ? { json: { videos: [video] } } : { status: 404, json: {} }));
  assert.deepEqual(plain(await env.run('fetchRecentVideos()')), { ok: true, data: { videos: [video] } });
  assert.equal(env.fetchCalls[0].headers.get('authorization'), 'Bearer secret-token');
});

test('recent videos: Resume opens the YouTube video at the saved position, and nothing else', () => {
  const env = pageEnv();
  const resume = (value) => {
    env.context.candidate = value;
    return env.run('lamissResumeUrl(candidate)');
  };
  assert.equal(resume(video), 'https://www.youtube.com/watch?v=LeRylkDym54&t=185s');
  assert.equal(resume({ ...video, playback: null }), 'https://www.youtube.com/watch?v=LeRylkDym54', 'never played: from the start');
  assert.equal(resume({ ...video, playback: { lastPositionMs: 400 } }), 'https://www.youtube.com/watch?v=LeRylkDym54');
  assert.equal(resume({ ...video, videoUrl: null, platform: 'NETFLIX' }), undefined);
  assert.equal(resume({ ...video, videoUrl: 'https://evil.example/watch?v=x' }), undefined);
  assert.equal(resume({ ...video, videoUrl: 'javascript:alert(1)' }), undefined);
  assert.equal(resume({ ...video, videoUrl: 'http://www.youtube.com/watch?v=x' }), undefined);
  assert.equal(resume({ ...video, videoUrl: 'https://www.youtube.com/feed/history' }), undefined);
});

test('recent videos: durations and "how long ago" follow the app language', () => {
  const env = pageEnv();
  assert.equal(env.run('formatLamissDuration(185.4)'), '3:05');
  assert.equal(env.run('formatLamissDuration(3723)'), '1:02:03');
  assert.equal(env.run('formatLamissDuration(-5)'), '0:00');

  const now = Date.parse('2026-11-01T21:42:10Z');
  assert.equal(env.run(`formatLamissRelativeTime('2026-11-01T19:42:10Z', ${now})`), '2 hours ago');
  assert.equal(env.run(`formatLamissRelativeTime('2026-10-31T21:00:00Z', ${now})`), 'yesterday');
  assert.equal(env.run(`formatLamissRelativeTime('2026-11-01T21:42:00Z', ${now})`), 'now');
  assert.equal(env.run(`formatLamissRelativeTime('not a date', ${now})`), '');

  for (const listener of env.chrome.storage.onChanged.listeners) {
    listener({ lamissAppLanguage: { newValue: 'es' } }, 'local');
  }
  assert.equal(env.run(`formatLamissRelativeTime('2026-11-01T19:42:10Z', ${now})`), 'hace 2 horas');
});

// --- The popup's Recent view: loading, list, empty and failure states ---

// The parts of an element the Recent view uses.
class FakeElement {
  constructor(tagName, id = '') {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.className = '';
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.hidden = false;
    this.textContent = '';
    this.innerHTML = '';
    this.style = {};
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes) {
    this.children = nodes;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  focus() {}
}

// popup-shared.js and recent-view.js on a page that has every element they ask for.
function recentViewEnv(responder) {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, new FakeElement('div', id));
      }
      return elements.get(id);
    },
    createElement: tag => new FakeElement(tag),
    querySelector: () => null,
    querySelectorAll: () => []
  };
  const env = createExtensionEnv({
    responder,
    scripts: ['shared/lamiss-config.js', 'shared/lamiss-i18n.js', 'shared/lamiss-api.js', 'shared/lamiss-auth.js',
      'popup/popup-shared.js', 'popup/recent-view.js'],
    globals: { document }
  });
  env.session.data.set('lamissAuth', { accessToken: 'secret-token', expiresAt: futureIso(), user: { id: 7, email: 'ana@example.com', username: 'ana' } });
  const element = id => document.getElementById(id);
  // Which of the four states is showing.
  const shown = () => ['recentLoading', 'recentList', 'recentEmpty', 'recentError'].filter(id => !element(id).hidden);
  return { env, element, shown, open: () => env.run("showPopupView('recent')") };
}

async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

test('recent view: loading, then the list with where playback stopped and the questions answered', async () => {
  let answer;
  const page = recentViewEnv(() => new Promise((resolve) => { answer = resolve; }));
  page.open();
  await settle();
  assert.deepEqual(page.shown(), ['recentLoading']);

  answer({ json: { videos: [video, { ...video, videoId: 43, title: null, thumbnailUrl: null, durationSeconds: null, playback: null, learningProgress: { questionsAnswered: 0 } }] } });
  await settle();

  assert.deepEqual(page.shown(), ['recentList']);
  const items = page.element('recentList').children;
  assert.equal(items.length, 2);
  const texts = item => JSON.stringify(item, (key, value) => (key === 'listeners' ? undefined : value));
  assert.match(texts(items[0]), /Stopped at 3:05 of 10:12/);
  assert.match(texts(items[0]), /4 questions answered/);
  // Optional fields missing: a placeholder thumbnail and title, and nothing breaks.
  assert.equal(items[1].children[0].dataset.placeholder, 'true');
  for (const key of ['recent.untitled', 'recent.notPlayed', 'recent.noQuestions']) {
    assert.ok(texts(items[1]).includes(page.env.run(`lamissT('${key}')`)), key);
  }
});

test('recent view: an empty history says so', async () => {
  const page = recentViewEnv(async () => ({ json: { videos: [] } }));
  page.open();
  await settle();
  assert.deepEqual(page.shown(), ['recentEmpty']);
  assert.equal(page.element('recentList').children.length, 0);
});

test('recent view: a failure shows the reason, and Retry loads again', async () => {
  const page = recentViewEnv(async () => ({ status: 503, json: { detail: 'Lamiss is resting', retryable: true } }));
  page.open();
  await settle();
  assert.deepEqual(page.shown(), ['recentError']);
  assert.equal(page.element('recentErrorText').textContent, 'Lamiss is resting');

  page.env.setResponder(async () => ({ json: { videos: [video] } }));
  page.element('recentRetryButton').listeners.click[0]();
  await settle();
  assert.deepEqual(page.shown(), ['recentList']);
  assert.equal(page.env.fetchCalls.length, 2);
});

test('recent view: an unreachable backend is described as such', async () => {
  const page = recentViewEnv(async () => {
    throw new TypeError('Failed to fetch');
  });
  page.open();
  await settle();
  assert.deepEqual(page.shown(), ['recentError']);
  assert.equal(page.element('recentErrorText').textContent, page.env.run("lamissT('popup.unreachable')"));
});
