#!/usr/bin/env node
// Renders the extension icons (src/icons/icon-{16,32,48,128}.png) from the
// logo in src/brand/. Run it after changing the logo and commit the PNGs; the
// build only copies them.
//
//   node scripts/render-icons.js
//
// The logo's face is the background showing through, so on Chrome's dark
// toolbar a transparent icon would lose it: the icons put the logo on a white
// rounded square. 16 and 32 px use the small variant, whose thin gaps and eyes
// survive downscaling. The 128 px icon keeps Chrome's recommended 16 px of
// transparent padding around 96 px of artwork.
//
// LAMISS_E2E_BROWSER: the browser executable (default: Playwright's Chromium
// if installed, else Brave on macOS), as for scripts/popup-e2e.js.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const brandDir = path.join(root, 'src', 'brand');
const iconDir = path.join(root, 'src', 'icons');

// size: output size; tile: the white square's size; mark: logo file.
const ICONS = [
  { size: 16, tile: 16, mark: 'lamiss-mark-small.svg' },
  { size: 32, tile: 32, mark: 'lamiss-mark-small.svg' },
  { size: 48, tile: 48, mark: 'lamiss-logo.svg' },
  { size: 128, tile: 96, mark: 'lamiss-logo.svg' }
];
// Share of the tile the logo fills, and the tile's corner radius.
const MARK_SCALE = 0.88;
const TILE_RADIUS = 0.22;

function fail(message) {
  console.error(`render-icons: ${message}`);
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

function iconPage({ size, tile, mark }) {
  const svg = fs.readFileSync(path.join(brandDir, mark), 'utf8');
  const markSize = tile * MARK_SCALE;
  const offset = (size - tile) / 2;
  return `<!doctype html><html><body style="margin:0;background:transparent">
<div style="position:absolute;left:${offset}px;top:${offset}px;width:${tile}px;height:${tile}px;border-radius:${tile * TILE_RADIUS}px;background:#ffffff"></div>
<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" style="position:absolute;left:${(size - markSize) / 2}px;top:${(size - markSize) / 2}px;width:${markSize}px;height:${markSize}px">
</body></html>`;
}

(async () => {
  const browser = await chromium.launch({ executablePath: pickBrowser() });
  try {
    for (const icon of ICONS) {
      const page = await browser.newPage({ viewport: { width: icon.size, height: icon.size }, deviceScaleFactor: 1 });
      await page.setContent(iconPage(icon));
      await page.locator('img').evaluate(img => img.decode());
      const file = path.join(iconDir, `icon-${icon.size}.png`);
      await page.screenshot({ path: file, omitBackground: true });
      await page.close();
      console.log(`render-icons: wrote ${path.relative(root, file)}`);
    }
  } finally {
    await browser.close();
  }
})();
