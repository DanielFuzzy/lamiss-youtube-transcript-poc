#!/usr/bin/env node
// Walks the settings popup (TDR-0002) in a real Chromium with the built
// extension: home → each view → back, against a stubbed backend, and saves a
// screenshot of every step. Not part of `npm test`: it needs a Chromium-based
// browser that still accepts --load-extension (Playwright's Chromium, Chrome
// for Testing, Brave…; branded Google Chrome no longer does).
//
//   npm run build && node scripts/popup-e2e.js [screenshotDir]
//
// LAMISS_E2E_BROWSER: the browser executable (default: Playwright's Chromium
// if installed, else Brave on macOS). LAMISS_E2E_HEADED=1 shows the window.
// The browser gets fake media devices and auto-accepts the microphone prompt.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const extensionDir = path.join(root, 'compiled');
const screenshotDir = path.resolve(process.argv[2] || path.join(root, 'e2e-screenshots'));
const VIDEO_URL = 'https://www.youtube.com/watch?v=LeRylkDym54';
// The watch page stand-in: a Subscribe button for the content script to put
// its button next to, and page-wide img rules like a site's to check the logo
// keeps its own size.
const YOUTUBE_STUB = '<!doctype html><title>Video - YouTube</title>'
  + '<style>img { width: auto; height: auto; max-width: 100%; vertical-align: middle; }</style>'
  + '<video></video><ytd-watch-metadata><div id="owner"><div id="subscribe-button">Subscribe</div></div></ytd-watch-metadata>';

function fail(message) {
  console.error(`popup-e2e: ${message}`);
  process.exit(1);
}

function readApiBase() {
  const config = path.join(extensionDir, 'shared', 'lamiss-config.js');
  if (!fs.existsSync(config)) {
    fail('compiled/ is missing: run `npm run build` first');
  }
  const match = /LAMISS_API_BASE_URL = "([^"]+)"/.exec(fs.readFileSync(config, 'utf8'));
  return match ? match[1] : fail('could not read LAMISS_API_BASE_URL from compiled/shared/lamiss-config.js');
}

function pickBrowser() {
  if (process.env.LAMISS_E2E_BROWSER) {
    return process.env.LAMISS_E2E_BROWSER;
  }
  try {
    const bundled = chromium.executablePath();
    if (bundled && fs.existsSync(bundled)) {
      return bundled;
    }
  } catch {
    // Not downloaded.
  }
  const brave = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
  return fs.existsSync(brave) ? brave : fail('no browser found: set LAMISS_E2E_BROWSER');
}

// --- The stubbed backend (TDR-0002 shapes) ---------------------------------------

const user = { id: 7, email: 'daniel@example.com', username: 'daniel', displayName: 'Daniel Sanchez', pictureUrl: null };
let preferences = {
  nativeLanguage: 'es',
  learningLanguage: 'en',
  proficiencyLevel: 'B1',
  learningGoal: null,
  dailyGoalMinutes: null,
  tutor: { kindness: 'BALANCED', responseLength: 'NORMAL', encouragement: true, explanationLanguage: null, autoPause: true },
  voice: { voiceId: null, speed: 0.95 }
};
// Minutes practiced today, whatever the goal.
const PRACTICED_TODAY = 12;
// PATCH /api/me/profile answers 409 for this one.
const TAKEN_USERNAME = 'taken_name';
const kokoroVoices = {
  provider: 'kokoro',
  selectable: true,
  defaultSpeed: 0.95,
  voices: [
    { id: 'af_heart', label: 'Heart', language: 'en', default: true },
    { id: 'af_bella', label: 'Bella', language: 'en', default: false },
    { id: 'am_michael', label: 'Michael', language: 'en', default: false },
    { id: 'ef_dora', label: 'Dora', language: 'es', default: true }
  ]
};
const openaiVoices = { provider: 'openai', selectable: false, defaultSpeed: 1.0, voices: [{ id: 'coral', label: 'Coral', language: null, default: true }] };
let voices = kokoroVoices;
const backendCalls = [];

