// The three independent languages (the backend's docs/TDR-0003-Language-Preferences.md):
// the app language (shared/lamiss-i18n.js, extension storage), the tutor
// language (a backend preference, shared/lamiss-api.js) and the caption
// language (picked from the video by the content script). Run against compiled/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createExtensionEnv, futureIso, API_BASE_URL } = require('./helpers/extension-env');

const plain = (value) => JSON.parse(JSON.stringify(value));
const APP_LANGUAGES = ['en', 'es', 'fr', 'de', 'pt'];

function pageEnv(options = {}) {
  const env = createExtensionEnv(options);
  env.session.data.set('lamissAuth', { accessToken: 'secret-token', expiresAt: futureIso(), user: { id: 7, email: 'ana@example.com', username: 'ana' } });
  return env;
}

// What chrome.storage.onChanged reports after another page saved the app language.
function appLanguageChanged(env, newValue) {
  for (const listener of env.chrome.storage.onChanged.listeners) {
    listener({ lamissAppLanguage: { newValue } }, 'local');
  }
}

// --- App language ---------------------------------------------------------------

test('app language: five quick choices, each message translated into all of them with the same placeholders', () => {
  const env = pageEnv();
  assert.deepEqual(plain(env.run('LAMISS_APP_LANGUAGES')).map(language => language.code), APP_LANGUAGES);
  const messages = plain(env.run('LAMISS_MESSAGES'));
  assert.ok(Object.keys(messages).length > 200);
  for (const [key, texts] of Object.entries(messages)) {
    assert.equal(texts.length, 5, key);
    const placeholders = texts.map(text => (text.match(/\{\w+\}/g) ?? []).sort().join(','));
    for (const [index, text] of texts.entries()) {
      assert.ok(text.trim().length > 0, `${key} in ${APP_LANGUAGES[index]}`);
      assert.equal(placeholders[index], placeholders[0], `${key} in ${APP_LANGUAGES[index]} keeps the placeholders`);
    }
  }
});

test('app language: every data-i18n key in the pages exists', () => {
  const env = pageEnv();
  const messages = plain(env.run('LAMISS_MESSAGES'));
  const pages = ['src/popup/popup.html', 'src/chat/chat.html', 'src/permission/permission.html'];
  for (const page of pages) {
    const html = fs.readFileSync(path.resolve(__dirname, '..', page), 'utf8');
    const keys = [
      ...[...html.matchAll(/data-i18n="([^"]+)"/g)].map(match => match[1]),
      ...[...html.matchAll(/data-signed-in-key="([^"]+)"/g)].map(match => match[1]),
      ...[...html.matchAll(/data-i18n-attr="([^"]+)"/g)].flatMap(match => match[1].split(';').map(pair => pair.split(':')[1]))
    ];
    assert.ok(keys.length > 0, page);
    for (const key of keys) {
      assert.ok(key in messages, `${page}: ${key}`);
    }
  }
});

test('app language: defaults to the browser language when it is one of the five, else English', () => {
  assert.equal(pageEnv({ globals: { navigator: { language: 'es-MX' } } }).run('lamissAppLanguage'), 'es');
  assert.equal(pageEnv({ globals: { navigator: { language: 'pt-BR' } } }).run('lamissAppLanguage'), 'pt');
  assert.equal(pageEnv({ globals: { navigator: { language: 'ja-JP' } } }).run('lamissAppLanguage'), 'en');
  assert.equal(pageEnv().run('lamissAppLanguage'), 'en');
});

test('app language: the saved choice is loaded, and only a supported one', async () => {
  const env = pageEnv();
  env.local.data.set('lamissAppLanguage', 'de');
  assert.equal(await env.run('loadAppLanguage()'), 'de');
  assert.equal(env.run("lamissT('home.start')"), 'Lernen starten');

  const other = pageEnv();
  other.local.data.set('lamissAppLanguage', 'klingon');
  assert.equal(await other.run('loadAppLanguage()'), 'en');
});

test('app language: saving writes only its own key, and every page follows the change', async () => {
  const env = pageEnv();
  env.run('var heard = []; onAppLanguageChange(language => heard.push(language));');

  await env.run("saveAppLanguage('fr')");
  assert.deepEqual(plain(env.local.writes), [{ lamissAppLanguage: 'fr' }]);

  appLanguageChanged(env, 'fr');
  assert.equal(env.run('lamissAppLanguage'), 'fr');
  assert.deepEqual(plain(env.run('heard')), ['fr']);
  assert.equal(env.run("lamissT('common.gapApart', { gap: '2 min' })"), "Au moins 2 min d'écart");

  // The same value again is no change.
  appLanguageChanged(env, 'fr');
  assert.deepEqual(plain(env.run('heard')), ['fr']);
});

