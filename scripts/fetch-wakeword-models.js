// Downloads the openWakeWord files "Hey Lamiss" needs (Lamiss#85) into the
// git-ignored vendor/openwakeword/, checking each against its SHA-256:
//
//   npm run fetch:wakeword
//
// - melspectrogram.onnx and embedding_model.onnx: openWakeWord's shared
//   feature models (release v0.5.1). Their license isn't stated: settle it
//   before a release that includes them.
// - dev/hey_jarvis_v0.1.onnx: a pre-trained "hey jarvis" model, CC BY-NC-SA
//   4.0 (non-commercial): for local development builds only. The build never
//   puts it in a staging or production package, and the package check refuses it.
//
// The real model, vendor/openwakeword/hey_lamiss.onnx, comes from training
// (docs/wake-word.md) and is placed there by hand.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RELEASE = 'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1';
const FILES = [
  { url: `${RELEASE}/melspectrogram.onnx`, to: 'melspectrogram.onnx', sha256: 'ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f' },
  { url: `${RELEASE}/embedding_model.onnx`, to: 'embedding_model.onnx', sha256: '70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f' },
  { url: `${RELEASE}/hey_jarvis_v0.1.onnx`, to: 'dev/hey_jarvis_v0.1.onnx', sha256: '94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb' }
];
const dir = path.resolve(__dirname, '..', 'vendor', 'openwakeword');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

(async () => {
  for (const file of FILES) {
    const target = path.join(dir, file.to);
    if (fs.existsSync(target) && sha256(fs.readFileSync(target)) === file.sha256) {
      console.log(`ok       ${file.to}`);
      continue;
    }
    const response = await fetch(file.url);
    if (!response.ok) {
      throw new Error(`${file.url}: HTTP ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== file.sha256) {
      throw new Error(`${file.to}: checksum mismatch, not saved`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    console.log(`fetched  ${file.to} (${bytes.length} bytes)`);
  }
})().catch((error) => {
  console.error(`fetch-wakeword-models: ${error.message}`);
  process.exit(1);
});
