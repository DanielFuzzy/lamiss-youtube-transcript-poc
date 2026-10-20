// Loads the compiled extension scripts into a Node vm context with small
// chrome.* and fetch stubs, the way Chrome loads them: classic scripts that
// share one global scope. Run `npm run build` first (npm test does).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const compiledDir = path.resolve(__dirname, '..', '..', 'compiled');

const EXTENSION_ID = 'fjjelpamfjfkndcgjdfmkjglkimhokec';
const API_BASE_URL = 'https://api.lamiss.test';
const GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';

function createStorageArea() {
  const data = new Map();
  const writes = [];
  const pick = (keys) => {
    if (keys === null || keys === undefined) {
      return Object.fromEntries(data);
    }
    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const result = {};
    for (const key of list) {
      if (data.has(key)) {
        result[key] = structuredClone(data.get(key));
      }
    }
    return result;
  };
  return {
    data,
    writes,
    accessLevel: undefined,
    async get(keys) {
      return pick(keys);
    },
    async set(items) {
      writes.push(structuredClone(items));
      for (const [key, value] of Object.entries(items)) {
        data.set(key, structuredClone(value));
      }
    },
    async remove(keys) {
      for (const key of typeof keys === 'string' ? [keys] : keys) {
        data.delete(key);
      }
    },
    async setAccessLevel(options) {
      this.accessLevel = options.accessLevel;
    }
  };
}

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    }
  };
}

// fetch stub: `responder(url, init)` returns { status, body, json } or throws.
function createFetch(calls, responder) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init, headers: new Headers(init.headers) });
    const reply = await responder(String(url), init);
    const status = reply.status ?? 200;
    const body = reply.json !== undefined ? JSON.stringify(reply.json) : (reply.body ?? null);
    return new Response(status === 204 ? null : body, {
      status,
      headers: reply.json !== undefined ? { 'Content-Type': 'application/json' } : {}
    });
  };
}

class FakeWebSocket {
  static instances = [];
  static OPEN = 1;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = {};
    this.closedWith = undefined;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  send(data) {
    this.sent.push(data);
  }
  close(code, reason) {
    this.closedWith = { code, reason };
    this.readyState = 3;
  }
  emit(type, event = {}) {
    for (const listener of this.listeners[type] ?? []) {
      listener(event);
    }
  }
}

