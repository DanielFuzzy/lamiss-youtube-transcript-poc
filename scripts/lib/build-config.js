// Resolves which backend a build of the extension talks to, from
// config/environments.json and (development only) the environment variables.
// Pure functions, so test/build-config.test.js can check every rule.
'use strict';

const ENVIRONMENTS = ['development', 'staging', 'production'];

// Hosts that only make sense on a developer's machine or private network.
function isLocalOrPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  if (host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) {
    return true;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) {
    return false;
  }
  const [a, b] = ipv4.slice(1).map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

// Scheme + host + optional port, nothing else. Throws with the reason.
function parseApiUrl(raw, { secure }) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`apiUrl is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`apiUrl must be http:// or https://, got ${raw}`);
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username || url.password) {
    throw new Error(`apiUrl must be only scheme, host and optional port (e.g. https://api.example.com), got ${raw}`);
  }
  if (secure && url.protocol !== 'https:') {
    throw new Error(`apiUrl must use https:// outside development (WebSocket then uses wss://), got ${raw}`);
  }
  if (secure && isLocalOrPrivateHost(url.hostname)) {
    throw new Error(`apiUrl must be a public host outside development, got ${raw}`);
  }
  return url;
}

function checkGoogleClientId(clientId) {
  if (!/^[A-Za-z0-9.-]+$/.test(clientId)) {
    throw new Error(`googleClientId contains unexpected characters: ${clientId}`);
  }
  if (!clientId.endsWith('.apps.googleusercontent.com')) {
    throw new Error(`googleClientId must end with .apps.googleusercontent.com, got ${clientId}`);
  }
}

/**
 * environments: the parsed config/environments.json; name: the environment
 * to build; env: process.env. Development may take LAMISS_API_URL and
 * LAMISS_GOOGLE_CLIENT_ID from env (custom endpoints for local testing);
 * staging and production refuse them, need https on a public host, and need
 * a Google client ID.
 */
function resolveBuildConfig(environments, name, env = {}) {
  if (!ENVIRONMENTS.includes(name)) {
    throw new Error(`unknown environment "${name}": use one of ${ENVIRONMENTS.join(', ')}`);
  }
  const settings = environments?.environments?.[name];
  if (!settings) {
    throw new Error(`config/environments.json has no "${name}" environment`);
  }
  const development = name === 'development';
  const allowOverrides = development && settings.allowOverrides === true;
  const overrides = ['LAMISS_API_URL', 'LAMISS_GOOGLE_CLIENT_ID'].filter(key => (env[key] ?? '').trim() !== '');
  if (overrides.length > 0 && !allowOverrides) {
    throw new Error(`${overrides.join(' and ')} can only override development builds; set ${name} in config/environments.json instead`);
  }

  const rawApiUrl = allowOverrides && env.LAMISS_API_URL ? env.LAMISS_API_URL.trim() : settings.apiUrl;
  if (!rawApiUrl) {
    throw new Error(`no apiUrl for "${name}": set environments.${name}.apiUrl in config/environments.json`);
  }
  const apiUrl = parseApiUrl(rawApiUrl, { secure: !development });

  const googleClientId = ((allowOverrides && env.LAMISS_GOOGLE_CLIENT_ID) || settings.googleClientId || '').trim();
  if (googleClientId) {
    checkGoogleClientId(googleClientId);
  } else if (!development) {
    throw new Error(`no googleClientId for "${name}": set environments.${name}.googleClientId in config/environments.json`);
  }

  return {
    environment: name,
    apiOrigin: apiUrl.origin,
    wsOrigin: `${apiUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${apiUrl.host}`,
    googleClientId,
    // A Chrome Web Store package: no manifest "key" (the store assigns the ID).
    chromeWebStore: settings.chromeWebStore === true
  };
}

module.exports = { ENVIRONMENTS, isLocalOrPrivateHost, parseApiUrl, resolveBuildConfig };
