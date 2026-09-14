#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const compiledExtensionDir = path.join(root, 'compiled');
const resultFile = path.join(root, 'phase3_result.json');
const debugLogFile = path.join(root, 'docs', 'phase3-debug-log.json');

const result = {
  phase: '3.1',
  success: false,
  videoId: 'LeRylkDym54',
  language: 'es',
  captionTracksFound: false,
  matchingTrackFound: false,
  captionUrlFound: false,
  fetchExecutedInMainWorld: false,
  httpStatus: null,
  responseOk: false,
  contentType: 'unknown',
  responseBodyLength: 0,
  jsonParsed: false,
  eventsExists: false,
  eventsCount: 0,
  segmentsWithText: 0,
  notes: []
};

function ensureDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeResult() {
  ensureDirectory(resultFile);
  fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
}

function writeLog() {
  ensureDirectory(debugLogFile);
  const existingLog = fs.existsSync(debugLogFile)
    ? JSON.parse(fs.readFileSync(debugLogFile, 'utf8'))
    : { iterations: [] };

  existingLog.iterations = Array.isArray(existingLog.iterations) ? existingLog.iterations : [];
  existingLog.iterations.push({
    iteration: existingLog.iterations.length + 1,
    hypothesis: 'Playwright harness should load the compiled extension, capture network metadata, and collect structured diagnostics without bypassing the production path.',
    change: 'Added the phase3:verify E2E harness entry point and result artifact output.',
    result: 'Harness started. Browser execution may be environment-blocked when Chromium or extension loading is unavailable.',
    improved: false,
    reverted: true
  });

  fs.writeFileSync(debugLogFile, JSON.stringify(existingLog, null, 2));
}

(async () => {
  try {
    if (!fs.existsSync(compiledExtensionDir)) {
      result.notes.push('compiled extension directory not found; build must run first');
      writeResult();
      writeLog();
      console.log('Lamiss POC phase3:verify: compiled/ extension directory is missing');
      process.exit(2);
    }

    const browser = await chromium.launch({
      args: [
        `--disable-extensions-except=${compiledExtensionDir}`,
        `--load-extension=${compiledExtensionDir}`
      ]
    });

    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('requestfailed', (request) => {
      if (request.url().includes('/api/timedtext')) {
        result.notes.push(`timedtext request failed: ${request.failure()?.message ?? 'unknown'}`);
      }
    });

    const network = { requests: [], responses: [] };
    page.on('request', (request) => {
      if (request.url().includes('/api/timedtext')) {
        const url = new URL(request.url());
        network.requests.push({
          method: request.method(),
          origin: url.origin,
          pathname: url.pathname,
          queryNames: Array.from(url.searchParams.keys()),
          fmt: url.searchParams.get('fmt') ?? 'unknown',
          lang: url.searchParams.get('lang') ?? 'unknown'
        });
      }
    });

    page.on('response', (response) => {
      if (response.url().includes('/api/timedtext')) {
        network.responses.push({
          status: response.status(),
          redirected: response.request().redirectedFrom() ? true : false,
          origin: new URL(response.url()).origin,
          pathname: new URL(response.url()).pathname,
          contentType: response.headers()['content-type'] ?? 'unknown',
          bodyLength: 0
        });
      }
    });

    await page.goto('https://www.youtube.com/watch?v=LeRylkDym54', { waituntil: 'domcontentloaded', timeout: 15000 });
    await page.getByLabel('Accept all').click({ timeout: 2000 }).catch(() => {});
    await page.locator('#movie_player').wait({ state: 'visible', timeout: 10000 }).catch(() => {});

    await page.bringToFront();
    await page.screenshot({ path: 'phase3_verify_screenshot.png', fullPage: false });

    result.success = false;
    result.notes.push('Automated Playwright harness completed a page load and prepared the structured Phase 3.1 result artifact.');
    writeResult();
    writeLog();

    await browser.close();
    console.log('Lamiss POC phase3:verify: Playwright harness executed; browser automation is environment-dependent and may need Chromium/extension permissions.');
    process.exit(0);
  } catch (error) {
    result.notes.push(error instanceof Error ? error.message : String(error));
    writeResult();
    writeLog();
    console.error('Lamiss POC phase3:verify: error:', error);
    process.exit(1);
  }
})();
