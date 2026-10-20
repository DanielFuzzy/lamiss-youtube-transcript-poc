// The background worker's sign-in, sign-out, sender checks and authenticated
// live connection, run against compiled/background.js with chrome.* stubs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createExtensionEnv, senders, fakeIdToken, futureIso, EXTENSION_ID, API_BASE_URL, GOOGLE_CLIENT_ID } = require('./helpers/extension-env');

const plain = (value) => JSON.parse(JSON.stringify(value));
const user = { id: 7, email: 'ana@example.com', username: 'ana' };

async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

// The backend side of a successful sign-in, plus whatever `extra` handles.
function backend(extra = async () => undefined) {
  return async (url, init) => {
    const handled = await extra(url, init);
    if (handled) {
      return handled;
    }
    if (url === `${API_BASE_URL}/api/auth/nonce`) {
      return { json: { nonce: 'nonce-1', expiresAt: futureIso() } };
    }
    if (url === `${API_BASE_URL}/api/auth/google`) {
      return { json: { accessToken: 'secret-token', tokenType: 'Bearer', expiresAt: futureIso(), user, newUser: true } };
    }
    if (url === `${API_BASE_URL}/api/auth/logout`) {
      return { status: 204 };
    }
    return { status: 404, json: { detail: 'not stubbed' } };
  };
}

// Google: answers with an ID token for the nonce it was given.
function googleSignsIn(env, override = {}) {
  env.identity.launchWebAuthFlow = async (details) => {
    const url = new URL(details.url);
    const state = override.state ?? url.searchParams.get('state');
    const idToken = fakeIdToken({ nonce: url.searchParams.get('nonce'), sub: '123' });
    return `${url.searchParams.get('redirect_uri')}#id_token=${idToken}&state=${state}`;
  };
}

function backgroundEnv(options = {}) {
  return createExtensionEnv({ scripts: ['background.js'], responder: backend(options.extra), tabs: options.tabs });
}

function signIn(env) {
  env.session.data.set('lamissAuth', { accessToken: 'secret-token', expiresAt: futureIso(), user });
}

function fakePort(sender = senders.contentScript) {
  const messages = [];
  const onMessage = [];
  const onDisconnect = [];
  return {
    name: 'lamiss-live',
    sender,
    messages,
    disconnected: false,
    postMessage(message) {
      messages.push(plain(message));
    },
    disconnect() {
      this.disconnected = true;
    },
    onMessage: { addListener: listener => onMessage.push(listener) },
    onDisconnect: { addListener: listener => onDisconnect.push(listener) },
    send(message) {
      onMessage.forEach(listener => listener(message));
    }
  };
}

test('the worker keeps session storage away from content scripts', async () => {
  const env = backgroundEnv();
  await flush();
  assert.equal(env.session.accessLevel, 'TRUSTED_CONTEXTS');
});

test('sign-in: nonce, Google, token exchange, and the token lands in session storage only', async () => {
  const env = backgroundEnv({ tabs: [{ id: 7, url: 'https://www.youtube.com/watch?v=x' }] });
  googleSignsIn(env);

  const result = await env.dispatchMessage({ type: 'lamiss:sign-in' }, senders.popup);

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(plain(result.state), { status: 'signedIn', user, expiresAt: result.state.expiresAt });

  const [nonceCall, googleCall] = env.fetchCalls;
  assert.equal(nonceCall.url, `${API_BASE_URL}/api/auth/nonce`);
  assert.equal(nonceCall.init.method, 'POST');
  assert.equal(googleCall.url, `${API_BASE_URL}/api/auth/google`);
  assert.equal(googleCall.headers.get('authorization'), null);
  const sentIdToken = JSON.parse(googleCall.init.body).idToken;
  assert.ok(sentIdToken.split('.').length === 3);

  const [launch] = env.identity.launches;
  assert.equal(launch.interactive, true);
  const authUrl = new URL(launch.url);
  assert.equal(authUrl.searchParams.get('client_id'), GOOGLE_CLIENT_ID);
  assert.equal(authUrl.searchParams.get('response_type'), 'id_token');
  assert.equal(authUrl.searchParams.get('scope'), 'openid email profile');
  assert.equal(authUrl.searchParams.get('redirect_uri'), `https://${EXTENSION_ID}.chromiumapp.org/`);
  assert.equal(authUrl.searchParams.get('nonce'), 'nonce-1');
  assert.equal(authUrl.searchParams.get('prompt'), 'select_account');
  assert.ok(authUrl.searchParams.get('state').length >= 32);

  assert.equal(env.session.data.get('lamissAuth').accessToken, 'secret-token');
  assert.ok(!JSON.stringify(env.local.writes).includes('secret-token'), 'token never written to storage.local');
  assert.deepEqual(Object.keys(Object.fromEntries(env.local.data)), ['lamissSignedInBefore']);

  // Pages get the user; YouTube tabs only the status, and nobody gets the token.
  assert.deepEqual(env.runtimeSent.map(message => message.state.status), ['signedIn']);
  assert.deepEqual(env.tabsSent, [{ tabId: 7, message: { type: 'lamiss:auth-changed', state: { status: 'signedIn' } } }]);
  assert.ok(!JSON.stringify([env.runtimeSent, env.tabsSent, env.logs]).includes('secret-token'));
});

test('sign-in with a mismatched state stores nothing and never sends the ID token', async () => {
  const env = backgroundEnv();
  googleSignsIn(env, { state: 'forged-state' });

  const result = await env.dispatchMessage({ type: 'lamiss:sign-in' }, senders.popup);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'state_mismatch');
  assert.deepEqual(env.fetchCalls.map(call => call.url), [`${API_BASE_URL}/api/auth/nonce`]);
  assert.equal(env.session.data.has('lamissAuth'), false);
});

test('closing the Google window is reported as a cancel', async () => {
  const env = backgroundEnv();
  env.identity.launchWebAuthFlow = async () => {
    throw new Error('The user did not approve access.');
  };

  const result = await env.dispatchMessage({ type: 'lamiss:sign-in' }, senders.popup);

  assert.deepEqual(plain(result), { ok: false, reason: 'cancelled', error: 'Sign-in was cancelled.' });
  assert.equal(env.session.data.has('lamissAuth'), false);
  assert.equal(env.runtimeSent.length, 0);
});

test('a rejected Google credential shows the backend reason', async () => {
  const env = backgroundEnv({
    extra: async (url) => url.endsWith('/api/auth/google')
      ? { status: 409, json: { detail: 'This email belongs to another Lamiss account.', errorCode: 'account_conflict', retryable: false } }
      : undefined
  });
  googleSignsIn(env);

  const result = await env.dispatchMessage({ type: 'lamiss:sign-in' }, senders.popup);

  assert.deepEqual(plain(result), { ok: false, reason: 'rejected', error: 'This email belongs to another Lamiss account.' });
  assert.equal(env.session.data.has('lamissAuth'), false);
});

test('content scripts learn the status only', async () => {
  const env = backgroundEnv();
  signIn(env);
  assert.deepEqual(plain(await env.dispatchMessage({ type: 'lamiss:auth-state' }, senders.contentScript)), { status: 'signedIn' });
  const full = await env.dispatchMessage({ type: 'lamiss:auth-state' }, senders.popup);
  assert.deepEqual(plain(full.user), user);
  assert.equal(JSON.stringify(full).includes('secret-token'), false);

  googleSignsIn(env);
  const signInResult = await env.dispatchMessage({ type: 'lamiss:sign-in' }, senders.contentScript);
  assert.deepEqual(plain(signInResult), { ok: true, state: { status: 'signedIn' } });
});

test('messages from other extensions and other sites are ignored', async () => {
  const env = backgroundEnv();
  signIn(env);
  assert.equal(await env.dispatchMessage({ type: 'lamiss:auth-state' }, senders.otherExtension), undefined);
  assert.equal(await env.dispatchMessage({ type: 'lamiss:auth-state' }, senders.otherSite), undefined);
  assert.equal(await env.dispatchMessage({ type: 'lamiss:auth-state' }, senders.otherExtensionContentScript), undefined);
  assert.equal(await env.dispatchMessage({ type: 'INGEST_TRANSCRIPT', payload: {} }, senders.otherExtensionContentScript), undefined);
  assert.equal(await env.dispatchMessage({ type: 'lamiss:sign-out' }, senders.otherExtension), undefined);
  assert.equal(env.session.data.has('lamissAuth'), true);
});

test('content scripts may only send their allow-listed messages, about their own tab', async () => {
  const env = backgroundEnv();
  signIn(env);
  const allowed = (message, sender) => env.context.isAllowedLamissMessage(message, sender);

  for (const type of ['GET_SENDER_TAB_ID', 'INGEST_TRANSCRIPT', 'lamiss:sign-in', 'lamiss:auth-state']) {
    assert.equal(allowed({ type }, senders.contentScript), true, type);
  }
  assert.equal(allowed({ type: 'DISCOVER_CAPTION_TRACKS', tabId: 7, videoId: 'x' }, senders.contentScript), true);
  assert.equal(allowed({ type: 'DISCOVER_CAPTION_TRACKS', tabId: 8, videoId: 'x' }, senders.contentScript), false);
  assert.equal(allowed({ type: 'FETCH_CAPTION_RESOURCE_MAIN_WORLD', tabId: 8, captionUrl: 'x' }, senders.contentScript), false);
  for (const message of [{ type: 'lamiss:sign-out' }, { type: 'lamiss:start-session', videoId: 'x' }, { source: 'lamiss-offscreen', requestId: 'r', event: { type: 'failed' } }, { type: 'lamiss:session-rejected' }]) {
    assert.equal(allowed(message, senders.contentScript), false, JSON.stringify(message));
  }
  // Extension pages may send anything; strangers nothing.
  assert.equal(allowed({ type: 'lamiss:sign-out' }, senders.popup), true);
  assert.equal(allowed({ type: 'lamiss:start-session', videoId: 'x' }, senders.chat), true);
  assert.equal(allowed({ type: 'GET_SENDER_TAB_ID' }, senders.otherExtension), false);
  assert.equal(allowed({ type: 'GET_SENDER_TAB_ID' }, senders.otherSite), false);
  assert.equal(allowed({ type: 'GET_SENDER_TAB_ID' }, { id: EXTENSION_ID, url: 'https://www.youtube.com/' }), false, 'no tab');

  // A content script can't sign the user out.
  assert.equal(await env.dispatchMessage({ type: 'lamiss:sign-out' }, senders.contentScript), undefined);
  assert.equal(env.session.data.has('lamissAuth'), true);
});

test('the live connection only accepts YouTube content scripts', async () => {
  const env = backgroundEnv();
  const [onConnect] = env.onConnect.listeners;
  for (const sender of [senders.otherExtension, senders.otherExtensionContentScript, senders.otherSite, senders.popup]) {
    const port = fakePort(sender);
    onConnect(port);
    assert.equal(port.disconnected, true);
  }
  const port = fakePort();
  onConnect(port);
  assert.equal(port.disconnected, false);
});

test('transcript ingest carries the token, and needs a sign-in without one', async () => {
  const env = backgroundEnv({
    extra: async (url) => url.endsWith('/api/transcripts/ingest') ? { json: { status: 'INGESTED' } } : undefined
  });
  const payload = { videoExternalId: 'x', videoPlatform: 'YOUTUBE' };

  const signedOut = await env.dispatchMessage({ type: 'INGEST_TRANSCRIPT', payload }, senders.contentScript);
  assert.deepEqual(plain(signedOut), { ok: false, status: 401, error: 'Sign in to use Lamiss.', signInRequired: true });
  assert.equal(env.fetchCalls.length, 0);

  signIn(env);
  const ingested = await env.dispatchMessage({ type: 'INGEST_TRANSCRIPT', payload }, senders.contentScript);
  assert.equal(ingested.ok, true);
  assert.equal(env.fetchCalls[0].headers.get('authorization'), 'Bearer secret-token');
});

test('a 401 on ingest ends the session without retrying', async () => {
  const env = backgroundEnv({
    extra: async (url) => url.endsWith('/api/transcripts/ingest') ? { status: 401, json: { detail: 'Unauthenticated', errorCode: 'unauthenticated' } } : undefined
  });
  signIn(env);
  const result = await env.dispatchMessage({ type: 'INGEST_TRANSCRIPT', payload: { videoExternalId: 'x' } }, senders.contentScript);
  assert.deepEqual(plain(result), { ok: false, status: 401, error: 'Please sign in again.', signInRequired: true });
  assert.equal(env.fetchCalls.filter(call => call.url.endsWith('/ingest')).length, 1);
  assert.deepEqual(plain(env.session.data.get('lamissAuth')), { expired: true });
});

test('sign-out revokes the session, forgets the token and the pending questions', async () => {
  const env = backgroundEnv();
  signIn(env);
  env.local.data.set('lamissSignedInBefore', true);
  env.local.data.set('lamissPendingQuestion:42', { eventId: 'e', question: 'q' });
  env.local.data.set('lamissPendingQuestion:43', { eventId: 'f', question: 'r' });
  env.local.data.set('lamissQuestionSettings', { difficulty: 'HARD', minSecondsBetweenQuestions: 60 });

  const result = await env.dispatchMessage({ type: 'lamiss:sign-out' }, senders.popup);

  assert.deepEqual(plain(result), { status: 'signedOut' });
  const logout = env.fetchCalls.find(call => call.url === `${API_BASE_URL}/api/auth/logout`);
  assert.equal(logout.init.method, 'POST');
  assert.equal(logout.headers.get('authorization'), 'Bearer secret-token');
  assert.equal(env.session.data.has('lamissAuth'), false);
  assert.deepEqual([...env.local.data.keys()], ['lamissQuestionSettings']);
  assert.deepEqual(env.runtimeSent.at(-1), { type: 'lamiss:auth-changed', state: { status: 'signedOut' } });
});

test('sign-out still signs out when the backend is unreachable or says 401', async () => {
  for (const failure of [async () => { throw new TypeError('Failed to fetch'); }, async () => ({ status: 401, json: {} })]) {
    const env = backgroundEnv({ extra: async (url) => url.endsWith('/api/auth/logout') ? failure() : undefined });
    signIn(env);
    const result = await env.dispatchMessage({ type: 'lamiss:sign-out' }, senders.popup);
    assert.deepEqual(plain(result), { status: 'signedOut' });
    assert.equal(env.session.data.has('lamissAuth'), false);
  }
});

test('live questions: a ticket opens the socket, and close code 4401 ends the session without reconnecting', async () => {
  const env = backgroundEnv({
    extra: async (url) => {
      if (url.endsWith('/api/learning-sessions')) {
        return { json: { learningSessionId: 42, videoId: 1, videoExternalId: 'vid', resumed: false, aiKnowledgeReady: true } };
      }
      if (url.endsWith('/api/auth/ws-ticket')) {
        return { json: { ticket: 'tick/et+1', expiresAt: futureIso(30_000) } };
      }
      return undefined;
    }
  });
  signIn(env);
  const port = fakePort();
  env.onConnect.listeners[0](port);
  port.send({ type: 'start', videoId: 'vid' });
  await flush();

  const ticketCall = env.fetchCalls.find(call => call.url.endsWith('/api/auth/ws-ticket'));
  assert.deepEqual(JSON.parse(ticketCall.init.body), { learningSessionId: 42 });
  assert.equal(ticketCall.headers.get('authorization'), 'Bearer secret-token');
  assert.equal(env.FakeWebSocket.instances.length, 1);
  const socket = env.FakeWebSocket.instances[0];
  assert.equal(socket.url, 'wss://api.lamiss.test/ws/learning-sessions/42?ticket=tick%2Fet%2B1');

  socket.emit('close', { code: 4401, reason: '' });
  await new Promise(resolve => setTimeout(resolve, 1200));
  await flush();

  assert.equal(env.FakeWebSocket.instances.length, 1, 'no reconnect');
  assert.deepEqual(port.messages.at(-1), { type: 'status', state: 'failed', detail: 'Please sign in again.' });
  assert.deepEqual(plain(env.session.data.get('lamissAuth')), { expired: true });
});

test('live questions need a sign-in first', async () => {
  const env = backgroundEnv();
  const port = fakePort();
  env.onConnect.listeners[0](port);
  port.send({ type: 'start', videoId: 'vid' });
  await flush();
  assert.equal(env.fetchCalls.length, 0);
  assert.deepEqual(port.messages.at(-1), { type: 'status', state: 'failed', detail: 'Sign in to use Lamiss.' });
});

test('sign-out closes the live connections', async () => {
  const env = backgroundEnv({
    extra: async (url) => {
      if (url.endsWith('/api/learning-sessions')) {
        return { json: { learningSessionId: 42, videoId: 1, videoExternalId: 'vid', resumed: false, aiKnowledgeReady: true } };
      }
      if (url.endsWith('/api/auth/ws-ticket')) {
        return { json: { ticket: 't', expiresAt: futureIso(30_000) } };
      }
      return undefined;
    }
  });
  signIn(env);
  const port = fakePort();
  env.onConnect.listeners[0](port);
  port.send({ type: 'start', videoId: 'vid' });
  await flush();
  const socket = env.FakeWebSocket.instances[0];

  await env.dispatchMessage({ type: 'lamiss:sign-out' }, senders.popup);

  assert.equal(socket.closedWith.code, 1000);
  assert.equal(port.disconnected, true);
});

test('the offscreen document gets the token with each listen and speak request', async () => {
  const env = backgroundEnv();
  signIn(env);
  const port = fakePort();
  env.onConnect.listeners[0](port);
  port.send({ type: 'listen', requestId: 'r-1' });
  port.send({ type: 'speak', requestId: 'r-2', text: 'Hola', language: 'es', accessToken: 'forged' });
  await flush();

  const listen = env.runtimeSent.find(message => message.type === 'listen');
  const speak = env.runtimeSent.find(message => message.type === 'speak');
  assert.deepEqual(listen, { target: 'lamiss-offscreen', type: 'listen', requestId: 'r-1', accessToken: 'secret-token' });
  assert.deepEqual(speak, { target: 'lamiss-offscreen', type: 'speak', requestId: 'r-2', text: 'Hola', language: 'es', accessToken: 'secret-token', volume: 1 });
  // The tab only hears about progress, never the token.
  assert.ok(!JSON.stringify(port.messages).includes('secret-token'));
  assert.ok(!JSON.stringify(env.tabsSent).includes('secret-token'));
});

test('the offscreen document gets the devices picked in the popup with listen and speak', async () => {
  const env = backgroundEnv();
  signIn(env);
  env.local.data.set('lamissDeviceSettings', { micDeviceId: 'mic-2', speakerDeviceId: 'speaker-3', volume: 0.4 });
  const port = fakePort();
  env.onConnect.listeners[0](port);
  // A tab can't choose the devices: only the stored settings count.
  port.send({ type: 'listen', requestId: 'r-1', micDeviceId: 'forged' });
  port.send({ type: 'speak', requestId: 'r-2', text: 'Hola', language: 'es', speakerDeviceId: 'forged', volume: 0 });
  await flush();

  const listen = env.runtimeSent.find(message => message.type === 'listen');
  const speak = env.runtimeSent.find(message => message.type === 'speak');
  assert.deepEqual(listen, { target: 'lamiss-offscreen', type: 'listen', requestId: 'r-1', accessToken: 'secret-token', micDeviceId: 'mic-2' });
  assert.deepEqual(speak, {
    target: 'lamiss-offscreen',
    type: 'speak',
    requestId: 'r-2',
    text: 'Hola',
    language: 'es',
    accessToken: 'secret-token',
    speakerDeviceId: 'speaker-3',
    volume: 0.4
  });
});

test('browser start tries a silent sign-in for a returning user', async () => {
  const env = backgroundEnv();
  env.local.data.set('lamissSignedInBefore', true);
  googleSignsIn(env);

  env.onStartup.listeners.forEach(listener => listener());
  await flush(60);

  const [launch] = env.identity.launches;
  assert.equal(launch.interactive, false);
  assert.equal(typeof launch.abortOnLoadForNonInteractive, 'boolean');
  assert.equal(typeof launch.timeoutMsForNonInteractive, 'number');
  assert.equal(new URL(launch.url).searchParams.get('prompt'), 'none');
  assert.equal(env.session.data.get('lamissAuth').accessToken, 'secret-token');
});

test('no silent sign-in after the user signed out', async () => {
  const env = backgroundEnv();
  googleSignsIn(env);
  env.onStartup.listeners.forEach(listener => listener());
  await flush(60);
  assert.equal(env.identity.launches.length, 0);
});

// A backend with a live session 42 whose tickets name the token they were asked with.
function liveBackend(googleToken) {
  return async (url, init) => {
    if (url.endsWith('/api/learning-sessions')) {
      return { json: { learningSessionId: 42, videoId: 1, videoExternalId: 'vid', resumed: true, aiKnowledgeReady: true } };
    }
    if (url.endsWith('/api/auth/ws-ticket')) {
      const token = new Headers(init.headers).get('authorization').replace('Bearer ', '');
      return { json: { ticket: `ticket-for-${token}`, expiresAt: futureIso(30_000) } };
    }
    if (googleToken && url.endsWith('/api/auth/google')) {
      return { json: { accessToken: googleToken, tokenType: 'Bearer', expiresAt: futureIso(), user, newUser: false } };
    }
    return undefined;
  };
}