// options.scripts: compiled files to load, in order (paths under compiled/).
// options.withoutSessionStorage: a content-script context.
// options.globals: more globals for the scripts, added before they load.
function createExtensionEnv(options = {}) {
  const fetchCalls = [];
  let responder = options.responder ?? (async () => ({ status: 404, json: { detail: 'not stubbed' } }));
  const local = createStorageArea();
  const session = createStorageArea();
  const runtimeSent = [];
  const tabsSent = [];
  const logs = [];
  const onMessage = createEvent();
  const onConnect = createEvent();
  const onStartup = createEvent();
  const storageChanged = createEvent();

  const identity = {
    launches: [],
    launchWebAuthFlow: async () => undefined,
    getRedirectURL: () => `https://${EXTENSION_ID}.chromiumapp.org/`
  };

  const storage = {
    local,
    onChanged: storageChanged
  };
  if (!options.withoutSessionStorage) {
    storage.session = session;
  }

  const chrome = {
    runtime: {
      id: EXTENSION_ID,
      lastError: undefined,
      getURL: (file = '') => `chrome-extension://${EXTENSION_ID}/${file}`,
      sendMessage: async (message) => {
        runtimeSent.push(structuredClone(message));
        return undefined;
      },
      getContexts: async () => [],
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
      onMessage,
      onConnect,
      onStartup
    },
    identity: {
      launchWebAuthFlow: (details) => {
        identity.launches.push(details);
        return identity.launchWebAuthFlow(details);
      },
      getRedirectURL: () => identity.getRedirectURL()
    },
    storage,
    tabs: {
      query: async () => options.tabs ?? [],
      sendMessage: async (tabId, message) => {
        tabsSent.push({ tabId, message: structuredClone(message) });
      },
      create: async () => ({})
    },
    webRequest: { onBeforeRequest: createEvent() },
    scripting: { executeScript: async () => [] },
    offscreen: {
      createDocument: async () => undefined,
      Reason: { USER_MEDIA: 'USER_MEDIA', AUDIO_PLAYBACK: 'AUDIO_PLAYBACK' }
    }
  };

  const capture = (level) => (...args) => logs.push({ level, text: args.map(arg => {
    try {
      return typeof arg === 'string' ? arg : JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }).join(' ') });

  FakeWebSocket.instances = [];
  const context = vm.createContext({
    chrome,
    console: { log: capture('log'), info: capture('info'), warn: capture('warn'), error: capture('error') },
    fetch: (...args) => createFetch(fetchCalls, responder)(...args),
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    FormData,
    Blob,
    TextDecoder,
    TextEncoder,
    DOMException,
    crypto: globalThis.crypto,
    btoa,
    atob,
    structuredClone,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    WebSocket: FakeWebSocket,
    // Extra globals a script needs (document, navigator, Audio, …).
    ...(options.globals ?? {})
  });

  const load = (file) => {
    const code = fs.readFileSync(path.join(compiledDir, file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  };

  // Stands in for the generated shared/lamiss-config.js.
  context.importScripts = (...files) => {
    for (const file of files) {
      if (file === 'shared/lamiss-config.js') {
        vm.runInContext([
          '"use strict";',
          `const LAMISS_API_BASE_URL = ${JSON.stringify(API_BASE_URL)};`,
          `const LAMISS_WS_BASE_URL = ${JSON.stringify(API_BASE_URL.replace('https:', 'wss:'))};`,
          `const LAMISS_GOOGLE_CLIENT_ID = ${JSON.stringify(options.googleClientId ?? GOOGLE_CLIENT_ID)};`
        ].join('\n'), context, { filename: file });
      } else {
        load(file);
      }
    }
  };

  context.importScripts(...(options.scripts ?? ['shared/lamiss-config.js', 'shared/lamiss-api.js', 'shared/lamiss-auth.js']));

  // Delivers a message the way chrome.runtime.onMessage does: every listener
  // sees it; the first sendResponse wins.
  function dispatchMessage(message, sender) {
    return new Promise((resolve) => {
      let asynchronous = false;
      let answered = false;
      const sendResponse = (response) => {
        if (!answered) {
          answered = true;
          resolve(response);
        }
      };
      for (const listener of onMessage.listeners) {
        if (listener(message, sender, sendResponse) === true) {
          asynchronous = true;
        }
      }
      if (!asynchronous && !answered) {
        resolve(undefined);
      }
    });
  }

  return {
    chrome,
    context,
    local,
    session,
    identity,
    fetchCalls,
    runtimeSent,
    tabsSent,
    logs,
    onMessage,
    onConnect,
    onStartup,
    FakeWebSocket,
    setResponder(next) {
      responder = next;
    },
    run(code) {
      return vm.runInContext(code, context);
    },
    dispatchMessage
  };
}

// Senders as Chrome reports them.
const senders = {
  popup: { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/popup/popup.html` },
  chat: { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/chat/chat.html?tabId=7&videoId=abc`, tab: { id: 7 } },
  offscreen: { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/offscreen/offscreen.html` },
  contentScript: { id: EXTENSION_ID, url: 'https://www.youtube.com/watch?v=LeRylkDym54', tab: { id: 7, url: 'https://www.youtube.com/watch?v=LeRylkDym54' } },
  otherExtension: { id: 'abcdefghijklmnopabcdefghijklmnop', url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html' },
  // Another extension's content script on YouTube: right page, wrong extension.
  otherExtensionContentScript: { id: 'abcdefghijklmnopabcdefghijklmnop', url: 'https://www.youtube.com/watch?v=LeRylkDym54', tab: { id: 7, url: 'https://www.youtube.com/watch?v=LeRylkDym54' } },
  otherSite: { id: EXTENSION_ID, url: 'https://evil.example/', tab: { id: 9, url: 'https://evil.example/' } }
};

// An unsigned JWT-shaped string with these claims (the backend verifies the real one).
function fakeIdToken(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}.signature`;
}

function futureIso(ms = 60 * 60 * 1000) {
  return new Date(Date.now() + ms).toISOString();
}

module.exports = { createExtensionEnv, senders, fakeIdToken, futureIso, EXTENSION_ID, API_BASE_URL, GOOGLE_CLIENT_ID };
