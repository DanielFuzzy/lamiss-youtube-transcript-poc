// Checks a built extension directory before it is zipped (docs/RELEASING.md):
// Manifest V3 fields, that every file the manifest and pages point at is
// there, the minimum permissions, the backend address, and that nothing
// that shouldn't ship (sources, maps, .env, localhost) is in it.
// Returns a list of problems; empty means the package is valid.
'use strict';

const fs = require('fs');
const path = require('path');

// What the extension actually uses (README.md, "Permissions"). Anything else
// is a mistake until it's justified there and in the store listing.
const ALLOWED_PERMISSIONS = ['scripting', 'webRequest', 'storage', 'offscreen', 'identity'];
const YOUTUBE_HOST_PERMISSION = 'https://www.youtube.com/*';
const ALLOWED_EXTENSIONS = new Set(['.js', '.html', '.css', '.json', '.png', '.svg']);
const ICON_SIZES = ['16', '32', '48', '128'];
const LOCAL_ADDRESS = /\b(localhost|127\.0\.0\.1|0\.0\.0\.0)\b|\[::1\]/;

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full).split(path.sep).join('/')];
  }).sort();
}

// Width and height from a PNG's IHDR chunk, or undefined if it isn't a PNG.
function pngSize(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.length < 24 || bytes.toString('ascii', 1, 4) !== 'PNG') {
    return undefined;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// The value of a `const NAME = "...";` line in the generated config.
function configValue(source, name) {
  return source.match(new RegExp(`const ${name} = (".*?");`))?.[1] && JSON.parse(source.match(new RegExp(`const ${name} = (".*?");`))[1]);
}

// Every script the manifest, the pages or the service worker load, and
// those scripts' own pages: a .js file outside this set is never run.
function referencedScripts(dir, manifest) {
  const referenced = new Set();
  const read = file => (fs.existsSync(path.join(dir, file)) ? fs.readFileSync(path.join(dir, file), 'utf8') : '');
  const worker = manifest.background?.service_worker;
  if (worker) {
    referenced.add(worker);
    for (const match of read(worker).matchAll(/importScripts\(([^)]*)\)/g)) {
      for (const file of match[1].matchAll(/'([^']+)'/g)) {
        referenced.add(file[1]);
      }
    }
  }
  for (const script of manifest.content_scripts ?? []) {
    (script.js ?? []).forEach(file => referenced.add(file));
  }
  for (const page of listFiles(dir).filter(file => file.endsWith('.html'))) {
    for (const match of read(page).matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) {
      referenced.add(path.posix.normalize(path.posix.join(path.posix.dirname(page), match[1])));
    }
  }
  return referenced;
}