async function openLive(env) {
  const port = fakePort();
  env.onConnect.listeners[0](port);
  port.send({ type: 'start', videoId: 'vid' });
  await flush();
  return port;
}

test('a late 4401 from the old session keeps a newer sign-in and moves to it', async () => {
  const env = backgroundEnv({ extra: liveBackend() });
  signIn(env);
  const port = await openLive(env);
  const oldSocket = env.FakeWebSocket.instances[0];
  assert.match(oldSocket.url, /ticket=ticket-for-secret-token$/);

  // Another tab signed in again meanwhile; the old socket only now gets refused.
  env.session.data.set('lamissAuth', { accessToken: 'newer-token', expiresAt: futureIso(), user });
  oldSocket.emit('close', { code: 4401, reason: '' });
  await flush();

  assert.equal(env.session.data.get('lamissAuth').accessToken, 'newer-token');
  assert.ok(!env.runtimeSent.some(message => message.type === 'lamiss:auth-changed'), 'no "expired" broadcast');
  assert.equal(env.FakeWebSocket.instances.length, 2);
  assert.match(env.FakeWebSocket.instances[1].url, /ticket=ticket-for-newer-token$/);
  assert.ok(!port.messages.some(message => message.state === 'failed'));
});

test('a late REST 401 from the old session keeps a newer sign-in', async () => {
  const env = backgroundEnv({
    extra: async (url) => {
      if (url.endsWith('/api/transcripts/ingest')) {
        // The user signs in again while this request, sent with the old token, is in flight.
        env.session.data.set('lamissAuth', { accessToken: 'newer-token', expiresAt: futureIso(), user });
        return { status: 401, json: { detail: 'Unauthenticated', errorCode: 'unauthenticated' } };
      }
      return undefined;
    }
  });
  signIn(env);

  const result = await env.dispatchMessage({ type: 'INGEST_TRANSCRIPT', payload: { videoExternalId: 'x' } }, senders.contentScript);
  await flush();

  assert.equal(result.signInRequired, true);
  assert.equal(env.fetchCalls[0].headers.get('authorization'), 'Bearer secret-token');
  assert.equal(env.session.data.get('lamissAuth').accessToken, 'newer-token');
  assert.ok(!env.runtimeSent.some(message => message.type === 'lamiss:auth-changed'));
});

test('the offscreen 401 report is checked only for the current token', async () => {
  const env = backgroundEnv({
    extra: async (url) => url.endsWith('/api/auth/me') ? { status: 401, json: { detail: 'Unauthenticated' } } : undefined
  });
  signIn(env);

  await env.dispatchMessage({ type: 'lamiss:session-rejected', rejectedToken: 'older-token' }, senders.offscreen);
  await flush();
  assert.equal(env.fetchCalls.length, 0);
  assert.equal(env.session.data.get('lamissAuth').accessToken, 'secret-token');

  await env.dispatchMessage({ type: 'lamiss:session-rejected', rejectedToken: 'secret-token' }, senders.offscreen);
  await flush();
  assert.equal(env.fetchCalls[0].url, `${API_BASE_URL}/api/auth/me`);
  assert.equal(env.fetchCalls[0].headers.get('authorization'), 'Bearer secret-token');
  assert.deepEqual(plain(env.session.data.get('lamissAuth')), { expired: true });
});

test('signing in again moves open live sockets to the new session', async () => {
  const env = backgroundEnv({ extra: liveBackend('second-token') });
  signIn(env);
  await openLive(env);
  const oldSocket = env.FakeWebSocket.instances[0];
  googleSignsIn(env);

  const result = await env.dispatchMessage({ type: 'lamiss:sign-in' }, senders.popup);
  await flush();

  assert.equal(result.ok, true);
  assert.equal(oldSocket.closedWith.code, 1000);
  assert.equal(env.FakeWebSocket.instances.length, 2);
  assert.match(env.FakeWebSocket.instances[1].url, /ticket=ticket-for-second-token$/);
  // The old socket's own close event, arriving late, changes nothing.
  oldSocket.emit('close', { code: 4401, reason: '' });
  await flush();
  assert.equal(env.session.data.get('lamissAuth').accessToken, 'second-token');
  assert.equal(env.FakeWebSocket.instances.length, 2);
});
