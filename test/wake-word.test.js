// "Hey Lamiss" (Lamiss#85): the openWakeWord pipeline ported to
// onnxruntime-web (compiled/offscreen/wake-word.js), with a fake runtime for
// its buffering and, when the models were fetched (npm run fetch:wakeword)
// and macOS's `say` is there, with the real models on spoken audio.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { createExtensionEnv } = require('./helpers/extension-env');

const root = path.resolve(__dirname, '..');
// Arrays from the vm context aren't this realm's: compare them as plain values.
const plain = (value) => JSON.parse(JSON.stringify(value));

function loadPipeline() {
  const context = vm.createContext({ console, Float32Array, Math, Number, Object, Array, Promise });
  vm.runInContext(`${fs.readFileSync(path.join(root, 'compiled/offscreen/wake-word.js'), 'utf8')}\nthis.WakeWordPipeline = WakeWordPipeline;`, context);
  return context.WakeWordPipeline;
}

// A fake onnxruntime: records every run; the melspectrogram gives
// ceil(samples / 160 - 3) frames of 32 values equal to 10 (so 3 after x / 10 + 2),
// the embedding 96 values, and the wake word model the scores it is given.
function fakeOrt(scores = []) {
  const runs = { mel: [], embedding: [], wake: [] };
  class Tensor {
    constructor(type, data, dims) {
      Object.assign(this, { type, data, dims });
    }
  }
  const session = (kind, inputNames, output) => ({
    inputNames,
    async run(feeds) {
      runs[kind].push(feeds);
      return { out: { data: output(Object.values(feeds)[0]) } };
    }
  });
  const sessions = [
    session('mel', ['input'], (tensor) => new Float32Array(Math.ceil(tensor.dims[1] / 160 - 3) * 32).fill(10)),
    session('embedding', ['input_1'], () => new Float32Array(96).fill(0.5)),
    session('wake', ['x.1'], () => new Float32Array([scores.length > 0 ? scores.shift() : 0.9]))
  ];
  return {
    runs,
    ort: { Tensor, InferenceSession: { create: async () => sessions.shift() } }
  };
}

const models = { melspectrogram: new Uint8Array(), embedding: new Uint8Array(), wakeWord: new Uint8Array() };

test('wake word: starts like openWakeWord, from the embeddings of 4 s of noise', async () => {
  const WakeWordPipeline = loadPipeline();
  const fake = fakeOrt();
  await WakeWordPipeline.create(fake.ort, models, () => 0.5);
  assert.equal(fake.runs.mel.length, 1);
  assert.deepEqual(plain(fake.runs.mel[0].input.dims), [1, 64_000]);
  // ceil(64000 / 160 - 3) = 397 frames: windows of 76, every 8 frames.
  assert.equal(fake.runs.embedding.length, 41);
});

test('wake word: each 80 ms chunk feeds 1760 samples, 76 mel frames and the last 16 embeddings, by name', async () => {
  const WakeWordPipeline = loadPipeline();
  const fake = fakeOrt();
  const pipeline = await WakeWordPipeline.create(fake.ort, models);
  fake.runs.mel.length = 0;
  fake.runs.embedding.length = 0;

  assert.equal(await pipeline.process(new Float32Array(1000)), undefined, 'not a whole chunk yet');
  assert.equal(await pipeline.process(new Float32Array(1000)), 0, 'one chunk: a warm-up score');
  assert.deepEqual(plain(fake.runs.mel[0].input.dims), [1, 1280], 'no context before the first chunk');
  await pipeline.process(new Float32Array(1280));
  assert.deepEqual(plain(fake.runs.mel[1].input.dims), [1, 1760], 'then 480 samples of context');

  const embeddingInput = fake.runs.embedding.at(-1).input_1;
  assert.deepEqual(plain(embeddingInput.dims), [1, 76, 32, 1]);
  assert.equal(embeddingInput.data.at(-1), 3, 'mel values transformed as x / 10 + 2');
  const wakeInput = fake.runs.wake.at(-1)['x.1'];
  assert.deepEqual(plain(wakeInput.dims), [1, 16, 96], 'the model\'s own input name');
});

test('wake word: the first 5 scores are 0, then the model\'s; several chunks give the highest', async () => {
  const WakeWordPipeline = loadPipeline();
  const fake = fakeOrt([0.9, 0.9, 0.9, 0.9, 0.9, 0.2, 0.7, 0.4]);
  const pipeline = await WakeWordPipeline.create(fake.ort, models);
  const scores = [];
  for (let i = 0; i < 6; i += 1) {
    scores.push(await pipeline.process(new Float32Array(1280)));
  }
  assert.deepEqual(scores.slice(0, 5), [0, 0, 0, 0, 0]);
  assert.ok(Math.abs(scores[5] - 0.2) < 1e-6, 'float32 scores');
  assert.ok(Math.abs(await pipeline.process(new Float32Array(2560)) - 0.7) < 1e-6);
});

test('wake word: a detection needs the threshold, and none while Lamiss speaks or listens, or within 3 s', () => {
  const env = createExtensionEnv({
    scripts: ['shared/lamiss-config.js', 'shared/lamiss-i18n.js', 'shared/lamiss-api.js', 'offscreen/wake-word.js', 'offscreen/offscreen.js'],
    withoutSessionStorage: true
  });
  const detected = (score, now, lastDetectedAt = 0, quietUntil = 0, busy = false) =>
    env.run(`lamissWakeDetected(${score}, 0.5, ${now}, ${lastDetectedAt}, ${quietUntil}, ${busy})`);
  assert.equal(detected(0.6, 10_000), true);
  assert.equal(detected(0.4, 10_000), false, 'under the threshold');
  assert.equal(detected(0.9, 10_000, 8_000), false, 'within 3 s of the last detection');
  assert.equal(detected(0.9, 11_000, 8_000), true);
  assert.equal(detected(0.9, 10_000, 0, 10_500), false, 'just after Lamiss spoke');
  assert.equal(detected(0.9, 10_000, 0, 0, true), false, 'while Lamiss speaks or listens');
});

// macOS voices saying the phrases, as 16 kHz int16 samples.
function spoken(text, voice) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lamiss-wake-'));
  try {
    execFileSync('say', ['-v', voice, '-o', path.join(dir, 'a.aiff'), text]);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', path.join(dir, 'a.aiff'), path.join(dir, 'a.wav')]);
    const bytes = fs.readFileSync(path.join(dir, 'a.wav'));
    for (let offset = 12; offset < bytes.length;) {
      const size = bytes.readUInt32LE(offset + 4);
      if (bytes.toString('ascii', offset, offset + 4) === 'data') {
        return Float32Array.from({ length: size / 2 }, (_, i) => bytes.readInt16LE(offset + 8 + i * 2));
      }
      offset += 8 + size;
    }
    throw new Error('no audio');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const vendor = path.join(root, 'vendor', 'openwakeword');
const haveModels = ['melspectrogram.onnx', 'embedding_model.onnx', 'dev/hey_jarvis_v0.1.onnx'].every(file => fs.existsSync(path.join(vendor, file)));
const haveVoices = process.platform === 'darwin';

test('wake word: the real models hear "hey jarvis" and nothing else', { skip: !(haveModels && haveVoices) && 'needs npm run fetch:wakeword and macOS voices' }, async () => {
  const ort = require('onnxruntime-web');
  ort.env.wasm.numThreads = 1;
  const WakeWordPipeline = loadPipeline();
  const real = {
    melspectrogram: fs.readFileSync(path.join(vendor, 'melspectrogram.onnx')),
    embedding: fs.readFileSync(path.join(vendor, 'embedding_model.onnx')),
    wakeWord: fs.readFileSync(path.join(vendor, 'dev/hey_jarvis_v0.1.onnx'))
  };
  const silence = new Float32Array(16_000);
  const highest = async (speech) => {
    const pipeline = await WakeWordPipeline.create(ort, real);
    const audio = Float32Array.from([...silence, ...speech, ...silence]);
    let best = 0;
    for (let i = 0; i < audio.length; i += 1600) {
      best = Math.max(best, (await pipeline.process(audio.subarray(i, i + 1600))) ?? 0);
    }
    return best;
  };
  for (const voice of ['Samantha', 'Daniel']) {
    assert.ok(await highest(spoken('hey jarvis', voice)) > 0.9, `"hey jarvis" by ${voice}`);
  }
  assert.ok(await highest(spoken('what is the man holding in his right hand', 'Samantha')) < 0.5);
  assert.ok(await highest(new Float32Array(32_000)) < 0.5, 'silence');
});
