const path = require('path');
const os = require('os');
const fs = require('fs');
const { chromium } = require('playwright');

const VIDEO_URLS = process.argv.slice(2);

(async () => {
  const userDataDir = path.join(os.tmpdir(), 'lamiss-survey-profile-' + Date.now());
  fs.mkdirSync(userDataDir, { recursive: true });
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  const page = await context.newPage();

  for (const videoUrl of VIDEO_URLS) {
    console.log('\n===', videoUrl, '===');
    await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try {
      await page.getByRole('button', { name: /Accept all|I agree/i }).click({ timeout: 3000 });
    } catch {}
    await page.waitForTimeout(3000);

    const tracks = await page.evaluate(() => {
      const t = window.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      return Array.isArray(t) ? t.map(x => ({ lang: x.languageCode, kind: x.kind || 'standard', baseUrl: x.baseUrl })) : null;
    });

    if (!tracks) {
      console.log('No captionTracks found for this video.');
      continue;
    }
    console.log('Tracks:', tracks.map(t => `${t.lang}(${t.kind})`).join(', '));

    for (const track of tracks.slice(0, 4)) {
      const result = await page.evaluate(async (baseUrl) => {
        const url = new URL(baseUrl);
        url.searchParams.set('fmt', 'json3');
        const res = await fetch(url.toString(), { credentials: 'include' });
        const text = await res.text();
        return { status: res.status, contentType: res.headers.get('content-type'), textLength: text.length };
      }, track.baseUrl);
      console.log(`  ${track.lang}(${track.kind}): status=${result.status} contentType=${result.contentType} textLength=${result.textLength}`);
    }
  }

  await context.close();
})().catch(e => { console.error('ERR', e); process.exit(1); });
