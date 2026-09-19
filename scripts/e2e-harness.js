#!/usr/bin/env node
/**
 * Manual E2E harness for the Lamiss YouTube Transcript POC extension.
 * Drives a real installed Chrome (via Playwright's `channel: 'chrome'`, no
 * bundled-browser download needed) with the compiled/ extension loaded,
 * exercises the popup like a user would, and prints the extension's own
 * "Lamiss POC: ..." diagnostic log lines plus the final popup status.
 *
 * Usage:
 *   node harness.js [videoUrl] [language] [navClick]
 *
 *   videoUrl  - YouTube watch URL to open (default: known-good baseline video)
 *   language  - language code to request (default: es)
 *   navClick  - pass the literal string "nav-click" to, after loading the
 *               first video, click a related/recommended video link inside
 *               the page (client-side nav, no full reload) before invoking
 *               Load Transcript. Used to reproduce SPA-navigation staleness.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = 'C:\\Users\\perro\\Documents\\GitHub\\lamiss-youtube-transcript-poc';
const EXT_PATH = path.join(ROOT, 'compiled');

const VIDEO_URL = process.argv[2] || 'https://www.youtube.com/watch?v=LeRylkDym54';
const LANGUAGE = process.argv[3] || 'es';
const NAV_CLICK = process.argv[4] === 'nav-click';

function ts() {
  return new Date().toISOString().split('T')[1].replace('Z', '');
}

(async () => {
  const userDataDir = path.join(os.tmpdir(), 'lamiss-ext-profile-' + Date.now());
  fs.mkdirSync(userDataDir, { recursive: true });

  console.log(`[${ts()}] launching Chrome with extension from ${EXT_PATH}`);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages'],
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const allWorkerLogs = [];
  const attachWorker = (worker) => {
    console.log(`[${ts()}] service worker registered: ${worker.url()}`);
    worker.on('console', (msg) => allWorkerLogs.push('[worker] ' + msg.text()));
  };
  context.serviceWorkers().forEach(attachWorker);
  context.on('serviceworker', attachWorker);

  let worker = context.serviceWorkers()[0];
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  }
  const extensionId = worker.url().split('/')[2];
  console.log(`[${ts()}] extension id: ${extensionId}`);

  const ytPage = await context.newPage();
  const ytLogs = [];
  ytPage.on('console', (msg) => ytLogs.push('[yt] ' + msg.text()));

  console.log(`[${ts()}] navigating to ${VIDEO_URL}`);
  await ytPage.goto(VIDEO_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  try {
    await ytPage.getByRole('button', { name: /Accept all|I agree|Aceptar todo/i }).click({ timeout: 4000 });
    console.log(`[${ts()}] dismissed consent dialog`);
  } catch {
    // no consent dialog shown
  }

  await ytPage.waitForTimeout(3000);
  console.log(`[${ts()}] initial load settled at ${ytPage.url()}`);

  if (NAV_CLICK) {
    console.log(`[${ts()}] attempting client-side navigation via related-video click`);
    const before = ytPage.url();
    const currentVideoId = new URL(before).searchParams.get('v');

    // YouTube's related-video markup changes frequently (custom element
    // names get renamed across redesigns). Instead of hardcoding a
    // component selector, find any watch-page anchor that points at a
    // DIFFERENT video than the one currently loaded and dispatch a real
    // DOM click on it, which triggers YouTube's client-side router the
    // same way a user's click would.
    const clickedHref = await ytPage.evaluate((currentId) => {
      const anchors = Array.from(document.querySelectorAll('a[href*="/watch?v="]'));
      const target = anchors.find((a) => {
        const href = a.getAttribute('href') || '';
        const match = href.match(/[?&]v=([^&]+)/);
        return match && match[1] !== currentId && !href.includes('&t=');
      });
      if (!target) return null;
      target.scrollIntoView({ block: 'center' });
      target.click();
      return target.getAttribute('href');
    }, currentVideoId);

    if (!clickedHref) {
      console.log(`[${ts()}] WARNING: could not find a related-video link to click; nav-click scenario not exercised`);
    } else {
      try {
        await ytPage.waitForFunction((prev) => location.href !== prev, before, { timeout: 15000 });
        console.log(`[${ts()}] navigated via DOM click on "${clickedHref}" to ${ytPage.url()}`);
      } catch {
        console.log(`[${ts()}] WARNING: clicked "${clickedHref}" but URL did not change within 15s`);
      }
      await ytPage.waitForTimeout(3000);
    }
  }

  await ytPage.bringToFront();

  const popupPage = await context.newPage();
  const popupLogs = [];
  popupPage.on('console', (msg) => popupLogs.push('[popup] ' + msg.text()));

  console.log(`[${ts()}] opening popup page`);
  await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popupPage.selectOption('#language', LANGUAGE);

  await ytPage.bringToFront();
  await popupPage.bringToFront();
  console.log(`[${ts()}] clicking Load Transcript (language=${LANGUAGE}) with yt tab as active tab`);

  // Re-activate the yt tab right before the click without leaving popupPage,
  // since chrome.tabs.query({active:true}) reflects the browser's active-tab
  // state per window at query time, not which page Playwright is targeting.
  await ytPage.bringToFront();
  await popupPage.click('#loadTranscript');

  await popupPage
    .waitForFunction(
      () => {
        const el = document.getElementById('status');
        return el && el.textContent && el.textContent !== 'Status: Loading...';
      },
      { timeout: 20000 }
    )
    .catch(() => {});

  const statusText = await popupPage.textContent('#status');
  await ytPage.waitForTimeout(1000);

  console.log(`\n[${ts()}] === RESULT ===`);
  console.log('POPUP_STATUS: ' + statusText);

  console.log('\n--- yt page Lamiss POC logs ---');
  ytLogs.filter((l) => l.includes('Lamiss POC')).forEach((l) => console.log(l));

  console.log('\n--- background worker Lamiss POC logs ---');
  allWorkerLogs.filter((l) => l.includes('Lamiss POC')).forEach((l) => console.log(l));

  console.log('\n--- popup logs (all) ---');
  popupLogs.forEach((l) => console.log(l));

  await context.close();
})().catch((err) => {
  console.error('HARNESS_ERROR', err);
  process.exit(1);
});
