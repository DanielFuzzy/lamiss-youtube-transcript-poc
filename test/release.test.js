// The release pipeline (docs/RELEASING.md): which backend each environment
// builds for, the package validator, the reproducible ZIP, and the
// extension's own refusal to use an insecure address.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { isLocalOrPrivateHost, resolveBuildConfig } = require('../scripts/lib/build-config');
const { validatePackage } = require('../scripts/lib/validate-package');
const { createExtensionEnv } = require('./helpers/extension-env');

const root = path.resolve(__dirname, '..');
const CLIENT_ID = '123-abc.apps.googleusercontent.com';

function environments(overrides = {}) {
  const base = JSON.parse(fs.readFileSync(path.join(root, 'config', 'environments.json'), 'utf8'));
  for (const [name, settings] of Object.entries(overrides)) {
    base.environments[name] = { ...base.environments[name], ...settings };
  }
  return base;
}

// --- Build configuration ---------------------------------------------------------

test('build config: development uses the file, or a custom endpoint from the environment', () => {
  const dev = resolveBuildConfig(environments(), 'development', {});
  assert.equal(dev.apiOrigin, 'http://localhost:8080');
  assert.equal(dev.wsOrigin, 'ws://localhost:8080');
  assert.equal(dev.chromeWebStore, false);

  const custom = resolveBuildConfig(environments(), 'development', { LAMISS_API_URL: 'https://tunnel.example.com:8443', LAMISS_GOOGLE_CLIENT_ID: CLIENT_ID });
  assert.equal(custom.apiOrigin, 'https://tunnel.example.com:8443');
  assert.equal(custom.wsOrigin, 'wss://tunnel.example.com:8443');
  assert.equal(custom.googleClientId, CLIENT_ID);
});

test('build config: staging and production come only from the file, over https on a public host', () => {
  const config = environments({ production: { apiUrl: 'https://api.lamiss.app', googleClientId: CLIENT_ID } });
  const production = resolveBuildConfig(config, 'production', {});
  assert.deepEqual(production, {
    environment: 'production', apiOrigin: 'https://api.lamiss.app', wsOrigin: 'wss://api.lamiss.app', googleClientId: CLIENT_ID, chromeWebStore: true
  });

  assert.throws(() => resolveBuildConfig(config, 'production', { LAMISS_API_URL: 'https://evil.example' }), /can only override development/);
  assert.throws(() => resolveBuildConfig(config, 'production', { LAMISS_GOOGLE_CLIENT_ID: CLIENT_ID }), /can only override development/);
  assert.throws(() => resolveBuildConfig(environments(), 'production', {}), /no apiUrl for "production"/);
  assert.throws(() => resolveBuildConfig(environments({ staging: { apiUrl: 'https://staging.lamiss.app' } }), 'staging', {}), /no googleClientId/);
  for (const apiUrl of ['http://api.lamiss.app', 'https://localhost', 'https://127.0.0.1:8080', 'https://192.168.1.20', 'https://10.0.0.5', 'https://lamiss.local']) {
    assert.throws(() => resolveBuildConfig(environments({ production: { apiUrl, googleClientId: CLIENT_ID } }), 'production', {}), /https|public host/, apiUrl);
  }
  for (const apiUrl of ['https://api.lamiss.app/v1', 'https://user:pw@api.lamiss.app', 'ftp://api.lamiss.app', 'not a url']) {
    assert.throws(() => resolveBuildConfig(environments({ production: { apiUrl, googleClientId: CLIENT_ID } }), 'production', {}), Error, apiUrl);
  }
  assert.throws(() => resolveBuildConfig(environments(), 'qa', {}), /unknown environment/);
});

test('build config: local and private hosts are recognized', () => {
  for (const host of ['localhost', 'app.localhost', '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.10', '169.254.1.1', '100.64.0.1', '[::1]', 'printer.local']) {
    assert.equal(isLocalOrPrivateHost(host), true, host);
  }
  for (const host of ['api.lamiss.app', '8.8.8.8', '172.32.0.1', 'pod-8880.proxy.runpod.net']) {
    assert.equal(isLocalOrPrivateHost(host), false, host);
  }
});

// --- Packaging ----------------------------------------------------------------------

