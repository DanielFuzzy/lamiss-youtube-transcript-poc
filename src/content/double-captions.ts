// Double Captions on the YouTube player (the backend's docs/TDR-0006-Double-Captions.md,
// Lamiss#79 tasks 2 and 3): the video's own caption line with its translation
// into the user's native language right below it, words that mean the same
// thing in the same color, while a Lamiss session runs on the video and the
// setting is on (lamissCaptionSettings).
//
// The backend lists the chunks around a position (a window of 60 s): source
// words at once, translations as they get stored. This asks for the window
// around the playback position, the next one 30 s (of watching) before the
// current one ends, a new one after a seek, and again every few seconds while
// chunks are still being translated. What is on screen only changes when the
// line or its translation does. Loaded before youtube.js, which starts and
// stops it with the live session.

const LAMISS_CAPTIONS_ID = 'lamiss-double-captions';
// The player's class while Double Captions show, which hides YouTube's own captions.
const LAMISS_CAPTIONS_PLAYER_CLASS = 'lamiss-double-captions-on';
const LAMISS_CAPTION_LOOKAHEAD_MS = 30_000;
// In video time, below the backend's 60 s window: at high speeds a fresh
// window would otherwise already be "about to end".
const LAMISS_CAPTION_MAX_LOOKAHEAD_MS = 45_000;
const LAMISS_CAPTION_POLL_MS = 2500;
const LAMISS_CAPTION_MAX_POLLS = 24;
const LAMISS_CAPTION_RETRY_MS = 15_000;
// A line stays this long after its chunk ends, unless the next one starts.
const LAMISS_CAPTION_HOLD_MS = 800;

type LamissCaptionsState = {
  videoId: string;
  chunks: Map<number, LamissCaptionChunk>;
  sourceLanguage?: string;
  targetLanguage?: string;
  window?: { fromMs: number; toMs: number };
  fetching: boolean;
  pollTimer?: number;
  polls: number;
  // After a failed request, none before this (Date.now()).
  retryAt: number;
  // The backend can't show this video's captions (no native language, the
  // captions already in it, no transcript): stop asking.
  unavailable: boolean;
  // What is on screen: "chunkIndex:status", or '' for nothing.
  rendered: string;
};

// The live session's video, whether or not Double Captions are on.
let lamissCaptionsVideoId: string | undefined;
let lamissCaptions: LamissCaptionsState | null = null;

// The chunk to show at a position: the last one started, until a little after it ends.
function lamissCaptionAt(chunks: LamissCaptionChunk[], positionMs: number): LamissCaptionChunk | undefined {
  let current: LamissCaptionChunk | undefined;
  for (const chunk of chunks) {
    if (chunk.startMs <= positionMs && (!current || chunk.startMs > current.startMs)) {
      current = chunk;
    }
  }
  return current && positionMs < current.endMs + LAMISS_CAPTION_HOLD_MS ? current : undefined;
}

// The color of each source and target word of a READY line (undefined: none):
// the backend's groups, or, for a line it couldn't align, the words written
// the same in both (names, numbers), which are always a match.
function lamissCaptionColors(chunk: LamissCaptionChunk): { source: (number | undefined)[]; target: (number | undefined)[] } {
  const source: (number | undefined)[] = chunk.source.map(() => undefined);
  const target: (number | undefined)[] = chunk.target.map(() => undefined);
  if (chunk.status !== 'READY') {
    return { source, target };
  }
  if (chunk.groups && chunk.groups.length > 0) {
    const position = new Map(chunk.source.map((token, i) => [token.index, i]));
    for (const group of chunk.groups) {
      for (const index of group.sourceIndexes) {
        const i = position.get(index);
        if (i !== undefined) {
          source[i] = group.colorIndex % LAMISS_CAPTION_COLORS;
        }
      }
      for (const i of group.targetIndexes) {
        if (i >= 0 && i < target.length) {
          target[i] = group.colorIndex % LAMISS_CAPTION_COLORS;
        }
      }
    }
    return { source, target };
  }
  const sourceWords = chunk.source.map(token => lamissCaptionWord(token.text));
  const targetWords = chunk.target.map(lamissCaptionWord);
  const once = (words: string[], word: string) => words.indexOf(word) === words.lastIndexOf(word);
  let color = 0;
  sourceWords.forEach((word, i) => {
    const j = targetWords.indexOf(word);
    if ((word.length >= 2 || /\d/.test(word)) && j >= 0 && once(sourceWords, word) && once(targetWords, word)) {
      source[i] = target[j] = color % LAMISS_CAPTION_COLORS;
      color += 1;
    }
  });
  return { source, target };
}

