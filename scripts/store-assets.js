#!/usr/bin/env node
// Makes the Chrome Web Store images in store/assets/ (store/listing.md):
// 1280x800 screenshots that frame the popup screenshots taken by
// scripts/popup-e2e.js, and the 440x280 small promo tile.
//
//   npm run build && node scripts/popup-e2e.js /tmp/lamiss-shots
//   node scripts/store-assets.js /tmp/lamiss-shots
//
// LAMISS_E2E_BROWSER: the browser executable, as for scripts/popup-e2e.js.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'store', 'assets');
const shotsDir = process.argv[2];

// Which popup screenshot each store screenshot shows, and what it says.
const SCREENSHOTS = [
  { file: '02-home.png', out: 'screenshot-1-home.jpg', title: 'Your AI language tutor on YouTube', text: 'Open a video, press Start Learning, and LAMISS practices with you while you watch.' },
  { file: '07-tutor.png', out: 'screenshot-2-tutor.jpg', title: 'A tutor that speaks your way', text: 'Kindness, question frequency, answer length, and a tutor language independent of the video.' },
  { file: '02c-recent-videos.png', out: 'screenshot-3-recent.jpg', title: 'Pick up where you left off', text: 'Your recent videos, where you stopped, and how many questions you answered.' },
  { file: '02b-home-spanish.png', out: 'screenshot-4-languages.jpg', title: 'In your language', text: 'English, Español, Français, Deutsch or Português: one tap on a flag.' },
  { file: '04-audio.png', out: 'screenshot-5-voice.jpg', title: 'Speak your answers', text: 'Choose your microphone, speaker and the tutor’s voice and speed.' }
];

function fail(message) {
  console.error(`store-assets: ${message}`);
  process.exit(1);
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

const dataUrl = (file, type) => `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
const escapeHtml = text => text.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);

const BASE_STYLE = `
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #1e1638;
    background: radial-gradient(1200px 700px at 15% 10%, #efe6ff 0%, #f8f5ff 55%, #fbf9ff 100%); }`;

function screenshotPage(shot, logo) {
  return `<!doctype html><html><head><style>${BASE_STYLE}
  .frame { width: 1280px; height: 800px; display: flex; align-items: center; gap: 72px; padding: 0 96px; }
  .copy { flex: 1; }
  .brand { display: flex; align-items: center; gap: 12px; font-weight: 800; letter-spacing: 2px; color: #7c3aed; font-size: 22px; }
  .brand img { width: 56px; height: 56px; }
  h1 { margin: 28px 0 16px; font-size: 52px; line-height: 1.08; letter-spacing: -0.5px; }
  p { margin: 0; font-size: 24px; line-height: 1.4; color: #6c6587; max-width: 560px; }
  .popup { width: 360px; height: 600px; overflow: hidden; border-radius: 22px; background: #fff;
    box-shadow: 0 30px 80px rgba(66, 29, 144, 0.25), 0 0 0 1px rgba(124, 58, 237, 0.12); }
  .popup img { display: block; width: 360px; }
  </style></head><body><div class="frame">
    <div class="copy"><div class="brand"><img src="${logo}" alt="">LAMISS</div>
      <h1>${escapeHtml(shot.title)}</h1><p>${escapeHtml(shot.text)}</p></div>
    <div class="popup"><img src="${dataUrl(path.join(shotsDir, shot.file), 'image/png')}" alt=""></div>
  </div></body></html>`;
}

function promoPage(logo) {
  return `<!doctype html><html><head><style>${BASE_STYLE}
  .tile { width: 440px; height: 280px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;
    background: linear-gradient(135deg, #7c3aed 0%, #8b5cf6 60%, #c084fc 100%); color: #fff; }
  .logo { width: 104px; height: 104px; border-radius: 26px; background: #fff; display: grid; place-items: center; box-shadow: 0 10px 30px rgba(30, 10, 80, 0.3); }
  .logo img { width: 88px; height: 88px; }
  h1 { margin: 16px 0 4px; font-size: 34px; letter-spacing: 4px; }
  p { margin: 0; font-size: 17px; opacity: 0.92; }
  </style></head><body><div class="tile"><div class="logo"><img src="${logo}" alt=""></div>
    <h1>LAMISS</h1><p>Your AI language tutor on YouTube</p></div></body></html>`;
}

(async () => {
  if (!shotsDir || !fs.existsSync(shotsDir)) {
    fail('usage: node scripts/store-assets.js <screenshot dir from scripts/popup-e2e.js>');
  }
  for (const shot of SCREENSHOTS) {
    if (!fs.existsSync(path.join(shotsDir, shot.file))) {
      fail(`missing ${shot.file} in ${shotsDir}: run scripts/popup-e2e.js into it first`);
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  const logo = dataUrl(path.join(root, 'src', 'brand', 'lamiss-logo.svg'), 'image/svg+xml');
  const browser = await chromium.launch({ executablePath: pickBrowser() });
  try {
    const render = async (html, width, height, out) => {
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      await page.setContent(html);
      await page.evaluate(() => Promise.all([...document.images].map(image => image.decode().catch(() => {}))));
      const file = path.join(outDir, out);
      // JPEG: the store wants images without an alpha channel.
      await page.screenshot({ path: file, type: 'jpeg', quality: 92 });
      await page.close();
      console.log(`store-assets: wrote ${path.relative(root, file)}`);
    };
    for (const shot of SCREENSHOTS) {
      await render(screenshotPage(shot, logo), 1280, 800, shot.out);
    }
    await render(promoPage(logo), 440, 280, 'promo-small-440x280.jpg');
  } finally {
    await browser.close();
  }
})();