test('app language: language names and shared messages follow it', () => {
  const env = pageEnv();
  assert.equal(env.run("lamissLanguageName('en')"), 'English');
  appLanguageChanged(env, 'es');
  assert.equal(env.run("lamissLanguageName('en')"), 'inglés');
  assert.equal(env.run("lamissLanguageLabel('en')"), 'Inglés');
  assert.equal(env.run('formatDailyGoal(null)'), 'Desactivado');
  assert.equal(env.run("describePracticeProgress({ date: '2026-10-20', practicedMinutes: 12, goalMinutes: 30 }).text"), '12 de 30 min hoy');
  assert.equal(env.run("usernameProblem('a')"), 'Usa de 3 a 20 letras, números o guiones bajos.');
  assert.equal(env.run('lamissSignInRequiredMessage()'), 'Inicia sesión para usar Lamiss.');
  appLanguageChanged(env, 'de');
  assert.equal(env.run("lamissLanguageName('en')"), 'Englisch');
  assert.equal(env.run("LAMISS_LEARNING_GOALS[1].label()"), 'Wortschatz');
});

test('app language: changing it never touches the tutor or caption settings', async () => {
  const env = pageEnv();
  env.local.data.set('lamissQuestionSettings', { difficulty: 'HARD', minSecondsBetweenQuestions: 60 });
  await env.run("saveAppLanguage('pt')");
  appLanguageChanged(env, 'pt');
  assert.deepEqual(plain(await env.run('readQuestionSettings()')), { difficulty: 'HARD', minSecondsBetweenQuestions: 60 });
  assert.equal(env.fetchCalls.length, 0, 'nothing is sent to the backend');
});

// --- Tutor language ---------------------------------------------------------------------

const preferences = {
  nativeLanguage: 'en',
  learningLanguage: 'es',
  tutorLanguage: 'es',
  proficiencyLevel: null,
  tutor: { kindness: 'BALANCED', responseLength: 'NORMAL', encouragement: true, explanationLanguage: 'es', autoPause: true },
  voice: { voiceId: null, speed: 1 }
};

test('tutor language: read from tutorLanguage, or from explanationLanguage on an older backend', () => {
  const env = pageEnv();
  env.context.preferences = preferences;
  assert.equal(env.run('lamissTutorLanguage(preferences)'), 'es');
  env.context.older = { ...preferences, tutorLanguage: undefined, tutor: { ...preferences.tutor, explanationLanguage: 'fr' } };
  assert.equal(env.run('lamissTutorLanguage(older)'), 'fr');
  env.context.cleared = { ...preferences, tutorLanguage: null };
  assert.equal(env.run('lamissTutorLanguage(cleared)'), null, 'a cleared tutorLanguage wins over the stale explanationLanguage');
});

test('tutor language: clearing it sends null and no stale explanationLanguage that would set it again', async () => {
  const env = pageEnv({ responder: async (url, init) => (url === `${API_BASE_URL}/api/me/preferences` ? { json: JSON.parse(init.body) } : { status: 404, json: {} }) });
  env.context.cleared = { ...preferences, tutorLanguage: null };
  await env.run('savePreferences(cleared)');
  const body = JSON.parse(env.fetchCalls[0].init.body);
  assert.equal(body.tutorLanguage, null);
  assert.equal('explanationLanguage' in body.tutor, false);
  // The learning and native languages go as they were: the tutor language is its own field.
  assert.equal(body.learningLanguage, 'es');
  assert.equal(body.nativeLanguage, 'en');
});

test('tutor language: it is not the app language', async () => {
  const env = pageEnv({ responder: async (url, init) => (url === `${API_BASE_URL}/api/me/preferences` ? { json: JSON.parse(init.body) } : { status: 404, json: {} }) });
  appLanguageChanged(env, 'de');
  env.context.english = { ...preferences, tutorLanguage: 'en' };
  await env.run('savePreferences(english)');
  assert.equal(JSON.parse(env.fetchCalls[0].init.body).tutorLanguage, 'en');
  assert.equal(env.run('lamissAppLanguage'), 'de');
});
