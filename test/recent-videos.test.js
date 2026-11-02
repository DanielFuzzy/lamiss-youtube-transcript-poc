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
