const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const compiledDir = path.join(root, 'compiled');
const sourceManifest = path.join(root, 'manifest.json');
const sourcePopupHtml = path.join(root, 'src', 'popup', 'popup.html');

function fail(message) {
  console.error(`Lamiss POC build helper: ${message}`);
  process.exit(1);
}

function ensureFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    fail(`${label} not found: ${filePath}`);
  }
}

function copyFile(source, destination) {
  const destinationDir = path.dirname(destination);
  fs.mkdirSync(destinationDir, { recursive: true });
  fs.copyFileSync(source, destination);
}

ensureFile(sourceManifest, 'Root manifest.json');
ensureFile(sourcePopupHtml, 'Popup HTML source');

fs.mkdirSync(compiledDir, { recursive: true });
fs.mkdirSync(path.join(compiledDir, 'popup'), { recursive: true });
fs.mkdirSync(path.join(compiledDir, 'content'), { recursive: true });

copyFile(sourceManifest, path.join(compiledDir, 'manifest.json'));
copyFile(sourcePopupHtml, path.join(compiledDir, 'popup', 'popup.html'));

console.log('Lamiss POC build helper: copied static extension files into compiled/.');