// A short silent WAV stands in for synthesized speech.
function silentWav() {
  const samples = 4410;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(44100, 24);
  buffer.writeUInt32LE(88200, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}

async function answerBackend(route, apiBase) {
  const request = route.request();
  const url = new URL(request.url());
  const call = `${request.method()} ${url.pathname}`;
  const authorized = request.headers().authorization === 'Bearer e2e-token';
  backendCalls.push({ call, authorized, body: request.postData(), timeZone: url.searchParams.get('timeZone') });
  const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
  if (request.method() === 'OPTIONS') {
    return route.fulfill({ status: 204, headers: cors });
  }
  if (!authorized && url.pathname !== '/api/auth/logout') {
    return json(401, { detail: 'Unauthenticated' });
  }
  switch (call) {
    case 'GET /api/auth/me':
      return json(200, user);
    case 'GET /api/me/practice/today': {
      const zone = url.searchParams.get('timeZone');
      try {
        new Intl.DateTimeFormat('en', { timeZone: zone || undefined });
      } catch {
        return json(400, { detail: 'Unknown time zone', errorCode: 'invalid_time_zone' });
      }
      if (!zone) {
        return json(400, { detail: 'Missing time zone', errorCode: 'invalid_time_zone' });
      }
      return json(200, { date: '2026-10-20', practicedMinutes: PRACTICED_TODAY, goalMinutes: preferences.dailyGoalMinutes ?? null });
    }
    case 'PATCH /api/me/profile': {
      const { username } = JSON.parse(request.postData());
      if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
        return json(400, { detail: 'Invalid username', errorCode: 'invalid_username' });
      }
      if (username.toLowerCase() === TAKEN_USERNAME) {
        return json(409, { detail: 'Username already taken', errorCode: 'username_taken' });
      }
      user.username = username;
      return json(200, user);
    }
    case 'GET /api/me/preferences':
      return json(200, preferences);
    case 'PUT /api/me/preferences':
      preferences = JSON.parse(request.postData());
      return json(200, preferences);
    case 'GET /api/speech/voices':
      return json(200, voices);
    case 'POST /api/speech/synthesis':
      return route.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav() });
    case 'POST /api/auth/logout':
      return route.fulfill({ status: 204 });
    default:
      return json(404, { detail: `not stubbed: ${call}` });
  }
}

// --- The walk --------------------------------------------------------------------