// A copy of the project with a production backend set, packaged for real.
function packagedCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lamiss-package-'));
  for (const entry of ['config', 'manifest.json', 'package.json', 'tsconfig.json', 'scripts', 'src']) {
    fs.cpSync(path.join(root, entry), path.join(dir, entry), { recursive: true });
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'));
  const file = path.join(dir, 'config', 'environments.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.environments.production = { ...config.environments.production, apiUrl: 'https://api.lamiss.example', googleClientId: CLIENT_ID };
  fs.writeFileSync(file, JSON.stringify(config));
  const env = { ...process.env };
  delete env.LAMISS_API_URL;
  delete env.LAMISS_GOOGLE_CLIENT_ID;
  const packageOnce = () => {
    execFileSync(process.execPath, ['scripts/package.js', '--env', 'production'], { cwd: dir, env, stdio: 'pipe' });
    return fs.readFileSync(path.join(dir, 'dist', 'lamiss-0.1.0-production.zip'));
  };
  return { dir, packageOnce };
}

test('package: a valid, reproducible production ZIP without the manifest key or local addresses', () => {
  const { dir, packageOnce } = packagedCopy();
  const first = packageOnce();
  const second = packageOnce();
  assert.equal(crypto.createHash('sha256').update(first).digest('hex'), crypto.createHash('sha256').update(second).digest('hex'), 'byte-identical');
  assert.equal(first.readUInt32LE(0), 0x04034b50, 'a ZIP');

  const extension = path.join(dir, 'dist', 'production', 'extension');
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
  assert.equal('key' in manifest, false);
  assert.deepEqual(manifest.host_permissions, ['https://www.youtube.com/*', 'https://api.lamiss.example/*']);
  assert.equal(fs.existsSync(path.join(extension, 'youtubeUrl.js')), false, 'test-only scripts are left out');
  assert.deepEqual(validatePackage(extension, { environment: 'production', expectedVersion: '0.1.0' }), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('package: the validator catches what must never ship', () => {
  const { dir, packageOnce } = packagedCopy();
  packageOnce();
  const extension = path.join(dir, 'dist', 'production', 'extension');
  const manifestFile = path.join(extension, 'manifest.json');
  const good = fs.readFileSync(manifestFile, 'utf8');
  const withManifest = (change) => {
    const manifest = JSON.parse(good);
    change(manifest);
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    return validatePackage(extension, { environment: 'production', expectedVersion: '0.1.0' });
  };
  const has = (problems, pattern) => assert.ok(problems.some(problem => pattern.test(problem)), `${pattern} in ${JSON.stringify(problems)}`);

  has(withManifest(m => { m.key = 'abc'; }), /must not contain "key"/);
  has(withManifest(m => { m.manifest_version = 2; }), /manifest_version must be 3/);
  has(withManifest(m => { m.version = '0.1.0-beta'; }), /version must be/);
  has(withManifest(m => { m.version = '0.2.0'; }), /does not match package.json/);
  has(withManifest(m => { m.permissions.push('tabs'); }), /permission "tabs"/);
  has(withManifest(m => { m.host_permissions.push('<all_urls>'); }), /covers every site/);
  has(withManifest(m => { m.host_permissions.push('http://localhost:8080/*'); }), /not https/);
  has(withManifest(m => { m.content_security_policy = { extension_pages: "script-src 'self' 'unsafe-eval'" }; }), /allows remote or inline code/);
  has(withManifest(m => { m.background.service_worker = 'missing.js'; }), /service worker is missing/);
  has(withManifest(m => { m.description = 'x'.repeat(133); }), /description must be/);
  fs.writeFileSync(manifestFile, good);

  fs.writeFileSync(path.join(extension, '.env'), 'LAMISS_API_URL=http://localhost:8080');
  fs.writeFileSync(path.join(extension, 'background.js.map'), '{}');
  const problems = validatePackage(extension, { environment: 'production', expectedVersion: '0.1.0' });
  has(problems, /\.env/);
  has(problems, /background\.js\.map/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- In the extension -----------------------------------------------------------------

test('runtime: outside development an insecure backend address is never called', async () => {
  const env = createExtensionEnv({ environment: 'production', apiBaseUrl: 'http://api.lamiss.example', wsBaseUrl: 'ws://api.lamiss.example' });
  const result = JSON.parse(JSON.stringify(await env.run('fetchPreferences()')));
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'misconfigured');
  assert.match(result.error, /no valid server address/);
  assert.equal(env.fetchCalls.length, 0, 'nothing sent, not even the token');

  const mismatched = createExtensionEnv({ environment: 'production', apiBaseUrl: 'https://api.lamiss.example', wsBaseUrl: 'wss://other.example' });
  assert.equal(mismatched.run('lamissBackendConfigProblem()'), 'the REST and WebSocket addresses do not match');

  const development = createExtensionEnv({ environment: 'development', apiBaseUrl: 'http://localhost:8080', wsBaseUrl: 'ws://localhost:8080' });
  assert.equal(development.run('lamissBackendConfigProblem()'), undefined, 'plain http is fine on a developer machine');
});

// --- Chrome Web Store upload (scripts/cws-publish.js), against a fake API --------------

const { releaseToChromeWebStore } = require('../scripts/cws-publish');

function fakeStore(replies) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    const reply = replies.shift();
    return new Response(JSON.stringify(reply.json), { status: reply.status ?? 200 });
  };
  return { calls, fetchImpl };
}

const storeEnv = { CWS_CLIENT_ID: 'id', CWS_CLIENT_SECRET: 'secret', CWS_REFRESH_TOKEN: 'refresh', CWS_EXTENSION_ID: 'abcdefghijklmnopabcdefghijklmnop' };

test('chrome web store: uploads a draft and submits nothing unless asked', async () => {
  const store = fakeStore([{ json: { access_token: 'token' } }, { json: { uploadState: 'SUCCESS' } }]);
  const result = await releaseToChromeWebStore({ zipBytes: Buffer.from('zip'), env: storeEnv, fetchImpl: store.fetchImpl, log: () => {} });
  assert.deepEqual(result, { uploaded: true, submitted: false });
  assert.equal(store.calls.length, 2);
  assert.equal(store.calls[1].method, 'PUT');
  assert.match(store.calls[1].url, /\/upload\/chromewebstore\/v1\.1\/items\/abcdefghijklmnopabcdefghijklmnop\?uploadType=media$/);
  assert.equal(store.calls[1].headers.Authorization, 'Bearer token');
});

test('chrome web store: waits for processing, then submits to the chosen target', async () => {
  const store = fakeStore([
    { json: { access_token: 'token' } },
    { json: { uploadState: 'IN_PROGRESS' } },
    { json: { uploadState: 'SUCCESS' } },
    { json: { status: ['ITEM_PENDING_REVIEW'] } }
  ]);
  const result = await releaseToChromeWebStore({ zipBytes: Buffer.from('zip'), env: storeEnv, publish: true, target: 'trustedTesters', fetchImpl: store.fetchImpl, log: () => {}, sleep: async () => {} });
  assert.equal(result.submitted, true);
  assert.match(store.calls[3].url, /\/items\/abcdefghijklmnopabcdefghijklmnop\/publish\?publishTarget=trustedTesters$/);
});

test('chrome web store: missing credentials, a rejected package or a refused submission stop the release', async () => {
  await assert.rejects(releaseToChromeWebStore({ zipBytes: Buffer.from('zip'), env: { ...storeEnv, CWS_REFRESH_TOKEN: '' }, fetchImpl: async () => { throw new Error('no call expected'); } }), /CWS_REFRESH_TOKEN is not set/);
  await assert.rejects(releaseToChromeWebStore({ zipBytes: Buffer.from('zip'), env: { ...storeEnv, CWS_EXTENSION_ID: 'not-an-id' } }), /not a Chrome extension ID/);
  const rejected = fakeStore([{ json: { access_token: 'token' } }, { json: { uploadState: 'FAILURE', itemError: [{ error_detail: 'Invalid manifest' }] } }]);
  await assert.rejects(releaseToChromeWebStore({ zipBytes: Buffer.from('zip'), env: storeEnv, fetchImpl: rejected.fetchImpl, log: () => {} }), /Invalid manifest/);
  const refused = fakeStore([{ json: { access_token: 'token' } }, { json: { uploadState: 'SUCCESS' } }, { json: { status: ['NOT_AUTHORIZED'] } }]);
  await assert.rejects(releaseToChromeWebStore({ zipBytes: Buffer.from('zip'), env: storeEnv, publish: true, fetchImpl: refused.fetchImpl, log: () => {} }), /NOT_AUTHORIZED/);
  const badToken = fakeStore([{ status: 400, json: { error: 'invalid_grant' } }]);
  await assert.rejects(releaseToChromeWebStore({ zipBytes: Buffer.from('zip'), env: storeEnv, fetchImpl: badToken.fetchImpl }), /invalid_grant/);
});

test('build config: store-draft is a store package for a local backend, without overrides', () => {
  const draft = resolveBuildConfig(environments(), 'store-draft', {});
  assert.equal(draft.apiOrigin, 'http://localhost:8080');
  assert.equal(draft.chromeWebStore, true, 'no manifest key');
  assert.throws(() => resolveBuildConfig(environments(), 'store-draft', { LAMISS_API_URL: 'http://localhost:9999' }), /can only override development/);
  // Production keeps refusing what store-draft allows.
  assert.throws(() => resolveBuildConfig(environments({ production: { apiUrl: 'http://localhost:8080', googleClientId: CLIENT_ID } }), 'production', {}), /https/);
});
