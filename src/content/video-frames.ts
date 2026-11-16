// Frames of the video for Lamiss's answers (Lamiss#88): with every question
// the learner asks, the current frame and one from about 2 s earlier go along,
// so Lamiss can answer "what is he holding?". Only the video itself is copied
// (none of YouTube's or Lamiss's overlays), scaled to 512 px wide, as JPEG.
//
// While a Lamiss session runs and the video plays, a frame is kept every second
// (the last few only, as ImageBitmaps: cheap, and encoded only when asked).
// Protected videos (rentals, some music videos) give black frames or refuse to
// be copied: then nothing is sent, and Lamiss says it can't see the video.
// Frames are never stored, here or on the backend. Loaded before youtube.js,
// which starts and stops it with the live session.

const LAMISS_FRAME_WIDTH = 512;
const LAMISS_FRAME_INTERVAL_MS = 1000;
const LAMISS_FRAME_HISTORY = 4;
// The earlier frame: about this long before the question.
const LAMISS_FRAME_EARLIER_MS = 2000;
const LAMISS_FRAME_JPEG_QUALITY = 0.8;
// Sampled this small to tell a black (protected) frame from a real one.
const LAMISS_FRAME_SAMPLE_SIZE = 16;

type LamissFrameSnapshot = { at: number; bitmap: ImageBitmap };

let lamissFrameHistory: LamissFrameSnapshot[] = [];
let lamissFrameTimer: number | undefined;

function startLamissFrames(): void {
  stopLamissFrames();
  lamissFrameTimer = window.setInterval(() => void keepLamissFrame(), LAMISS_FRAME_INTERVAL_MS);
}

function stopLamissFrames(): void {
  window.clearInterval(lamissFrameTimer);
  lamissFrameTimer = undefined;
  for (const snapshot of lamissFrameHistory) {
    snapshot.bitmap.close();
  }
  lamissFrameHistory = [];
}

// The video element to copy, unless there is none, it has no picture yet, or an ad plays.
function lamissFrameSource(): HTMLVideoElement | null {
  const video = getLamissVideo();
  if (!video || video.readyState < 2 || !video.videoWidth || getLamissPlayer()?.classList.contains('ad-showing')) {
    return null;
  }
  return video;
}

async function snapshotLamissFrame(video: HTMLVideoElement): Promise<ImageBitmap | null> {
  const height = Math.max(1, Math.round(LAMISS_FRAME_WIDTH * video.videoHeight / video.videoWidth));
  try {
    return await createImageBitmap(video, { resizeWidth: LAMISS_FRAME_WIDTH, resizeHeight: height, resizeQuality: 'medium' });
  } catch {
    // Protected content, or the video changed under us.
    return null;
  }
}

async function keepLamissFrame(): Promise<void> {
  const video = lamissFrameSource();
  if (!video || video.paused) {
    return;
  }
  const bitmap = await snapshotLamissFrame(video);
  if (!bitmap || lamissFrameTimer === undefined) {
    bitmap?.close();
    return;
  }
  lamissFrameHistory.push({ at: Date.now(), bitmap });
  while (lamissFrameHistory.length > LAMISS_FRAME_HISTORY) {
    lamissFrameHistory.shift()?.bitmap.close();
  }
}

// Nearly all pixels very dark: a protected video's black frame (or a real
// black screen, where there is nothing to see anyway).
function isLamissFrameBlack(pixels: Uint8ClampedArray): boolean {
  let bright = 0;
  for (let i = 0; i + 2 < pixels.length; i += 4) {
    if (0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2] > 24) {
      bright += 1;
    }
  }
  return bright <= (pixels.length / 4) * 0.01;
}

// A frame as a JPEG data URL, or null when it is black or can't be read.
async function encodeLamissFrame(bitmap: ImageBitmap): Promise<string | null> {
  try {
    const sample = new OffscreenCanvas(LAMISS_FRAME_SAMPLE_SIZE, LAMISS_FRAME_SAMPLE_SIZE);
    const sampleContext = sample.getContext('2d');
    if (!sampleContext) {
      return null;
    }
    sampleContext.drawImage(bitmap, 0, 0, LAMISS_FRAME_SAMPLE_SIZE, LAMISS_FRAME_SAMPLE_SIZE);
    if (isLamissFrameBlack(sampleContext.getImageData(0, 0, LAMISS_FRAME_SAMPLE_SIZE, LAMISS_FRAME_SAMPLE_SIZE).data)) {
      return null;
    }
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: LAMISS_FRAME_JPEG_QUALITY });
    return await lamissBlobToDataUrl(blob);
  } catch {
    // SecurityError: the frame can't be read (protected content).
    return null;
  }
}

function lamissBlobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// The frames to send with a question: about 2 s earlier, then now; or none
// when the current frame is black or can't be copied.
async function captureLamissFrames(): Promise<string[]> {
  const video = lamissFrameSource();
  if (!video) {
    return [];
  }
  const current = await snapshotLamissFrame(video);
  if (!current) {
    return [];
  }
  try {
    const now = await encodeLamissFrame(current);
    if (!now) {
      return [];
    }
    const target = Date.now() - LAMISS_FRAME_EARLIER_MS;
    const earlier = lamissFrameHistory
      .filter(snapshot => snapshot.at <= Date.now() - LAMISS_FRAME_INTERVAL_MS)
      .sort((a, b) => Math.abs(a.at - target) - Math.abs(b.at - target))[0];
    const before = earlier ? await encodeLamissFrame(earlier.bitmap) : null;
    return before ? [before, now] : [now];
  } finally {
    current.close();
  }
}

// For a question about what the video shows (Lamiss#89): `count` frames over
// spanMs, taken only now that one is due (nothing in the background). None
// when the video is paused, an ad plays, or any frame is black or can't be
// copied (a protected video).
const LAMISS_VISUAL_FRAME_COUNT = 3;
const LAMISS_VISUAL_FRAME_SPAN_MS = 3000;

async function captureLamissFramesOverTime(count = LAMISS_VISUAL_FRAME_COUNT, spanMs = LAMISS_VISUAL_FRAME_SPAN_MS): Promise<string[]> {
  const frames: string[] = [];
  for (let i = 0; i < count; i += 1) {
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, spanMs / (count - 1)));
    }
    const video = lamissFrameSource();
    if (!video || video.paused) {
      return [];
    }
    const bitmap = await snapshotLamissFrame(video);
    if (!bitmap) {
      return [];
    }
    try {
      const frame = await encodeLamissFrame(bitmap);
      if (!frame) {
        return [];
      }
      frames.push(frame);
    } finally {
      bitmap.close();
    }
  }
  return frames;
}

// The chat panel (an extension page framed in this tab, which can't see the
// video) asks for them. Only this extension's own pages may: not another
// extension, not a website.
chrome.runtime.onMessage.addListener((message: { type?: string } | undefined, sender, sendResponse) => {
  const fromOwnPage = sender.id === chrome.runtime.id && typeof sender.url === 'string'
    && sender.url.startsWith(chrome.runtime.getURL(''));
  if (message?.type !== LAMISS_CAPTURE_FRAMES_MESSAGE || !fromOwnPage) {
    return false;
  }
  void captureLamissFrames().then(frames => sendResponse({ frames }), () => sendResponse({ frames: [] }));
  return true;
});