async function main() {
  const apiBase = readApiBase();
  fs.mkdirSync(screenshotDir, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lamiss-popup-e2e-'));
  const headed = process.env.LAMISS_E2E_HEADED === '1';

  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: pickBrowser(),
    headless: !headed,
    viewport: { width: 360, height: 600 },
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages'],
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
      '--no-default-browser-check',
      ...(headed ? [] : ['--headless=new'])
    ]
  });

  const failures = [];
  const check = (condition, message) => {
    console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
    if (!condition) {
      failures.push(message);
    }
  };

  try {
    await context.route(`${apiBase}/**`, route => answerBackend(route, apiBase));
    // A stand-in YouTube watch page: the real content script runs on it.
    await context.route('https://www.youtube.com/**', route => route.request().resourceType() === 'document'
      ? route.fulfill({ status: 200, contentType: 'text/html', body: YOUTUBE_STUB })
      : route.abort());

    let worker = context.serviceWorkers()[0];
    worker ??= await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extensionId = new URL(worker.url()).host;
    const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;

    const youtube = await context.newPage();
    await youtube.goto(VIDEO_URL);

    // The in-page button's logo comes from the extension (web_accessible_resources).
    const pageLogo = youtube.locator('#lamiss-start-button .lamiss-start-button__logo img');
    await pageLogo.waitFor({ timeout: 10000 });
    await pageLogo.evaluate(img => img.decode().catch(() => {}));
    const logoInfo = await pageLogo.evaluate((img) => {
      const box = img.getBoundingClientRect();
      return { loaded: img.complete && img.naturalWidth > 0, width: box.width, height: box.height, alt: img.alt };
    });
    check(logoInfo.loaded, 'youtube: the button logo loads from the extension');
    check(logoInfo.width === 20 && logoInfo.height === 20, `youtube: the logo keeps 20x20 under the page's img rules (${logoInfo.width}x${logoInfo.height})`);
    check(logoInfo.alt === '', 'youtube: the logo is decorative (alt="")');
    // Copies of the button in the states the content script reaches later: the
    // loading pulse and the badge with its status dot.
    const states = await youtube.evaluate(async () => {
      const original = document.getElementById('lamiss-start-button');
      const row = document.createElement('div');
      row.id = 'lamiss-e2e-states';
      row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;padding:8px;background:#0f0f0f';
      const copy = (attributes) => {
        const button = original.cloneNode(true);
        button.removeAttribute('id');
        Object.entries(attributes).forEach(([name, value]) => button.setAttribute(name, value));
        row.append(button);
        return button;
      };
      const plain = copy({});
      const loading = copy({ 'data-state': 'loading' });
      const badge = copy({ 'data-state': 'ready', 'data-badge': 'monitoring' });
      document.body.append(row);
      await Promise.all([...row.querySelectorAll('img')].map(img => img.decode().catch(() => {})));
      const logoOf = button => button.querySelector('.lamiss-start-button__logo');
      const dot = badge.querySelector('.lamiss-start-button__dot');
      const dotBox = dot.getBoundingClientRect();
      const logoBox = logoOf(badge).getBoundingClientRect();
      return {
        plainAnimation: getComputedStyle(logoOf(plain)).animationName,
        loadingAnimation: getComputedStyle(logoOf(loading)).animationName,
        dotShown: getComputedStyle(dot).display !== 'none' && dotBox.width > 0,
        dotOnLogo: dotBox.right > logoBox.left + logoBox.width / 2 && dotBox.bottom > logoBox.top + logoBox.height / 2
      };
    });
    check(states.loadingAnimation === 'lamiss-start-button-pulse' && states.plainAnimation === 'none', `youtube: the logo pulses while loading (${states.loadingAnimation})`);
    check(states.dotShown && states.dotOnLogo, 'youtube: the badge shows its status dot on the logo');
    const pageShot = path.join(screenshotDir, '00-youtube-button.png');
    await youtube.locator('#lamiss-e2e-states').screenshot({ path: pageShot });
    console.log(`     screenshot ${pageShot}`);
    await youtube.evaluate(() => document.getElementById('lamiss-e2e-states').remove());

    const popup = await context.newPage();
    popup.on('console', (message) => {
      if (message.type() === 'error') {
        console.log(`  [popup console] ${message.text()}`);
      }
    });
    popup.on('pageerror', error => failures.push(`page error: ${error.message}`));
    // A real popup's active tab is the page under it; here the popup is a tab
    // itself, so "the active tab" is pointed at the YouTube tab.
    await popup.addInitScript(() => {
      const query = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async (info) => info.active && info.currentWindow
        ? query({ url: 'https://www.youtube.com/*' })
        : query(info);
    });

    const shot = async (name) => {
      await popup.waitForTimeout(250);
      const file = path.join(screenshotDir, `${name}.png`);
      await popup.screenshot({ path: file, fullPage: true });
      console.log(`     screenshot ${file}`);
    };
    // The rest of a view that scrolls inside the 600 px popup.
    const shotBottom = async (name, viewName) => {
      await view(viewName).locator('.view-body').evaluate(body => body.scrollTo(0, body.scrollHeight));
      await shot(name);
      await view(viewName).locator('.view-body').evaluate(body => body.scrollTo(0, 0));
    };
    const view = name => popup.locator(`.view[data-view="${name}"]`);
    const back = async (name) => {
      await view(name).locator('[data-back]').click();
      check(await view('home').isVisible(), `${name}: back arrow returns home`);
    };

    // Signed out.
    await popup.goto(popupUrl);
    await popup.waitForSelector('#statusText:not(:has-text("Checking"))');
    check(await popup.locator('#signInCard').isVisible(), 'signed out: the sign-in card shows');
    check(await popup.locator('.category[data-open="tutor"]').isDisabled(), 'signed out: Tutor Behavior needs the account');
    check(await popup.locator('#startButton').isDisabled(), 'signed out: Start Learning is disabled');
    await shot('01-home-signed-out');

    // Signed in: the token the worker would have stored.
    await popup.evaluate(async () => {
      await chrome.storage.session.set({
        lamissAuth: {
          accessToken: 'e2e-token',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          user: { id: 7, email: 'daniel@example.com', username: 'daniel' }
        }
      });
    });
    await popup.reload();
    await popup.waitForSelector('#statusDot[data-tone="ready"]', { timeout: 10000 });
    check((await popup.locator('#statusText').textContent()).includes('Ready on this video'), 'home: status says ready on the YouTube video');
    check(await popup.locator('#startButton').isEnabled(), 'home: Start Learning is enabled');
    await shot('02-home');

    // Double Captions.
    await popup.locator('.category[data-open="captions"]').click();
    check(await view('captions').locator('.badge').isVisible(), 'captions: shows Coming soon');
    check(await view('captions').locator('input, select').count() === 0, 'captions: no controls that pretend to work');
    await shot('03-double-captions');
    await back('captions');

    // Audio & Voice.
    await popup.locator('.category[data-open="audio"]').click();
    await popup.waitForSelector('#voiceSelect:not([disabled])', { timeout: 10000 });
    const voiceOptions = await popup.locator('#voiceSelect option').allTextContents();
    check(voiceOptions.length === 4 && voiceOptions.includes('Bella') && !voiceOptions.includes('Dora'), `audio: English voices only (${voiceOptions.join(', ')})`);
    await shot('04-audio');
    await popup.locator('#micTestButton').click();
    await popup.waitForTimeout(1200);
    const micOptions = await popup.locator('#micSelect option').count();
    check(micOptions >= 2, `audio: microphones listed after the permission (${micOptions - 1})`);
    check(await popup.locator('#micMeter span[data-on="true"]').count() > 0, 'audio: the level meter moves with the fake microphone');
    await shot('05-audio-mic-test');
    await popup.locator('#micTestButton').click();
    await popup.locator('#voiceSelect').selectOption('af_bella');
    await popup.waitForSelector('#audioSaveState[data-tone="saved"]');
    check(preferences.voice.voiceId === 'af_bella', 'audio: the voice is saved with PUT');
    await popup.locator('#voicePreviewButton').click();
    await popup.waitForSelector('#voiceMessage:has-text("Playing")', { timeout: 10000 });
    check(backendCalls.some(call => call.call === 'POST /api/speech/synthesis' && JSON.parse(call.body).language === 'en'), 'audio: preview synthesizes an English phrase');
    await popup.locator('#volumeInput').fill('60');
    await popup.locator('#volumeInput').dispatchEvent('change');
    await popup.waitForTimeout(200);
    const devices = await popup.evaluate(async () => (await chrome.storage.local.get('lamissDeviceSettings')).lamissDeviceSettings);
    check(devices?.volume === 0.6, `audio: volume kept locally (${JSON.stringify(devices)})`);
    await shotBottom('06-audio-saved', 'audio');
    await back('audio');

    // The OpenAI provider: one voice, shown read-only, and no speed slider that does nothing.
    voices = openaiVoices;
    await popup.locator('.category[data-open="audio"]').click();
    await popup.waitForSelector('#voiceReadOnly:not([hidden])', { timeout: 10000 });
    check(await popup.locator('#voiceSelect').isHidden(), 'audio (openai): no voice choice');
    check(await popup.locator('#speedInput').isDisabled(), 'audio (openai): the speed slider is disabled');
    check(await popup.locator('#voicePreviewButton').isEnabled(), 'audio (openai): preview still works');
    await shot('06b-audio-openai');
    voices = kokoroVoices;
    await back('audio');

    // Tutor Behavior.
    await popup.locator('.category[data-open="tutor"]').click();
    await popup.waitForSelector('#tutorForm:not([hidden])');
    check(await popup.locator('[data-segment="kindness"] [aria-pressed="true"]').getAttribute('data-value') === 'BALANCED', 'tutor: kindness shows the saved value');
    await shot('07-tutor');
    await popup.locator('[data-segment="kindness"] [data-value="GENTLE"]').click();
    await popup.waitForSelector('#tutorSaveState[data-tone="saved"]');
    check(preferences.tutor.kindness === 'GENTLE', 'tutor: kindness saved with PUT');
    await popup.locator('[data-segment="frequency"] [data-value="MORE"]').click();
    await popup.waitForTimeout(200);
    const questions = await popup.evaluate(async () => (await chrome.storage.local.get('lamissQuestionSettings')).lamissQuestionSettings);
    check(questions?.minSecondsBetweenQuestions === 60 && questions.difficulty === 'MEDIUM', `tutor: More questions = 60 s, difficulty untouched (${JSON.stringify(questions)})`);
    await popup.locator('#explanationSelect').selectOption('es');
    await popup.waitForSelector('#tutorSaveState[data-tone="saved"]');
    check(preferences.tutor.explanationLanguage === 'es', 'tutor: explanation language saved');
    check(await popup.locator('#autoPauseInput').isChecked(), 'tutor: auto-pause shows on (not set reads back true)');
    await popup.locator('#autoPauseInput').click();
    await popup.waitForSelector('#tutorSaveState[data-tone="saved"]');
    const lastPut = () => JSON.parse(backendCalls.filter(call => call.call === 'PUT /api/me/preferences').at(-1).body);
    check(lastPut().tutor.autoPause === false && preferences.tutor.autoPause === false, 'tutor: auto-pause off saved with PUT (tutor.autoPause: false)');
    check((await popup.locator('#autoPauseHint').textContent()).includes('keeps playing'), 'tutor: the hint says the video keeps playing');
    await shotBottom('08-tutor-saved', 'tutor');
    await popup.locator('#autoPauseInput').click();
    await popup.waitForSelector('#tutorSaveState[data-tone="saved"]');
    check(lastPut().tutor.autoPause === true, 'tutor: auto-pause back on saved with PUT');
    await shotBottom('08b-tutor-auto-pause-on', 'tutor');
    await back('tutor');

    // Profile & Account.
    await popup.locator('.category[data-open="profile"]').click();
    await popup.waitForSelector('#profilePreferences:not([hidden])');
    check(await popup.locator('#profileName').textContent() === 'Daniel Sanchez', 'profile: display name from /api/auth/me');
    check(await popup.locator('#profileInitials').textContent() === 'DS', 'profile: initials without a picture');
    await popup.locator('#levelSelect').selectOption('B2');
    await popup.waitForSelector('#profileSaveState[data-tone="saved"]');
    check(preferences.proficiencyLevel === 'B2', 'profile: level saved');
    check(await popup.locator('#profileProgress').isHidden(), 'profile: no progress without a daily goal');
    check(await popup.locator('#dailyGoalValue').textContent() === 'Off', 'profile: daily goal shows Off');
    const goalOptions = await popup.locator('#goalSelect option').allTextContents();
    check(goalOptions.join(',') === 'Not set,Conversation,Vocabulary,Grammar,Listening,Pronunciation', `profile: learning goals (${goalOptions.join(', ')})`);
    await shot('09-profile');

    // Learning goal and daily goal.
    const putCount = () => backendCalls.filter(call => call.call === 'PUT /api/me/preferences').length;
    let before = putCount();
    await popup.locator('#goalSelect').selectOption('CONVERSATION');
    await popup.waitForSelector('#profileSaveState[data-tone="saved"]');
    check(putCount() === before + 1 && lastPut().learningGoal === 'CONVERSATION', 'profile: learning goal saved with PUT (learningGoal: CONVERSATION)');
    before = putCount();
    // fill() fires input and change, like letting go of the thumb.
    await popup.locator('#dailyGoalInput').fill('30');
    await popup.waitForSelector('#profileProgress:not([hidden])', { timeout: 10000 });
    check(putCount() === before + 1 && lastPut().dailyGoalMinutes === 30 && lastPut().learningGoal === 'CONVERSATION', `profile: daily goal saved with PUT (dailyGoalMinutes: 30), the goal kept (${putCount() - before} PUT)`);
    check(await popup.locator('#dailyGoalValue').textContent() === '30 min', 'profile: the slider shows 30 min');
    check(await popup.locator('#profileProgressText').textContent() === '12 of 30 min today', `profile: progress "${await popup.locator('#profileProgressText').textContent()}"`);
    const practiceCall = backendCalls.filter(call => call.call === 'GET /api/me/practice/today').at(-1);
    const browserZone = await popup.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    check(practiceCall?.timeZone === browserZone, `profile: today's practice asked for in the browser's time zone (${practiceCall?.timeZone})`);
    const progressWidth = await popup.locator('#profileProgressFill').evaluate(fill => fill.style.width);
    check(progressWidth === '40%', `profile: progress bar at 40% (${progressWidth})`);
    await shotBottom('09b-profile-goals', 'profile');

    // Username: the rules, a taken name, then a new one.
    await popup.locator('#profileEditButton').click();
    check(await popup.locator('#usernameForm').isVisible(), 'profile: the profile row opens the username edit');
    check(await popup.locator('#usernameInput').inputValue() === 'daniel', 'profile: the edit starts from the current username');
    const patches = () => backendCalls.filter(call => call.call === 'PATCH /api/me/profile');
    await popup.locator('#usernameInput').fill('da');
    await popup.locator('#usernameSaveButton').click();
    check(await popup.locator('#usernameMessage').textContent() === 'Use 3–20 letters, numbers or underscores.' && patches().length === 0, 'profile: a too-short username is refused before any PATCH');
    await popup.locator('#usernameInput').fill(TAKEN_USERNAME);
    await popup.locator('#usernameSaveButton').click();
    await popup.waitForSelector('#usernameMessage:has-text("taken")', { timeout: 10000 });
    check(await popup.locator('#usernameMessage').textContent() === 'That username is already taken. Try another one.', 'profile: 409 username_taken shows a friendly message');
    check(await popup.locator('#usernameForm').isVisible(), 'profile: the edit stays open after a 409');
    await shot('09c-profile-username-taken');
    await popup.locator('#usernameInput').fill('daniel_s');
    await popup.locator('#usernameSaveButton').click();
    await popup.waitForSelector('#usernameForm[hidden]', { state: 'attached', timeout: 10000 });
    check(JSON.parse(patches().at(-1).body).username === 'daniel_s', 'profile: PATCH /api/me/profile carries the new username');
    check(await popup.locator('#profileUsername').textContent() === '@daniel_s', 'profile: the new username shows after the 200');
    await shot('09d-profile-username-saved');
    await back('profile');

    // Home: today's progress, compact.
    await popup.waitForSelector('#homeProgress:not([hidden])', { timeout: 10000 });
    check(await popup.locator('#homeProgressText').textContent() === '12 of 30 min today', 'home: today\'s progress under Start Learning');
    await shot('09e-home-progress');

    // A 400 shows the backend's message.
    await popup.route(`${apiBase}/api/me/preferences`, route => route.request().method() === 'PUT'
      ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ detail: 'Unknown language code', errorCode: 'invalid_preferences' }) })
      : route.fallback());
    await popup.locator('.category[data-open="tutor"]').click();
    await popup.locator('[data-segment="responseLength"] [data-value="SHORT"]').click();
    await popup.waitForSelector('#tutorSaveState[data-tone="error"]');
    check(await view('tutor').locator('[data-save-error]').textContent() === 'Not saved: Unknown language code', 'tutor: a 400 shows the backend message');
    check(await popup.locator('[data-segment="responseLength"] [aria-pressed="true"]').getAttribute('data-value') === 'NORMAL', 'tutor: a failed save goes back to the saved value');
    await shot('10-tutor-error');
    await popup.unroute(`${apiBase}/api/me/preferences`);
    await back('tutor');

    // Log out → signed-out home.
    await popup.locator('.category[data-open="profile"]').click();
    await popup.locator('#signOutButton').click();
    await popup.waitForSelector('#signInCard:not([hidden])', { timeout: 10000 });
    check(await view('home').isVisible(), 'log out: back to the signed-out home');
    await shot('11-logged-out');

    // Unreachable backend.
    await popup.evaluate(async () => {
      await chrome.storage.session.set({
        lamissAuth: { accessToken: 'e2e-token', expiresAt: new Date(Date.now() + 3600_000).toISOString(), user: { id: 7, email: 'daniel@example.com', username: 'daniel' } }
      });
    });
    await context.unroute(`${apiBase}/**`);
    await context.route(`${apiBase}/**`, route => route.abort('connectionrefused'));
    await popup.reload();
    await popup.waitForSelector('#statusDot[data-tone="error"]', { timeout: 10000 });
    check(true, `unreachable: "${await popup.locator('#statusText').textContent()}"`);
    await shot('12-backend-down');

    check(backendCalls.filter(call => call.call !== 'POST /api/auth/logout').every(call => call.authorized), 'every backend call carried the token');
    // TDR-0002: a PUT always carries the required fields, codes lowercase and enums uppercase.
    const puts = backendCalls.filter(call => call.call === 'PUT /api/me/preferences').map(call => JSON.parse(call.body));
    const code = value => value === null || /^[a-z]{2}$/.test(value);
    check(puts.length > 0 && puts.every(body => body.tutor && body.voice
      && ['GENTLE', 'BALANCED', 'STRICT'].includes(body.tutor.kindness)
      && ['SHORT', 'NORMAL', 'DETAILED'].includes(body.tutor.responseLength)
      && typeof body.tutor.encouragement === 'boolean'
      && typeof body.voice.speed === 'number' && body.voice.speed >= 0.5 && body.voice.speed <= 2
      && code(body.nativeLanguage) && code(body.learningLanguage) && code(body.tutor.explanationLanguage)
      && (body.proficiencyLevel === null || /^[ABC][12]$/.test(body.proficiencyLevel))
      && (body.learningGoal == null || ['CONVERSATION', 'VOCABULARY', 'GRAMMAR', 'LISTENING', 'PRONUNCIATION'].includes(body.learningGoal))
      && (body.dailyGoalMinutes == null || (Number.isInteger(body.dailyGoalMinutes) && body.dailyGoalMinutes >= 5 && body.dailyGoalMinutes <= 240))
      && (body.tutor.autoPause === undefined || typeof body.tutor.autoPause === 'boolean')), `every PUT is a complete TDR-0002 body (${puts.length})`);
    check(backendCalls.filter(call => call.call === 'GET /api/me/practice/today').length > 0, 'practice: read with a time zone the stub accepted');
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed:\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`\nAll checks passed. Screenshots in ${screenshotDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
