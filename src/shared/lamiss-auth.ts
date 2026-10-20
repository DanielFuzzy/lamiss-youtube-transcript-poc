// Google sign-in and the Lamiss access token (TDR-0001). A classic script,
// loaded after shared/lamiss-config.js and shared/lamiss-api.js by the
// background worker (importScripts) and the popup and chat pages (<script>).
// Content scripts never load it.
//
// The sign-in is permanent until the user signs out. The access token is kept
// in chrome.storage.session, whose TRUSTED_CONTEXTS access level keeps it away
// from content scripts, and a durable copy in the extension's own IndexedDB,
// which content scripts can't open either. Chrome empties session storage when
// the browser quits or the extension is reloaded; the copy brings the sign-in
// back. The token is never written to chrome.storage.local and never logged.

declare const LAMISS_GOOGLE_CLIENT_ID: string;

const LAMISS_AUTH_SESSION_KEY = 'lamissAuth';
// Not a credential: remembers that the user signed in, so the worker may try a
// silent sign-in after a browser restart. Signing out removes it.
const LAMISS_SIGNED_IN_BEFORE_KEY = 'lamissSignedInBefore';
const LAMISS_GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const LAMISS_GOOGLE_SCOPE = 'openid email profile';
const LAMISS_PENDING_QUESTION_PREFIX = 'lamissPendingQuestion:';

type LamissAuthSession = { accessToken: string; expiresAt: string; user: LamissAuthUser };

// What chrome.storage.session holds: the session, or a marker that the last
// one was rejected or ran out, so the UI can say "sign in again".
type LamissStoredAuth = LamissAuthSession | { expired: true };

type LamissAuthRedirectResult =
  | { ok: true; idToken: string }
  | { ok: false; reason: LamissSignInFailure; error: string };

// --- Pure helpers (covered by test/auth.test.js) ------------------------------

type LamissGoogleAuthRequest = {
  clientId: string;
  redirectUri: string;
  nonce: string;
  state: string;
  interactive: boolean;
};

