// The settings popup's shared helpers (TDR-0002): device settings in
// extension storage, the preferences/voices/profile calls, and the choices
// the popup derives from them. Run against compiled/shared/*.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createExtensionEnv, senders, futureIso, API_BASE_URL } = require('./helpers/extension-env');

const plain = (value) => JSON.parse(JSON.stringify(value));

// The JSON of TDR-0002's examples.
const preferences = {
  nativeLanguage: 'es',
  learningLanguage: 'en',
  proficiencyLevel: 'B1',
  tutor: { kindness: 'BALANCED', responseLength: 'NORMAL', encouragement: true, explanationLanguage: null },
  voice: { voiceId: null, speed: 0.95 }
};

const voices = {
  provider: 'kokoro',
  selectable: true,
  defaultSpeed: 0.95,
  voices: [
    { id: 'af_heart', label: 'Heart', language: 'en', default: true },
    { id: 'am_adam', label: 'Adam', language: 'en', default: false },
    { id: 'ef_dora', label: 'Dora', language: 'es', default: true }
  ]
};

function pageEnv(responder) {
  const env = createExtensionEnv({ responder });
  env.session.data.set('lamissAuth', { accessToken: 'secret-token', expiresAt: futureIso(), user: { id: 7, email: 'ana@example.com', username: 'ana' } });
  return env;
}

test('device settings: defaults, merging, clamping and dropping empty device IDs', async () => {
  const env = pageEnv();
  assert.deepEqual(plain(await env.run('readDeviceSettings()')), { volume: 1 });

  await env.run("saveDeviceSettings({ micDeviceId: 'mic-1' })");
  await env.run('saveDeviceSettings({ volume: 1.7 })');
  assert.deepEqual(env.local.data.get('lamissDeviceSettings'), { micDeviceId: 'mic-1', volume: 1 });

  await env.run("saveDeviceSettings({ speakerDeviceId: 'spk-1', volume: 0.35 })");
  // "" is how the popup's "System default" option clears a device.
  await env.run("saveDeviceSettings({ micDeviceId: '' })");
  assert.deepEqual(env.local.data.get('lamissDeviceSettings'), { speakerDeviceId: 'spk-1', volume: 0.35 });

  env.local.data.set('lamissDeviceSettings', { micDeviceId: 42, volume: 'loud' });
  assert.deepEqual(plain(await env.run('readDeviceSettings()')), { volume: 1 });
});

test('preferences: GET and PUT carry the token and the full object', async () => {
  const env = pageEnv(async (url, init) => {
    if (url === `${API_BASE_URL}/api/me/preferences` && (init.method ?? 'GET') === 'GET') {
      return { json: preferences };
    }
    if (url === `${API_BASE_URL}/api/me/preferences` && init.method === 'PUT') {
      return { json: JSON.parse(init.body) };
    }
    return { status: 404, json: {} };
  });

  const loaded = plain(await env.run('fetchPreferences()'));
  assert.deepEqual(loaded, { ok: true, data: preferences });
  assert.equal(env.fetchCalls[0].headers.get('authorization'), 'Bearer secret-token');

  const changed = { ...preferences, tutor: { ...preferences.tutor, kindness: 'STRICT' } };
  env.context.changed = changed;
  const saved = plain(await env.run('savePreferences(changed)'));
  assert.deepEqual(saved, { ok: true, data: changed });
  const put = env.fetchCalls[1];
  assert.equal(put.init.method, 'PUT');
  assert.equal(put.headers.get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(put.init.body), changed);
});

