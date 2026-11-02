// Builds, validates and zips the extension for one environment
// (docs/RELEASING.md):
//
//   node scripts/package.js [--env production|staging|development]
//
// 1. A clean dist/<env>/extension/ with the compiled TypeScript and the
//    static files, configured by scripts/build.js for that environment.
//    Scripts nothing in the extension loads (test-only modules) are left out.
// 2. scripts/lib/validate-package.js: refuses to go on if anything is wrong.
// 3. dist/lamiss-<version>-<env>.zip, byte-identical for the same sources,
//    and its SHA-256.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { listFiles, referencedScripts, validatePackage } = require('./lib/validate-package');
const { writeZip } = require('./lib/zip');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const envFlag = args.indexOf('--env');
const environment = envFlag >= 0 ? args[envFlag + 1] : 'production';

function fail(message) {
  console.error(`Lamiss package: ${message}`);
  process.exit(1);
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', env: { ...process.env, LAMISS_ENV: environment } });
  if (result.status !== 0) {
    fail(`${path.basename(command)} ${commandArgs.join(' ')} failed`);
  }
}

const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const outDir = path.join(root, 'dist', environment, 'extension');
fs.rmSync(outDir, { recursive: true, force: true });

run(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json', '--outDir', outDir]);
run(process.execPath, [path.join(__dirname, 'build.js'), outDir, '--env', environment]);

// tsc compiles every file under src/; scripts only the tests use don't ship.
const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
const loaded = referencedScripts(outDir, manifest);
for (const file of listFiles(outDir).filter(name => name.endsWith('.js') && !loaded.has(name))) {
  fs.rmSync(path.join(outDir, file));
  console.log(`Lamiss package: left out ${file} (nothing in the extension loads it)`);
}

const problems = validatePackage(outDir, { environment, expectedVersion: version });
if (problems.length > 0) {
  fail(`the package is not valid:\n  - ${problems.join('\n  - ')}`);
}

const zipPath = path.join(root, 'dist', `lamiss-${version}-${environment}.zip`);
const files = listFiles(outDir);
writeZip(outDir, files, zipPath);
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
fs.writeFileSync(`${zipPath}.sha256`, `${sha256}  ${path.basename(zipPath)}\n`);
console.log(`Lamiss package: ${path.relative(root, zipPath)} (${files.length} files, sha256 ${sha256})`);