function buildGoogleAuthUrl(request: LamissGoogleAuthRequest): string {
  const url = new URL(LAMISS_GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set('client_id', request.clientId);
  url.searchParams.set('response_type', 'id_token');
  url.searchParams.set('scope', LAMISS_GOOGLE_SCOPE);
  url.searchParams.set('redirect_uri', request.redirectUri);
  url.searchParams.set('nonce', request.nonce);
  url.searchParams.set('state', request.state);
  // Interactive: let the user pick the account. Silent: fail instead of asking.
  url.searchParams.set('prompt', request.interactive ? 'select_account' : 'none');
  return url.toString();
}

// 32 random bytes, base64url: the OAuth state.
function randomUrlSafeString(byteCount = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The claims of a JWT, unverified: only used to compare the nonce before the
// token goes to the backend, which does the real verification.
function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const part = token.split('.')[1];
  if (!part) {
    return undefined;
  }
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

// Google answers with https://<extension-id>.chromiumapp.org/#id_token=…&state=…
// or #error=…&state=…
function parseAuthRedirect(redirectUrl: string, expected: { redirectUri: string; state: string; nonce: string }): LamissAuthRedirectResult {
  const failed = (reason: LamissSignInFailure, error: string): LamissAuthRedirectResult => ({ ok: false, reason, error });

  let url: URL;
  let expectedUrl: URL;
  try {
    url = new URL(redirectUrl);
    expectedUrl = new URL(expected.redirectUri);
  } catch {
    return failed('failed', 'Google sign-in returned an invalid response.');
  }
  if (url.origin !== expectedUrl.origin || url.pathname !== expectedUrl.pathname) {
    return failed('failed', 'Google sign-in returned to an unexpected address.');
  }

  const params = new URLSearchParams(url.hash.replace(/^#/, ''));
  if (!expected.state || params.get('state') !== expected.state) {
    return failed('state_mismatch', 'Sign-in failed: the response did not match this request. Please try again.');
  }

  const error = params.get('error');
  if (error) {
    if (error === 'access_denied') {
      return failed('cancelled', 'Sign-in was cancelled.');
    }
    if (['interaction_required', 'login_required', 'consent_required', 'account_selection_required'].includes(error)) {
      return failed('interaction_required', 'Please sign in with Google.');
    }
    return failed('failed', `Google sign-in failed (${error}).`);
  }

  const idToken = params.get('id_token');
  if (!idToken) {
    return failed('failed', 'Google sign-in returned no credential.');
  }
  if (decodeJwtPayload(idToken)?.nonce !== expected.nonce) {
    return failed('nonce_mismatch', 'Sign-in failed: the response did not match this request. Please try again.');
  }
  return { ok: true, idToken };
}

// What a rejected launchWebAuthFlow means for the user. Chrome reports a closed
// window as "The user did not approve access." and a silent flow that needs
// the user as "User interaction required."
function describeAuthFlowError(error: unknown, interactive: boolean): { reason: LamissSignInFailure; error: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (!interactive) {
    return { reason: 'interaction_required', error: 'Please sign in with Google.' };
  }
  if (/did not approve|cancel|closed/i.test(message)) {
    return { reason: 'cancelled', error: 'Sign-in was cancelled.' };
  }
  return { reason: 'failed', error: `Google sign-in failed: ${message}` };
}

// An unreadable expiry counts as expired.
function isAuthExpired(expiresAt: string, now = Date.now()): boolean {
  const time = Date.parse(expiresAt);
  return !Number.isFinite(time) || time <= now;
}

function isAuthSession(value: unknown): value is LamissAuthSession {
  const session = value as Partial<LamissAuthSession> | null | undefined;
  return typeof session?.accessToken === 'string' && session.accessToken.length > 0
    && typeof session.expiresAt === 'string'
    && typeof session.user === 'object' && session.user !== null;
}

function authStateFromStored(stored: unknown, now = Date.now()): LamissAuthState {
  if (isAuthSession(stored)) {
    return isAuthExpired(stored.expiresAt, now)
      ? { status: 'expired' }
      : { status: 'signedIn', user: stored.user, expiresAt: stored.expiresAt };
  }
  if ((stored as { expired?: unknown } | undefined)?.expired === true) {
    return { status: 'expired' };
  }
  return { status: 'signedOut' };
}

// The response of POST /api/auth/google, checked before anything is stored.
function readGoogleSignInResponse(data: unknown): LamissAuthSession | undefined {
  const body = data as { accessToken?: unknown; tokenType?: unknown; expiresAt?: unknown; user?: Partial<LamissAuthUser> } | null;
  if (typeof body?.accessToken !== 'string' || !body.accessToken
    || (body.tokenType !== undefined && body.tokenType !== 'Bearer')
    || typeof body.expiresAt !== 'string' || isAuthExpired(body.expiresAt)
    || typeof body.user?.id !== 'number' || typeof body.user.email !== 'string' || typeof body.user.username !== 'string') {
    return undefined;
  }
  return {
    accessToken: body.accessToken,
    expiresAt: body.expiresAt,
    user: { id: body.user.id, email: body.user.email, username: body.user.username }
  };
}

// --- Storage --------------------------------------------------------------------

const LAMISS_AUTH_DATABASE = 'lamiss-auth';
const LAMISS_AUTH_DATABASE_STORE = 'auth';

// The extension origin's IndexedDB: the worker, popup and chat share it.
// Undefined where there is none (tests) or it can't open: session storage alone.
function openAuthDatabase(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(LAMISS_AUTH_DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(LAMISS_AUTH_DATABASE_STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
      request.onblocked = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

async function withAuthDatabase(mode: IDBTransactionMode, use: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
  const database = await openAuthDatabase();
  if (!database) {
    return undefined;
  }
  try {
    return await new Promise<unknown>((resolve) => {
      const transaction = database.transaction(LAMISS_AUTH_DATABASE_STORE, mode);
      const request = use(transaction.objectStore(LAMISS_AUTH_DATABASE_STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => resolve(undefined);
      transaction.onabort = () => resolve(undefined);
    });
  } catch {
    return undefined;
  } finally {
    database.close();
  }
}

function writeDurableAuth(value: LamissStoredAuth | undefined): Promise<unknown> {
  return withAuthDatabase('readwrite', store => value === undefined
    ? store.delete(LAMISS_AUTH_SESSION_KEY)
    : store.put(value, LAMISS_AUTH_SESSION_KEY));
}

async function readStoredAuth(): Promise<unknown> {
  if (!chrome.storage.session) {
    // No session storage here (a content script): signed out.
    return undefined;
  }
  try {
    const stored = await chrome.storage.session.get(LAMISS_AUTH_SESSION_KEY);
    if (stored[LAMISS_AUTH_SESSION_KEY] !== undefined) {
      return stored[LAMISS_AUTH_SESSION_KEY];
    }
  } catch {
    return undefined;
  }
  // Emptied by a browser restart or an extension reload: restore the copy.
  const durable = await withAuthDatabase('readonly', store => store.get(LAMISS_AUTH_SESSION_KEY));
  if (durable !== undefined) {
    await chrome.storage.session.set({ [LAMISS_AUTH_SESSION_KEY]: durable }).catch(() => undefined);
  }
  return durable;
}

async function readAuthState(): Promise<LamissAuthState> {
  return authStateFromStored(await readStoredAuth());
}

// The token, while it is valid; never once it has expired.
async function readAccessToken(): Promise<string | undefined> {
  const stored = await readStoredAuth();
  return isAuthSession(stored) && !isAuthExpired(stored.expiresAt) ? stored.accessToken : undefined;
}

// The stored token even past its expiry: logout still revokes it.
async function readStoredAccessToken(): Promise<string | undefined> {
  const stored = await readStoredAuth();
  return isAuthSession(stored) ? stored.accessToken : undefined;
}

// The durable copy is written first and removed first: a read that finds
// session storage empty never restores a session that is being replaced.
async function storeAuthSession(session: LamissAuthSession): Promise<void> {
  await writeDurableAuth(session);
  await chrome.storage.session.set({ [LAMISS_AUTH_SESSION_KEY]: session });
}

async function markAuthExpired(): Promise<void> {
  const marker: LamissStoredAuth = { expired: true };
  await writeDurableAuth(marker);
  await chrome.storage.session.set({ [LAMISS_AUTH_SESSION_KEY]: marker });
}

async function clearAuthSession(): Promise<void> {
  await writeDurableAuth(undefined);
  await chrome.storage.session.remove(LAMISS_AUTH_SESSION_KEY);
}

// Lamiss's unanswered questions belong to the signed-in user.
async function removePendingQuestions(): Promise<void> {
  const everything = await chrome.storage.local.get(null);
  const keys = Object.keys(everything).filter(key => key.startsWith(LAMISS_PENDING_QUESTION_PREFIX));
  if (keys.length > 0) {
    await chrome.storage.local.remove(keys);
  }
}

// --- Broadcasting -----------------------------------------------------------------

// Extension pages get the whole state; YouTube tabs (content scripts and the
// chat frames inside them) only the status.
async function broadcastAuthState(state: LamissAuthState): Promise<void> {
  const full: LamissAuthChangedMessage = { type: LAMISS_AUTH_CHANGED_MESSAGE, state };
  const statusOnly: LamissAuthChangedMessage = { type: LAMISS_AUTH_CHANGED_MESSAGE, state: { status: state.status } };
  // Rejects when no other extension page is open.
  await chrome.runtime.sendMessage(full).catch(() => undefined);
  try {
    const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
    await Promise.all(tabs.map(tab => tab.id === undefined
      ? undefined
      : chrome.tabs.sendMessage(tab.id, statusOnly).catch(() => undefined)));
  } catch {
    // No tabs API here.
  }
}

// A 401 on a call that carried rejectedToken: that session was revoked or ran
// out. Only ends the stored session if it is that same one: a request (or a
// socket) of an older session can fail after the user signed in again.
// Resolves to whether the stored session was ended.
async function rejectAuthSession(rejectedToken: string): Promise<boolean> {
  const stored = await readStoredAuth();
  if (!rejectedToken || !isAuthSession(stored) || stored.accessToken !== rejectedToken) {
    return false;
  }
  await markAuthExpired();
  await broadcastAuthState({ status: 'expired' });
  return true;
}

lamissReadAccessToken = readAccessToken;
lamissOnSessionRejected = async (rejectedToken) => {
  await rejectAuthSession(rejectedToken);
};