test('preferences: a 400 shows the backend message; a 401 asks to sign in again', async () => {
  const env = pageEnv(async () => ({
    status: 400,
    json: { detail: 'Unknown language code: xx', errorCode: 'invalid_preferences', retryable: false }
  }));
  env.context.changed = preferences;
  const rejected = plain(await env.run('savePreferences(changed)'));
  assert.deepEqual(rejected, { ok: false, status: 400, error: 'Unknown language code: xx', retryable: false });

  env.setResponder(async () => ({ status: 401, json: { detail: 'Unauthenticated' } }));
  const expired = plain(await env.run('fetchPreferences()'));
  assert.equal(expired.signInRequired, true);
  assert.equal(expired.error, 'Please sign in again.');
  assert.deepEqual(env.session.data.get('lamissAuth'), { expired: true });
});

test('preferences: an unreachable backend is a retryable error without a status', async () => {
  const env = pageEnv(async () => {
    throw new TypeError('Failed to fetch');
  });
  const result = plain(await env.run('fetchPreferences()'));
  assert.equal(result.ok, false);
  assert.equal(result.status, undefined);
  assert.equal(result.retryable, true);
});

test('voices and profile: GET /api/speech/voices and /api/auth/me', async () => {
  const profile = { id: 7, email: 'ana@example.com', username: 'ana', displayName: 'Ana López', pictureUrl: 'https://lh3.googleusercontent.com/a/x' };
  const env = pageEnv(async (url) => {
    if (url === `${API_BASE_URL}/api/speech/voices`) {
      return { json: voices };
    }
    if (url === `${API_BASE_URL}/api/auth/me`) {
      return { json: profile };
    }
    return { status: 404, json: {} };
  });
  assert.deepEqual(plain(await env.run('fetchVoices()')), { ok: true, data: voices });
  assert.deepEqual(plain(await env.run('fetchProfile()')), { ok: true, data: profile });
  assert.ok(env.fetchCalls.every(call => call.headers.get('authorization') === 'Bearer secret-token'));
});

test('voices are filtered to the learning language, or all of them when none is set', () => {
  const env = pageEnv();
  env.context.voices = voices.voices;
  assert.deepEqual(plain(env.run("voicesForLanguage(voices, 'en')")).map(voice => voice.id), ['af_heart', 'am_adam']);
  assert.deepEqual(plain(env.run("voicesForLanguage(voices, 'ja')")), []);
  assert.equal(env.run('voicesForLanguage(voices, null)').length, 3);
});

test('question frequency maps to the stored gap and highlights the nearest choice', () => {
  const env = pageEnv();
  assert.deepEqual(plain(env.run('LAMISS_QUESTION_FREQUENCIES')), [
    { key: 'LESS', seconds: 300 },
    { key: 'NORMAL', seconds: 120 },
    { key: 'MORE', seconds: 60 }
  ]);
  // Stops the chat panel's slider can store. A tie (90 s) keeps the fewer questions.
  const expected = { 600: 'LESS', 300: 'LESS', 180: 'NORMAL', 120: 'NORMAL', 90: 'NORMAL', 60: 'MORE', 45: 'MORE', 15: 'MORE' };
  for (const [seconds, key] of Object.entries(expected)) {
    assert.equal(env.run(`questionFrequencyFor(${seconds})`), key, `${seconds} s`);
  }
});

test('the language list matches the backend Language enum', () => {
  const env = pageEnv();
  const codes = plain(env.run('LAMISS_LANGUAGES')).map(language => language.code);
  assert.deepEqual(codes, 'en es fr de it pt zh ja ko ar hi bn ur ta te ru uk pl cs tr el nl sv no da fi he vi th id'.split(' '));
  assert.equal(env.run("lamissLanguageName('he')"), 'Hebrew');
});

test('only extension pages count as extension pages', () => {
  const env = pageEnv();
  env.context.senders = senders;
  assert.equal(env.run('isFromExtensionPage(senders.popup)'), true);
  assert.equal(env.run('isFromExtensionPage(senders.offscreen)'), true);
  for (const name of ['chat', 'contentScript', 'otherExtension', 'otherExtensionContentScript', 'otherSite']) {
    assert.equal(env.run(`isFromExtensionPage(senders.${name})`), false, name);
  }
});
