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
  assert.deepEqual(rejected, { ok: false, status: 400, error: 'Unknown language code: xx', retryable: false, errorCode: 'invalid_preferences' });

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

test('a preview language needs a voice for it', () => {
  const env = pageEnv();
  env.context.kokoro = voices;
  env.context.openai = { provider: 'openai', selectable: false, defaultSpeed: 1, voices: [{ id: 'coral', label: 'Coral', language: null, default: true }] };
  assert.equal(env.run("lamissHasVoiceFor(kokoro, 'es')"), true);
  assert.equal(env.run("lamissHasVoiceFor(kokoro, 'de')"), false);
  assert.equal(env.run("lamissHasVoiceFor(openai, 'de')"), true);
  assert.equal(env.run("lamissHasVoiceFor(undefined, 'en')"), false);
});

// FEEDBACK's language (the explanation language) picks the voice that reads it.
test('speech language: the reported language, else the video\'s', () => {
  const env = pageEnv();
  assert.equal(env.run("lamissSpeechLanguage('es', 'en')"), 'es');
  assert.equal(env.run("lamissSpeechLanguage(null, 'en')"), 'en');
  assert.equal(env.run("lamissSpeechLanguage(undefined, 'en')"), 'en');
  assert.equal(env.run("lamissSpeechLanguage(undefined, undefined)"), undefined);
  // Not an ISO 639-1 code: ignored.
  assert.equal(env.run("lamissSpeechLanguage('SPANISH', 'en')"), 'en');
  assert.equal(env.run("lamissSpeechLanguage({}, 'en')"), 'en');
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

// --- TDR-0002 addendum: auto-pause, goals, practice and username ---------------

test('preferences: autoPause, learningGoal and dailyGoalMinutes go out in the full PUT body', async () => {
  const env = pageEnv(async (url, init) => ({ json: JSON.parse(init.body) }));
  env.context.changed = { ...preferences, learningGoal: 'CONVERSATION', dailyGoalMinutes: 30, tutor: { ...preferences.tutor, autoPause: false } };
  const saved = plain(await env.run('savePreferences(changed)'));
  assert.equal(saved.ok, true);
  const body = JSON.parse(env.fetchCalls[0].init.body);
  assert.equal(body.learningGoal, 'CONVERSATION');
  assert.equal(body.dailyGoalMinutes, 30);
  assert.equal(body.tutor.autoPause, false);
  // The fields the first PUT already required are still there.
  assert.equal(body.tutor.kindness, 'BALANCED');
  assert.equal(body.voice.speed, 0.95);
});

test('learning goals match the backend enum', () => {
  const env = pageEnv();
  assert.deepEqual(plain(env.run('LAMISS_LEARNING_GOALS')).map(entry => entry.goal), ['CONVERSATION', 'VOCABULARY', 'GRAMMAR', 'LISTENING', 'PRONUNCIATION']);
});

test('daily goal slider: 0 is off, then 5–240 minutes', () => {
  const env = pageEnv();
  assert.equal(env.run('dailyGoalFromSlider(0)'), null);
  assert.equal(env.run('dailyGoalFromSlider(4)'), null);
  assert.equal(env.run('dailyGoalFromSlider(5)'), 5);
  assert.equal(env.run('dailyGoalFromSlider(30)'), 30);
  assert.equal(env.run('dailyGoalFromSlider(240)'), 240);
  assert.equal(env.run('dailyGoalFromSlider(500)'), 240);
  assert.equal(env.run('dailyGoalFromSlider(NaN)'), null);
  assert.equal(env.run('formatDailyGoal(30)'), '30 min');
  assert.equal(env.run('formatDailyGoal(null)'), 'Off');
});

test('practice today: GET with the local IANA time zone, encoded', async () => {
  const today = { date: '2026-10-20', practicedMinutes: 12, goalMinutes: 30 };
  const env = pageEnv(async () => ({ json: today }));
  assert.deepEqual(plain(await env.run("fetchPracticeToday('America/Argentina/Buenos_Aires')")), { ok: true, data: today });
  assert.equal(env.fetchCalls[0].url, `${API_BASE_URL}/api/me/practice/today?timeZone=America%2FArgentina%2FBuenos_Aires`);
  assert.equal(env.fetchCalls[0].headers.get('authorization'), 'Bearer secret-token');

  // By default the browser's own zone.
  await env.run('fetchPracticeToday()');
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.equal(new URL(env.fetchCalls[1].url).searchParams.get('timeZone'), zone);
  assert.equal(env.run('lamissLocalTimeZone()'), zone);
});

test('practice today: a zone the backend rejects falls back to UTC once', async () => {
  const today = { date: '2026-10-20', practicedMinutes: 3, goalMinutes: 30 };
  const env = pageEnv(async (url) => new URL(url).searchParams.get('timeZone') === 'UTC'
    ? { json: today }
    : { status: 400, json: { detail: 'Invalid time zone', errorCode: 'invalid_time_zone' } });
  assert.deepEqual(plain(await env.run("fetchPracticeToday('Etc/Unknown')")), { ok: true, data: today });
  assert.deepEqual(env.fetchCalls.map(call => new URL(call.url).searchParams.get('timeZone')), ['Etc/Unknown', 'UTC']);

  // Other failures are reported as they are, without a second request.
  const failing = pageEnv(async () => ({ status: 503, json: { detail: 'down', retryable: true } }));
  const result = plain(await failing.run("fetchPracticeToday('Europe/Madrid')"));
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(failing.fetchCalls.length, 1);
});

test('practice progress: "12 of 30 min today", nothing without a goal', () => {
  const env = pageEnv();
  assert.deepEqual(plain(env.run("describePracticeProgress({ date: '2026-10-20', practicedMinutes: 12, goalMinutes: 30 })")),
    { text: '12 of 30 min today', fraction: 0.4, done: false });
  assert.deepEqual(plain(env.run("describePracticeProgress({ date: '2026-10-20', practicedMinutes: 45, goalMinutes: 30 })")),
    { text: '45 of 30 min today', fraction: 1, done: true });
  assert.equal(env.run("describePracticeProgress({ date: '2026-10-20', practicedMinutes: 12, goalMinutes: null })"), undefined);
  assert.equal(env.run('describePracticeProgress(undefined)'), undefined);
});

test('username rules match domain.Username', () => {
  const env = pageEnv();
  for (const ok of ['abc', 'daniel_s', 'A1_b2', 'x'.repeat(20)]) {
    assert.equal(env.run(`usernameProblem(${JSON.stringify(ok)})`), undefined, ok);
  }
  for (const bad of ['', 'ab', 'x'.repeat(21), 'dan iel', 'daniel-s', 'dañiel', 'a.b.c']) {
    assert.equal(env.run(`usernameProblem(${JSON.stringify(bad)})`), 'Use 3–20 letters, numbers or underscores.', bad);
  }
});

test('profile PATCH: 200 is the new profile, 400 and 409 get friendly messages', async () => {
  const profile = { id: 7, email: 'ana@example.com', username: 'ana_l', displayName: 'Ana López', pictureUrl: null };
  let reply = { json: profile };
  const env = pageEnv(async () => reply);

  assert.deepEqual(plain(await env.run("updateUsername('ana_l')")), { ok: true, data: profile });
  const patch = env.fetchCalls[0];
  assert.equal(patch.url, `${API_BASE_URL}/api/me/profile`);
  assert.equal(patch.init.method, 'PATCH');
  assert.equal(patch.headers.get('content-type'), 'application/json');
  assert.equal(patch.headers.get('authorization'), 'Bearer secret-token');
  assert.deepEqual(JSON.parse(patch.init.body), { username: 'ana_l' });

  reply = { status: 409, json: { detail: 'Username already taken', errorCode: 'username_taken', retryable: false } };
  env.context.taken = await env.run("updateUsername('bob')");
  assert.equal(env.context.taken.errorCode, 'username_taken');
  assert.equal(env.run('describeUsernameFailure(taken)'), 'That username is already taken. Try another one.');

  reply = { status: 400, json: { detail: 'Invalid username', errorCode: 'invalid_username', retryable: false } };
  env.context.invalid = await env.run("updateUsername('b o')");
  assert.equal(env.run('describeUsernameFailure(invalid)'), 'Use 3–20 letters, numbers or underscores.');

  reply = { status: 500, json: { detail: 'Something broke', retryable: true } };
  env.context.broken = await env.run("updateUsername('bob')");
  assert.equal(env.run('describeUsernameFailure(broken)'), 'Something broke');
});
