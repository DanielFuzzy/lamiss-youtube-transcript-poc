const path = require('path');
const os = require('os');
const fs = require('fs');
const { chromium } = require('playwright');

const VIDEO_URL = process.argv[2] || 'https://www.youtube.com/watch?v=I4YLB-qpmzw';

(async () => {
  const userDataDir = path.join(os.tmpdir(), 'lamiss-pot-' + Date.now());
  fs.mkdirSync(userDataDir, { recursive: true });
  const context = await chromium.launchPersistentContext(userDataDir, { headless: false });
  const page = await context.newPage();

  let capturedPot = null;
  page.on('request', (req) => {
    if (req.url().includes('timedtext') && req.url().includes('pot=')) {
      const match = req.url().match(/[?&]pot=([^&]+)/);
      if (match && !capturedPot) capturedPot = decodeURIComponent(match[1]);
    }
  });

  await page.goto(VIDEO_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  try { await page.getByRole('button', { name: /Accept all|I agree/i }).click({ timeout: 3000 }); } catch {}
  await page.waitForTimeout(3000);

  try {
    await page.locator('.ytp-subtitles-button').click({ timeout: 5000 });
  } catch (e) {
    console.log('CC click failed:', e.message.split('\n')[0]);
  }
  await page.waitForTimeout(3000);

  if (!capturedPot) {
    console.log('No pot token observed on the network yet; trying again after a longer wait.');
    await page.waitForTimeout(3000);
  }

  console.log('Captured pot (ground truth from network):', capturedPot ? capturedPot.slice(0, 20) + '...(' + capturedPot.length + ' chars)' : 'NONE');

  if (!capturedPot) {
    await context.close();
    return;
  }

  // 1) Search window.ytcfg.data_ (and a few other known globals) recursively for the exact token.
  const foundInGlobals = await page.evaluate((needle) => {
    const results = [];
    function search(obj, pathStr, depth, seen) {
      if (depth > 6 || obj === null || obj === undefined) return;
      if (typeof obj === 'string') {
        if (obj === needle) results.push(pathStr);
        return;
      }
      if (typeof obj !== 'object' && typeof obj !== 'function') return;
      if (seen.has(obj)) return;
      seen.add(obj);
      let keys;
      try { keys = Object.keys(obj); } catch { return; }
      for (const key of keys) {
        let val;
        try { val = obj[key]; } catch { continue; }
        search(val, pathStr + '.' + key, depth + 1, seen);
      }
    }
    const roots = {
      'window.ytcfg': window.ytcfg,
      'window.yt': window.yt,
      'window.ytplayer': window.ytplayer,
      'window.ytInitialPlayerResponse': window.ytInitialPlayerResponse,
      'window.ytInitialData': window.ytInitialData
    };
    for (const [name, root] of Object.entries(roots)) {
      search(root, name, 0, new Set());
    }
    return results;
  }, capturedPot);

  console.log('Found in page globals at paths:', foundInGlobals.length ? foundInGlobals : 'none');

  // 2) Search IndexedDB databases for the token.
  const foundInIndexedDb = await page.evaluate(async (needle) => {
    const hits = [];
    if (!indexedDB.databases) return { error: 'indexedDB.databases() not supported', hits };
    const dbs = await indexedDB.databases();
    for (const dbInfo of dbs) {
      if (!dbInfo.name) continue;
      try {
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open(dbInfo.name);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        for (const storeName of Array.from(db.objectStoreNames)) {
          const records = await new Promise((resolve) => {
            try {
              const tx = db.transaction(storeName, 'readonly');
              const store = tx.objectStore(storeName);
              const getAllReq = store.getAll();
              getAllReq.onsuccess = () => resolve(getAllReq.result);
              getAllReq.onerror = () => resolve([]);
            } catch {
              resolve([]);
            }
          });
          const dumped = JSON.stringify(records);
          if (dumped.includes(needle)) {
            hits.push({ db: dbInfo.name, store: storeName });
          }
        }
        db.close();
      } catch (e) {
        // ignore individual db errors
      }
    }
    return { hits };
  }, capturedPot);

  console.log('Found in IndexedDB:', JSON.stringify(foundInIndexedDb));

  // 3) List all IndexedDB database names present, for reference regardless of match.
  const allDbNames = await page.evaluate(async () => {
    if (!indexedDB.databases) return [];
    const dbs = await indexedDB.databases();
    return dbs.map((d) => d.name);
  });
  console.log('All IndexedDB databases on this origin:', allDbNames);

  await context.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });
