// Uploads a packaged ZIP to an existing Chrome Web Store item and, only when
// asked, submits it for review (docs/RELEASING.md):
//
//   node scripts/cws-publish.js dist/lamiss-0.2.0-production.zip [--publish] [--target default|trustedTesters]
//
// Credentials come from the environment (GitHub Actions secrets), never from
// files: CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN (an OAuth client
// with the chromewebstore scope) and CWS_EXTENSION_ID (the store item's ID).
// The item must already exist: the first upload, the listing and the privacy
// form are done once by hand in the Developer Dashboard.
//
// Uses the Chrome Web Store API v1.1. Not yet run against a real store item
// (no credentials when it was written): see docs/RELEASING.md before the
// first automated release.
'use strict';

const fs = require('fs');
const path = require('path');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/chromewebstore/v1.1';
const UPLOAD_API = 'https://www.googleapis.com/upload/chromewebstore/v1.1';
const TARGETS = ['default', 'trustedTesters'];

function required(env, name) {
  const value = (env[name] ?? '').trim();
  if (!value) {
    throw new Error(`${name} is not set (a GitHub Actions secret of the chrome-web-store environment)`);
  }
  return value;
}

async function accessToken(env, fetchImpl) {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: required(env, 'CWS_CLIENT_ID'),
      client_secret: required(env, 'CWS_CLIENT_SECRET'),
      refresh_token: required(env, 'CWS_REFRESH_TOKEN'),
      grant_type: 'refresh_token'
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    // The response never contains the secrets; its error code is enough.
    throw new Error(`could not get an access token (HTTP ${response.status}: ${body.error ?? 'no error code'})`);
  }
  return body.access_token;
}

/**
 * Uploads zipBytes to the item, waits for the store to process it and, with
 * publish, submits it for review to the target. Returns what happened.
 * log: where to report progress; fetchImpl and sleep are replaced in tests.
 */
async function releaseToChromeWebStore({ zipBytes, env, publish = false, target = 'default', fetchImpl = fetch, log = console.log, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!TARGETS.includes(target)) {
    throw new Error(`--target must be one of ${TARGETS.join(', ')}`);
  }
  const itemId = required(env, 'CWS_EXTENSION_ID');
  if (!/^[a-p]{32}$/.test(itemId)) {
    throw new Error('CWS_EXTENSION_ID is not a Chrome extension ID (32 letters a-p)');
  }
  const token = await accessToken(env, fetchImpl);
  const headers = { Authorization: `Bearer ${token}`, 'x-goog-api-version': '2' };

  const upload = await fetchImpl(`${UPLOAD_API}/items/${itemId}?uploadType=media`, { method: 'PUT', headers, body: zipBytes });
  let state = await upload.json().catch(() => ({}));
  if (!upload.ok) {
    throw new Error(`upload refused (HTTP ${upload.status}): ${JSON.stringify(state.error ?? state)}`);
  }
  for (let attempt = 0; state.uploadState === 'IN_PROGRESS' && attempt < 30; attempt += 1) {
    await sleep(10_000);
    const check = await fetchImpl(`${API}/items/${itemId}?projection=DRAFT`, { headers });
    state = await check.json().catch(() => ({}));
  }
  if (state.uploadState !== 'SUCCESS') {
    throw new Error(`the store did not accept the package (${state.uploadState ?? 'no state'}): ${JSON.stringify(state.itemError ?? [])}`);
  }
  log(`Chrome Web Store: package uploaded to item ${itemId} as a draft.`);
  if (!publish) {
    log('Chrome Web Store: not submitted for review (run with --publish to submit).');
    return { uploaded: true, submitted: false };
  }

  const submitted = await fetchImpl(`${API}/items/${itemId}/publish?publishTarget=${target}`, { method: 'POST', headers: { ...headers, 'Content-Length': '0' } });
  const result = await submitted.json().catch(() => ({}));
  const statuses = result.status ?? [];
  if (!submitted.ok || !statuses.some(status => status === 'OK' || status === 'ITEM_PENDING_REVIEW')) {
    throw new Error(`submission refused (HTTP ${submitted.status}): ${JSON.stringify(statuses)} ${JSON.stringify(result.statusDetail ?? [])}`);
  }
  log(`Chrome Web Store: submitted for review to "${target}" (${statuses.join(', ')}). It is published only once Google approves it.`);
  return { uploaded: true, submitted: true, statuses };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const zipPath = args.find(arg => !arg.startsWith('--') && arg !== args[args.indexOf('--target') + 1]);
  const targetFlag = args.indexOf('--target');
  if (!zipPath || !fs.existsSync(zipPath) || path.extname(zipPath) !== '.zip') {
    console.error('Usage: node scripts/cws-publish.js <package.zip> [--publish] [--target default|trustedTesters]');
    process.exit(1);
  }
  releaseToChromeWebStore({
    zipBytes: fs.readFileSync(zipPath),
    env: process.env,
    publish: args.includes('--publish'),
    target: targetFlag >= 0 ? args[targetFlag + 1] : 'default'
  }).catch((error) => {
    console.error(`Chrome Web Store: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { releaseToChromeWebStore };
