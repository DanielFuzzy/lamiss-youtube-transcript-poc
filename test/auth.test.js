// Pure sign-in helpers (shared/lamiss-auth.js) and the authenticated backend
// calls (shared/lamiss-api.js), run against the compiled scripts.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createExtensionEnv, fakeIdToken, futureIso, EXTENSION_ID, API_BASE_URL } = require('./helpers/extension-env');

const REDIRECT_URI = `https://${EXTENSION_ID}.chromiumapp.org/`;
const plain = (value) => JSON.parse(JSON.stringify(value));
const user = { id: 7, email: 'ana@example.com', username: 'ana' };

function signedInEnv(options = {}) {
  const env = createExtensionEnv(options);
  env.session.data.set('lamissAuth', { accessToken: 'secret-token', expiresAt: futureIso(), user });
  return env;
}

test('the Google auth URL asks for an ID token with the agreed parameters', () => {
  const env = createExtensionEnv();
  const request = { clientId: 'client.apps.googleusercontent.com', redirectUri: REDIRECT_URI, nonce: 'n-1', state: 's-1' };

  const interactive = new URL(env.context.buildGoogleAuthUrl({ ...request, interactive: true }));
  assert.equal(interactive.origin + interactive.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(interactive.searchParams.get('client_id'), 'client.apps.googleusercontent.com');
  assert.equal(interactive.searchParams.get('response_type'), 'id_token');
  assert.equal(interactive.searchParams.get('scope'), 'openid email profile');
  assert.equal(interactive.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(interactive.searchParams.get('nonce'), 'n-1');
  assert.equal(interactive.searchParams.get('state'), 's-1');
  assert.equal(interactive.searchParams.get('prompt'), 'select_account');

  const silent = new URL(env.context.buildGoogleAuthUrl({ ...request, interactive: false }));
  assert.equal(silent.searchParams.get('prompt'), 'none');
});

test('the OAuth state is a fresh 32-byte base64url string', () => {
  const env = createExtensionEnv();
  const first = env.context.randomUrlSafeString();
  const second = env.context.randomUrlSafeString();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
});

test('a redirect with the expected state and nonce yields the ID token', () => {
  const env = createExtensionEnv();
  const idToken = fakeIdToken({ nonce: 'n-1', sub: '123' });
  const result = env.context.parseAuthRedirect(`${REDIRECT_URI}#id_token=${idToken}&state=s-1`, { redirectUri: REDIRECT_URI, state: 's-1', nonce: 'n-1' });
  assert.deepEqual(plain(result), { ok: true, idToken });
});

test('a redirect with a different or missing state is rejected', () => {
  const env = createExtensionEnv();
  const idToken = fakeIdToken({ nonce: 'n-1' });
  const expected = { redirectUri: REDIRECT_URI, state: 's-1', nonce: 'n-1' };
  for (const fragment of [`id_token=${idToken}&state=other`, `id_token=${idToken}`]) {
    const result = env.context.parseAuthRedirect(`${REDIRECT_URI}#${fragment}`, expected);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'state_mismatch');
  }
});

test('a redirect whose ID token carries another nonce is rejected', () => {
  const env = createExtensionEnv();
  const result = env.context.parseAuthRedirect(`${REDIRECT_URI}#id_token=${fakeIdToken({ nonce: 'stolen' })}&state=s-1`, { redirectUri: REDIRECT_URI, state: 's-1', nonce: 'n-1' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'nonce_mismatch');
});

test('Google errors in the redirect map to cancel and interaction-required', () => {
  const env = createExtensionEnv();
  const expected = { redirectUri: REDIRECT_URI, state: 's-1', nonce: 'n-1' };
  const denied = env.context.parseAuthRedirect(`${REDIRECT_URI}#error=access_denied&state=s-1`, expected);
  assert.equal(denied.reason, 'cancelled');
  assert.equal(denied.error, 'Sign-in was cancelled.');
  const silent = env.context.parseAuthRedirect(`${REDIRECT_URI}#error=interaction_required&state=s-1`, expected);
  assert.equal(silent.reason, 'interaction_required');
});

test('a redirect to another address is rejected', () => {
  const env = createExtensionEnv();
  const result = env.context.parseAuthRedirect(`https://evil.example/#id_token=${fakeIdToken({ nonce: 'n-1' })}&state=s-1`, { redirectUri: REDIRECT_URI, state: 's-1', nonce: 'n-1' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'failed');
});

test('closing the Google window counts as a cancel, not an error', () => {
  const env = createExtensionEnv();
  const cancelled = env.context.describeAuthFlowError(new Error('The user did not approve access.'), true);
  assert.deepEqual(plain(cancelled), { reason: 'cancelled', error: 'Sign-in was cancelled.' });
  const silent = env.context.describeAuthFlowError(new Error('User interaction required.'), false);
  assert.equal(silent.reason, 'interaction_required');
  const other = env.context.describeAuthFlowError(new Error('Authorization page could not be loaded.'), true);
  assert.equal(other.reason, 'failed');
});

test('the auth state follows the stored session and its expiry', () => {
  const env = createExtensionEnv();
  const now = Date.parse('2026-10-16T12:00:00Z');
  const fromStored = (stored) => plain(env.context.authStateFromStored(stored, now));
  assert.deepEqual(fromStored(undefined), { status: 'signedOut' });
  assert.deepEqual(fromStored({ expired: true }), { status: 'expired' });
  assert.deepEqual(fromStored({ accessToken: 't', expiresAt: '2026-10-16T11:59:59Z', user }), { status: 'expired' });
  assert.deepEqual(fromStored({ accessToken: 't', expiresAt: 'not a date', user }), { status: 'expired' });
  assert.deepEqual(fromStored({ accessToken: 't', expiresAt: '2026-10-16T13:00:00Z', user }), { status: 'signedIn', user, expiresAt: '2026-10-16T13:00:00Z' });
});

test('only a complete, unexpired sign-in response is accepted', () => {
  const env = createExtensionEnv();
  const good = { accessToken: 'tok', tokenType: 'Bearer', expiresAt: futureIso(), user, newUser: false };
  assert.equal(env.context.readGoogleSignInResponse(good).accessToken, 'tok');
  assert.equal(env.context.readGoogleSignInResponse({ ...good, accessToken: '' }), undefined);
  assert.equal(env.context.readGoogleSignInResponse({ ...good, tokenType: 'MAC' }), undefined);
  assert.equal(env.context.readGoogleSignInResponse({ ...good, expiresAt: '2000-01-01T00:00:00Z' }), undefined);
  assert.equal(env.context.readGoogleSignInResponse({ ...good, user: { id: 7 } }), undefined);
});

test('backend calls carry the bearer token while signed in', async () => {
  const env = signedInEnv({ responder: async () => ({ json: [] }) });
  const result = await env.run('fetchSessionChat(42)');
  assert.equal(result.ok, true);
  assert.equal(env.fetchCalls.length, 1);
  assert.equal(env.fetchCalls[0].url, `${API_BASE_URL}/api/learning-sessions/42/chat`);
  assert.equal(env.fetchCalls[0].headers.get('authorization'), 'Bearer secret-token');
  assert.equal(env.fetchCalls[0].headers.get('accept'), 'application/json');
});

test('backend calls carry no token while signed out, or once it has expired', async () => {
  const env = createExtensionEnv({ responder: async () => ({ json: [] }) });
  await env.run('fetchSessionChat(42)');
  env.session.data.set('lamissAuth', { accessToken: 'old-token', expiresAt: '2000-01-01T00:00:00Z', user });
  await env.run('fetchSessionChat(42)');
  assert.equal(env.fetchCalls.length, 2);
  for (const call of env.fetchCalls) {
    assert.equal(call.headers.get('authorization'), null);
  }
});

test('the public sign-in endpoints never get the token', async () => {
  const env = signedInEnv({ responder: async () => ({ json: { nonce: 'n', expiresAt: futureIso() } }) });
  await env.run(`callLamiss('/api/auth/nonce', { method: 'POST' }, { anonymous: true })`);
  assert.equal(env.fetchCalls[0].headers.get('authorization'), null);
});

test('a content-script context (no lamiss-auth.js, no session storage) is signed out', async () => {
  const env = createExtensionEnv({
    withoutSessionStorage: true,
    scripts: ['shared/lamiss-config.js', 'shared/lamiss-api.js'],
    responder: async () => ({ status: 401, json: { detail: 'Unauthenticated', errorCode: 'unauthenticated' } })
  });
  const result = await env.run('fetchSessionChat(42)');
  assert.equal(env.fetchCalls[0].headers.get('authorization'), null);
  assert.equal(result.ok, false);
  assert.equal(result.signInRequired, true);
  assert.equal(result.error, 'Sign in to use Lamiss.');
});

test('a 401 forgets the token, announces "expired" and is not retried', async () => {
  const env = signedInEnv({
    tabs: [{ id: 7, url: 'https://www.youtube.com/watch?v=x' }],
    responder: async () => ({ status: 401, json: { detail: 'Unauthenticated', retryable: true, errorCode: 'unauthenticated' } })
  });
  const result = await env.run(`askLamiss({ interactionId: 'i-1', learningSessionId: 42, videoPositionMs: 0, text: 'hola' })`);

  assert.deepEqual(plain(result), { ok: false, status: 401, error: 'Please sign in again.', retryable: false, signInRequired: true });
  assert.equal(env.fetchCalls.length, 1, 'no retry');
  assert.deepEqual(plain(env.session.data.get('lamissAuth')), { expired: true });
  assert.equal(await env.run('readAccessToken()'), undefined);
  assert.deepEqual(plain(await env.run('readAuthState()')), { status: 'expired' });
  assert.deepEqual(env.runtimeSent, [{ type: 'lamiss:auth-changed', state: { status: 'expired' } }]);
  assert.deepEqual(env.tabsSent, [{ tabId: 7, message: { type: 'lamiss:auth-changed', state: { status: 'expired' } } }]);
});

test('failed calls log the status only, never bodies or tokens', async () => {
  const env = signedInEnv({ responder: async () => ({ status: 500, json: { detail: 'boom secret-detail', retryable: true } }) });
  const result = await env.run('fetchSessionChat(42)');
  assert.equal(result.retryable, true);
  assert.equal(result.error, 'boom secret-detail');
  const logged = env.logs.map(entry => entry.text).join('\n');
  assert.ok(logged.includes('500'));
  assert.ok(!logged.includes('secret-detail'));
  assert.ok(!logged.includes('secret-token'));
});

test('speech synthesis uses the token it is given and stops on a 401', async () => {
  const env = createExtensionEnv({
    scripts: ['shared/lamiss-config.js', 'shared/lamiss-api.js'],
    withoutSessionStorage: true,
    responder: async () => ({ status: 401, json: { detail: 'Unauthenticated' } })
  });
  let rejected = 0;
  env.context.__onRejected = () => {
    rejected += 1;
  };
  env.run('lamissOnSessionRejected = async () => __onRejected()');
  const result = await env.run(`synthesizeSpeech('Hola', 'es', 'offscreen-token')`);
  assert.equal(env.fetchCalls.length, 1);
  assert.equal(env.fetchCalls[0].headers.get('authorization'), 'Bearer offscreen-token');
  assert.equal(result.signInRequired, true);
  assert.equal(result.retryable, false);
  assert.equal(rejected, 1);
});

test('transcription uses the token it is given', async () => {
  const env = createExtensionEnv({
    scripts: ['shared/lamiss-config.js', 'shared/lamiss-api.js'],
    withoutSessionStorage: true,
    responder: async () => ({ json: { text: 'hola', language: 'SPANISH' } })
  });
  const result = await env.run(`transcribeSpeech(new Blob(['x'], { type: 'audio/ogg' }), 'offscreen-token')`);
  assert.equal(result.ok, true);
  assert.equal(env.fetchCalls[0].headers.get('authorization'), 'Bearer offscreen-token');
});

test('the auth module keeps the token in session storage only', async () => {
  const env = createExtensionEnv();
  await env.run(`storeAuthSession({ accessToken: 'secret-token', expiresAt: '${futureIso()}', user: { id: 7, email: 'a@b.c', username: 'a' } })`);
  assert.equal(await env.run('readAccessToken()'), 'secret-token');
  assert.equal(env.local.writes.length, 0);
  await env.run('clearAuthSession()');
  assert.equal(env.session.data.has('lamissAuth'), false);
});

test('a late 401 for an older token leaves the newer session alone', async () => {
  const env = signedInEnv({
    responder: async () => {
      env.session.data.set('lamissAuth', { accessToken: 'newer-token', expiresAt: futureIso(), user });
      return { status: 401, json: { detail: 'Unauthenticated' } };
    }
  });
  const result = await env.run('fetchSessionChat(42)');
  assert.equal(result.signInRequired, true);
  assert.equal(env.fetchCalls[0].headers.get('authorization'), 'Bearer secret-token');
  assert.equal(env.session.data.get('lamissAuth').accessToken, 'newer-token');
  assert.equal(env.runtimeSent.length, 0);
});