// A word without case, accents or punctuation, to compare across languages.
function lamissCaptionWord(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

// Whether to ask for the window at positionMs: none yet, the position left it
// (a seek), or it ends within the lookahead (counted in watching time, at most
// LAMISS_CAPTION_MAX_LOOKAHEAD_MS of video).
function lamissCaptionsNeedWindow(range: { fromMs: number; toMs: number } | undefined, positionMs: number, playbackRate: number): boolean {
  if (!range || positionMs < range.fromMs || positionMs >= range.toMs) {
    return true;
  }
  const lookaheadMs = Math.min(LAMISS_CAPTION_LOOKAHEAD_MS * Math.max(1, playbackRate || 1), LAMISS_CAPTION_MAX_LOOKAHEAD_MS);
  return range.toMs - positionMs < lookaheadMs;
}

function startLamissCaptions(videoId: string): void {
  lamissCaptionsVideoId = videoId;
  void readCaptionSettings().then(({ enabled }) => {
    if (enabled && lamissCaptionsVideoId === videoId && lamissCaptions?.videoId !== videoId) {
      showLamissCaptions(videoId);
    }
  });
}

function stopLamissCaptions(): void {
  lamissCaptionsVideoId = undefined;
  hideLamissCaptions();
}

function showLamissCaptions(videoId: string): void {
  hideLamissCaptions();
  lamissCaptions = { videoId, chunks: new Map(), fetching: false, polls: 0, retryAt: 0, unavailable: false, rendered: '' };
  updateLamissCaptions();
}

function hideLamissCaptions(): void {
  const overlay = document.getElementById(LAMISS_CAPTIONS_ID);
  if (!lamissCaptions && !overlay) {
    return;
  }
  if (lamissCaptions) {
    window.clearTimeout(lamissCaptions.pollTimer);
  }
  lamissCaptions = null;
  overlay?.remove();
  getLamissPlayer()?.classList.remove(LAMISS_CAPTIONS_PLAYER_CLASS);
}

async function requestLamissCaptions(fromMs: number, poll: boolean): Promise<void> {
  const captions = lamissCaptions;
  if (!captions || captions.fetching) {
    return;
  }
  // A newer window replaces the pending poll; it polls itself if still needed.
  window.clearTimeout(captions.pollTimer);
  captions.polls = poll ? captions.polls + 1 : 0;
  captions.fetching = true;
  let result: LamissCallResult<LamissCaptionWindow> | undefined;
  try {
    result = await chrome.runtime.sendMessage({ type: LAMISS_FETCH_CAPTIONS_MESSAGE, videoId: captions.videoId, fromMs });
  } catch {
    result = undefined;
  }
  if (lamissCaptions !== captions) {
    return;
  }
  captions.fetching = false;
  if (!result?.ok) {
    if (result && (result.status === 404 || result.status === 422 || result.signInRequired)) {
      console.log('Lamiss POC: double captions unavailable for this video, status =', result.status ?? 'signed out');
      captions.unavailable = true;
      renderLamissCaptions(undefined);
      return;
    }
    captions.retryAt = Date.now() + LAMISS_CAPTION_RETRY_MS;
    return;
  }
  const page = result.data;
  for (const chunk of page.chunks) {
    captions.chunks.set(chunk.chunkIndex, chunk);
  }
  captions.sourceLanguage = page.sourceLanguage;
  captions.targetLanguage = page.targetLanguage;
  captions.window = { fromMs: page.fromMs, toMs: page.toMs };
  if (page.chunks.some(chunk => chunk.status === 'PENDING') && captions.polls < LAMISS_CAPTION_MAX_POLLS) {
    captions.pollTimer = window.setTimeout(() => void requestLamissCaptions(page.fromMs, true), LAMISS_CAPTION_POLL_MS);
  }
  // The line on screen may have just been translated.
  captions.rendered = '';
  updateLamissCaptions();
}

function updateLamissCaptions(): void {
  const captions = lamissCaptions;
  if (!captions || captions.unavailable) {
    return;
  }
  const video = getLamissVideo();
  const player = getLamissPlayer();
  // During ads currentTime is the ad's position, not the video's.
  if (!video || !player || player.classList.contains('ad-showing')) {
    renderLamissCaptions(undefined);
    return;
  }
  const positionMs = video.currentTime * 1000;
  if (!captions.fetching && Date.now() >= captions.retryAt && lamissCaptionsNeedWindow(captions.window, positionMs, video.playbackRate)) {
    void requestLamissCaptions(positionMs, false);
  }
  renderLamissCaptions(lamissCaptionAt([...captions.chunks.values()], positionMs));
}

function renderLamissCaptions(chunk: LamissCaptionChunk | undefined): void {
  const captions = lamissCaptions;
  const player = getLamissPlayer();
  if (!captions || !player) {
    return;
  }
  const key = chunk ? `${chunk.chunkIndex}:${chunk.status}` : '';
  let overlay = document.getElementById(LAMISS_CAPTIONS_ID);
  if (captions.rendered === key && overlay?.parentElement === player) {
    return;
  }
  captions.rendered = key;
  if (!overlay || overlay.parentElement !== player) {
    overlay?.remove();
    overlay = createLamissCaptionsOverlay();
    player.append(overlay);
  }
  const [source, target] = overlay.children as unknown as [HTMLParagraphElement, HTMLParagraphElement];
  overlay.hidden = !chunk;
  player.classList.toggle(LAMISS_CAPTIONS_PLAYER_CLASS, Boolean(chunk));
  if (!chunk) {
    return;
  }
  const colors = lamissCaptionColors(chunk);
  fillLamissCaptionLine(source, chunk.source.map(token => token.text), colors.source);
  source.lang = captions.sourceLanguage ?? '';
  target.lang = captions.targetLanguage ?? '';
  target.hidden = chunk.status === 'UNAVAILABLE';
  target.classList.toggle('lamiss-double-captions__target--pending', chunk.status === 'PENDING');
  // Pending: a placeholder, so the line doesn't jump when the translation arrives.
  fillLamissCaptionLine(target, chunk.status === 'READY' ? chunk.target : ['…'], colors.target);
}

// One <span> per word, colored by its group (lamiss-c0 … lamiss-c5).
function fillLamissCaptionLine(line: HTMLElement, words: string[], colors: (number | undefined)[]): void {
  line.replaceChildren(...words.map((word, i) => {
    const span = document.createElement('span');
    span.textContent = i < words.length - 1 ? `${word} ` : word;
    if (colors[i] !== undefined) {
      span.className = `lamiss-c${colors[i]}`;
    }
    return span;
  }));
}

function createLamissCaptionsOverlay(): HTMLDivElement {
  const overlay = document.createElement('div');
  overlay.id = LAMISS_CAPTIONS_ID;
  overlay.className = 'lamiss-double-captions';
  const source = document.createElement('p');
  source.className = 'lamiss-double-captions__source';
  const target = document.createElement('p');
  target.className = 'lamiss-double-captions__target';
  overlay.append(source, target);
  return overlay;
}

// Media events don't bubble; listening in the capture phase on the document
// survives YouTube swapping the <video> element.
for (const type of ['timeupdate', 'seeking', 'seeked', 'ratechange']) {
  document.addEventListener(type, (event) => {
    if (lamissCaptions && event.target === getLamissVideo()) {
      updateLamissCaptions();
    }
  }, true);
}

// Turned on or off in the popup: follows at once on the session's video.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(LAMISS_CAPTION_SETTINGS_KEY in changes)) {
    return;
  }
  const enabled = (changes[LAMISS_CAPTION_SETTINGS_KEY].newValue as Partial<LamissCaptionSettings> | undefined)?.enabled === true;
  if (!enabled) {
    hideLamissCaptions();
  } else if (lamissCaptionsVideoId && !lamissCaptions) {
    showLamissCaptions(lamissCaptionsVideoId);
  }
});