function validatePackage(dir, { environment, expectedVersion } = {}) {
  const problems = [];
  const problem = message => problems.push(message);
  const exists = file => fs.existsSync(path.join(dir, file)) && fs.statSync(path.join(dir, file)).isFile();
  const needFile = (file, what) => {
    if (typeof file !== 'string' || !exists(file)) {
      problem(`${what} is missing from the package: ${file}`);
    }
  };

  if (!exists('manifest.json')) {
    return ['manifest.json is not at the package root'];
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch (error) {
    return [`manifest.json is not valid JSON: ${error.message}`];
  }
  const store = environment === 'production';
  const secure = environment === 'staging' || environment === 'production';

  // Manifest V3 basics.
  if (manifest.manifest_version !== 3) {
    problem(`manifest_version must be 3, got ${manifest.manifest_version}`);
  }
  if (typeof manifest.name !== 'string' || !manifest.name.trim() || manifest.name.length > 75) {
    problem('name must be 1 to 75 characters');
  }
  if (typeof manifest.description !== 'string' || !manifest.description.trim() || manifest.description.length > 132) {
    problem(`description must be 1 to 132 characters (the store's limit), got ${manifest.description?.length ?? 0}`);
  }
  const version = String(manifest.version ?? '');
  if (!/^\d+(\.\d+){0,3}$/.test(version) || version.split('.').some(part => Number(part) > 65535 || (part.length > 1 && part.startsWith('0')))) {
    problem(`version must be 1 to 4 dot-separated integers (0-65535, no leading zeros), got "${version}"`);
  }
  if (expectedVersion && version !== expectedVersion) {
    problem(`manifest version ${version} does not match package.json version ${expectedVersion}`);
  }
  if (store && 'key' in manifest) {
    problem('a Chrome Web Store package must not contain "key" (the store assigns the extension ID)');
  }
  if ('update_url' in manifest && store) {
    problem('a Chrome Web Store package must not set update_url');
  }

  // Icons: every size, real PNGs of that size.
  for (const size of ICON_SIZES) {
    const icon = manifest.icons?.[size];
    needFile(icon, `icon ${size}`);
    if (icon && exists(icon)) {
      const dimensions = pngSize(path.join(dir, icon));
      if (!dimensions || dimensions.width !== Number(size) || dimensions.height !== Number(size)) {
        problem(`icon ${size} must be a ${size}x${size} PNG: ${icon}`);
      }
    }
  }

  // Background, popup, content scripts, web-accessible resources.
  if (!manifest.background?.service_worker) {
    problem('background.service_worker is missing');
  } else {
    needFile(manifest.background.service_worker, 'the service worker');
    if (exists(manifest.background.service_worker)) {
      const worker = fs.readFileSync(path.join(dir, manifest.background.service_worker), 'utf8');
      for (const match of worker.matchAll(/importScripts\(([^)]*)\)/g)) {
        for (const file of match[1].matchAll(/'([^']+)'/g)) {
          needFile(file[1], 'a script the service worker imports');
        }
      }
    }
  }
  if (manifest.background?.persistent !== undefined) {
    problem('background.persistent is not allowed in Manifest V3');
  }
  needFile(manifest.action?.default_popup, 'the popup');
  for (const icon of Object.values(manifest.action?.default_icon ?? {})) {
    needFile(icon, 'a toolbar icon');
  }
  for (const [index, script] of (manifest.content_scripts ?? []).entries()) {
    for (const file of [...(script.js ?? []), ...(script.css ?? [])]) {
      needFile(file, `content script ${index}'s file`);
    }
    if ((script.matches ?? []).some(match => match === '<all_urls>' || match.startsWith('*://*/') || match === 'https://*/*')) {
      problem(`content script ${index} matches every site: ${script.matches.join(', ')}`);
    }
  }
  for (const entry of manifest.web_accessible_resources ?? []) {
    for (const file of entry.resources ?? []) {
      needFile(file, 'a web-accessible resource');
    }
    if ((entry.matches ?? []).includes('<all_urls>')) {
      problem('web-accessible resources are exposed to every site');
    }
  }

  // Scripts and styles the pages load.
  const files = listFiles(dir);
  for (const page of files.filter(file => file.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(dir, page), 'utf8');
    for (const match of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)) {
      const reference = match[1];
      if (/^(https?:)?\/\//.test(reference)) {
        problem(`${page} loads remote code or styles, which Manifest V3 forbids: ${reference}`);
        continue;
      }
      needFile(path.posix.normalize(path.posix.join(path.posix.dirname(page), reference)), `a file ${page} loads`);
    }
  }

  // Permissions: only what is used.
  for (const permission of manifest.permissions ?? []) {
    if (!ALLOWED_PERMISSIONS.includes(permission)) {
      problem(`permission "${permission}" is not one LAMISS uses (scripts/lib/validate-package.js)`);
    }
  }
  if (manifest.optional_permissions?.length || manifest.optional_host_permissions?.length) {
    problem('optional permissions are not used by LAMISS');
  }
  const hosts = manifest.host_permissions ?? [];
  if (!hosts.includes(YOUTUBE_HOST_PERMISSION)) {
    problem(`host_permissions must include ${YOUTUBE_HOST_PERMISSION}`);
  }
  for (const host of hosts) {
    if (host === '<all_urls>' || /^(\*|https?):\/\/\*\//.test(host)) {
      problem(`host permission "${host}" covers every site`);
    }
    if (secure && !host.startsWith('https://')) {
      problem(`host permission "${host}" is not https`);
    }
    if (secure && LOCAL_ADDRESS.test(host)) {
      problem(`host permission "${host}" is a local address`);
    }
  }

  // Content Security Policy: Chrome's default, or nothing looser.
  const csp = manifest.content_security_policy?.extension_pages ?? '';
  if (/unsafe-eval|unsafe-inline|https?:|\bdata:|\*/.test(csp)) {
    problem(`content_security_policy.extension_pages allows remote or inline code: ${csp}`);
  }

  // The backend address the build baked in.
  if (!exists('shared/lamiss-config.js')) {
    problem('shared/lamiss-config.js is missing');
  } else {
    const config = fs.readFileSync(path.join(dir, 'shared', 'lamiss-config.js'), 'utf8');
    const builtFor = configValue(config, 'LAMISS_ENVIRONMENT');
    const api = configValue(config, 'LAMISS_API_BASE_URL') ?? '';
    const ws = configValue(config, 'LAMISS_WS_BASE_URL') ?? '';
    if (environment && builtFor !== environment) {
      problem(`the package was built for "${builtFor}", not "${environment}"`);
    }
    if (!hosts.includes(`${api}/*`)) {
      problem(`host_permissions must include the backend ${api}/*`);
    }
    if (secure && (!api.startsWith('https://') || !ws.startsWith('wss://'))) {
      problem(`the backend must be https/wss outside development: ${api} ${ws}`);
    }
    if (secure && !configValue(config, 'LAMISS_GOOGLE_CLIENT_ID')) {
      problem('the Google client ID is missing: sign-in would not work');
    }
  }

  // Only what the extension needs, and no development leftovers.
  const scripts = referencedScripts(dir, manifest);
  for (const file of files) {
    if (file.endsWith('.js') && !scripts.has(file)) {
      problem(`script nothing loads (test-only or dead code): ${file}`);
    }
    const extension = path.posix.extname(file);
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      problem(`unexpected file in the package: ${file}`);
    }
    if (/(^|\/)\.|\.map$|\.ts$|(^|\/)node_modules\//.test(file)) {
      problem(`development file in the package: ${file}`);
    }
    if (secure && ['.js', '.html', '.json', '.css'].includes(extension)
      && LOCAL_ADDRESS.test(fs.readFileSync(path.join(dir, file), 'utf8'))) {
      problem(`${file} mentions a local address (localhost/127.0.0.1)`);
    }
  }
  return problems;
}

module.exports = { ALLOWED_PERMISSIONS, listFiles, referencedScripts, validatePackage };
