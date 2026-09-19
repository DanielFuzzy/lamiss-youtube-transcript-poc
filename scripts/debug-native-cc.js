const path = require('path');
const os = require('os');
const fs = require('fs');
const { chromium } = require('playwright');

const VIDEO_URL = process.argv[2] || 'https://www.youtube.com/watch?v=I4YLB-qpmzw';

(async () => {
  const userDataDir = path.join(os.tmpdir(), 'lamiss-cc-' + Date.now());
  fs.mkdirSync(userDataDir, { recursive: true });
  const context = await chromium.launchPersistentContext(userDataDir, { headless: false });
  const page = await context.newPage();

  const captured = [];
  page.on('request', (req) => {
    if (req.url().includes('timedtext')) {
      captured.push({ phase: 'request', url: req.url(), headers: req.headers() });
    }
  });
  page.on('response', async (res) => {
    if (res.url().includes('timedtext')) {
      let sample = null;
      try {
        const buf = await res.body();
        sample = buf.toString('utf8').slice(0, 200);
      } catch (e) {
        sample = 'ERR:' + e.message;
      }
      captured.push({ phase: 'response', status: res.status(), contentType: res.headers()['content-type'], bodySample: sample, bodyLength: sample ? sample.length : 0, url: res.url().slice(0, 150) });
    }
  });

  await page.goto(VIDEO_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  try { await page.getByRole('button', { name: /Accept all|I agree/i }).click({ timeout: 3000 }); } catch {}
  await page.waitForTimeout(3000);

  // Click the native CC / subtitles toggle button in the player controls.
  try {
    await page.locator('.ytp-subtitles-button').click({ timeout: 5000 });
    console.log('Clicked native CC toggle button');
  } catch (e) {
    console.log('Could not click .ytp-subtitles-button:', e.message.split('\n')[0]);
  }

  await page.waitForTimeout(4000);

  console.log('\nCaptured timedtext traffic:');
  captured.forEach((c) => console.log(JSON.stringify(c, null, 2)));

  if (captured.length === 0) {
    console.log('No timedtext requests observed after enabling captions.');
  }

  await context.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });
