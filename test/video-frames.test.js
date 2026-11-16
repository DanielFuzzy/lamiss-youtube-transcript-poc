// Frames of the video for questions about what it shows (Lamiss#88): the
// current frame and one from about 2 s earlier, scaled to 512 px, as JPEG;
// none for a protected (black or unreadable) video. Runs compiled/content/video-frames.js
// with small stand-ins for the browser's image APIs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createExtensionEnv, senders } = require('./helpers/extension-env');

const BRIGHT = new Uint8ClampedArray(16 * 16 * 4).fill(200);
const BLACK = new Uint8ClampedArray(16 * 16 * 4).fill(0);

function framesEnv() {
  const page = { pixels: BRIGHT, bitmapError: null, ad: false, bitmaps: [] };
  const video = { readyState: 4, videoWidth: 1280, videoHeight: 720, paused: false };
  class FakeOffscreenCanvas {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() {
      return { drawImage() {}, getImageData: () => ({ data: page.pixels }) };
    }
    async convertToBlob(options) { return new Blob([`jpeg ${this.width}x${this.height}`], { type: options.type }); }
  }
  class FakeFileReader {
    readAsDataURL(blob) {
      blob.text().then((text) => {
        this.result = `data:${blob.type};base64,${Buffer.from(text).toString('base64')}`;
        this.onload();
      });
    }
  }
  const env = createExtensionEnv({
    scripts: ['shared/lamiss-config.js', 'shared/lamiss-i18n.js', 'shared/lamiss-api.js', 'content/video-frames.js'],
    withoutSessionStorage: true,
    globals: {
      window: { setInterval: () => 1, clearInterval: () => undefined },
      OffscreenCanvas: FakeOffscreenCanvas,
      FileReader: FakeFileReader,
      createImageBitmap: async (_source, options) => {
        if (page.bitmapError) {
          throw page.bitmapError;
        }
        const bitmap = { width: options.resizeWidth, height: options.resizeHeight, closed: false, close() { this.closed = true; } };
        page.bitmaps.push(bitmap);
        return bitmap;
      },
      // From youtube.js, which loads after this file.
      getLamissVideo: () => video,
      getLamissPlayer: () => ({ classList: { contains: name => name === 'ad-showing' && page.ad } })
    }
  });
  return { env, page, video, capture: () => env.run('captureLamissFrames()') };
}

const decode = url => Buffer.from(url.split(',')[1], 'base64').toString();

test('frames: the frame now and one from about 2 s earlier, 512 px wide, as JPEG data URLs', async () => {
  const { env, capture, page } = framesEnv();
  env.context.earlier = { width: 512, height: 288, close() {} };
  env.run('lamissFrameHistory.push({ at: Date.now() - 5000, bitmap: { width: 1, height: 1, close() {} } }, { at: Date.now() - 2100, bitmap: earlier })');

  const frames = await capture();

  assert.equal(frames.length, 2);
  assert.match(frames[0], /^data:image\/jpeg;base64,/);
  assert.equal(decode(frames[0]), 'jpeg 512x288', 'the one closest to 2 s ago');
  assert.equal(decode(frames[1]), 'jpeg 512x288', 'now, scaled to 512 px keeping 16:9');
  assert.equal(page.bitmaps.at(-1).closed, true, 'the frame taken now is released');
});

test('frames: without an earlier frame (just started), only the frame now', async () => {
  const { capture } = framesEnv();
  assert.equal((await capture()).length, 1);
});

test('frames: a protected video (black frames, or frames that cannot be copied) sends nothing', async () => {
  const black = framesEnv();
  black.page.pixels = BLACK;
  assert.deepEqual([...await black.capture()], []);

  const refused = framesEnv();
  refused.page.bitmapError = new Error('SecurityError');
  assert.deepEqual([...await refused.capture()], []);
});

test('frames: nothing during an ad, nor before the video has a picture', async () => {
  const ad = framesEnv();
  ad.page.ad = true;
  assert.deepEqual([...await ad.capture()], []);

  const loading = framesEnv();
  loading.video.readyState = 1;
  assert.deepEqual([...await loading.capture()], []);
});

test('frames: a black frame is one with nearly no bright pixels', () => {
  const { env } = framesEnv();
  env.context.pixels = BLACK;
  assert.equal(env.run('isLamissFrameBlack(pixels)'), true);
  env.context.pixels = BRIGHT;
  assert.equal(env.run('isLamissFrameBlack(pixels)'), false);
  // A dark scene with a few lit pixels is still a picture.
  const dark = new Uint8ClampedArray(16 * 16 * 4).fill(5);
  for (let i = 0; i < 4 * 8; i += 4) {
    dark[i] = dark[i + 1] = dark[i + 2] = 180;
  }
  env.context.pixels = dark;
  assert.equal(env.run('isLamissFrameBlack(pixels)'), false);
});

test("frames: only this extension's pages may ask for them, such as the chat panel framed in the tab", async () => {
  const { env } = framesEnv();
  assert.equal(await env.dispatchMessage({ type: 'lamiss:capture-frames' }, senders.contentScript), undefined);
  assert.equal(await env.dispatchMessage({ type: 'lamiss:capture-frames' }, senders.otherExtension), undefined);
  assert.equal(await env.dispatchMessage({ type: 'lamiss:capture-frames' }, senders.otherSite), undefined);
  // The chat panel is an extension page inside the YouTube tab (sender.tab is set).
  const reply = await env.dispatchMessage({ type: 'lamiss:capture-frames' }, senders.chat);
  assert.equal(reply.frames.length, 1);
});
