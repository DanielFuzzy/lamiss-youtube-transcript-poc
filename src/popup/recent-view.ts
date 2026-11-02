// Recent videos (TDR-0004): the videos the user studied, most recent first,
// from GET /api/me/recent-videos. Each shows where playback stopped and, apart
// from it, how many of Lamiss's questions were answered; Resume opens the
// video at that position in a new tab.

const recentLoading = popupElement<HTMLDivElement>('recentLoading');
const recentError = popupElement<HTMLDivElement>('recentError');
const recentErrorText = popupElement<HTMLParagraphElement>('recentErrorText');
const recentRetryButton = popupElement<HTMLButtonElement>('recentRetryButton');
const recentEmpty = popupElement<HTMLParagraphElement>('recentEmpty');
const recentList = popupElement<HTMLUListElement>('recentList');
const recentMessage = popupElement<HTMLParagraphElement>('recentMessage');

const RECENT_PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z" class="filled" /></svg>';
const RECENT_ANSWERED_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" /><path d="m8.5 12 2.5 2.5 4.5-5" /></svg>';
const RECENT_PLACEHOLDER_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m10 9 5 3-5 3Z" /></svg>';

// The videos last shown, to render them again in another app language.
let recentVideos: LamissRecentVideo[] | undefined;
// Bumped by every load; an older answer is dropped.
let recentGeneration = 0;

function recentTitle(video: LamissRecentVideo): string {
  return video.title?.trim() || lamissT('recent.untitled');
}

function recentQuestionsText(answered: number): string {
  if (answered <= 0) {
    return lamissT('recent.noQuestions');
  }
  return answered === 1 ? lamissT('recent.oneQuestion') : lamissT('recent.questions', { count: answered });
}

function recentThumbnail(video: LamissRecentVideo): HTMLElement {
  const frame = document.createElement('span');
  frame.className = 'recent-thumb';
  const placeholder = () => {
    // Static markup with no user data.
    frame.innerHTML = RECENT_PLACEHOLDER_ICON;
    frame.dataset.placeholder = 'true';
  };
  // Only YouTube's own thumbnail host: the URL comes from the backend.
  if (video.thumbnailUrl?.startsWith('https://i.ytimg.com/')) {
    const image = document.createElement('img');
    image.src = video.thumbnailUrl;
    image.alt = '';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', placeholder);
    frame.append(image);
  } else {
    placeholder();
  }
  return frame;
}

// Where the video stopped: a thin bar and "Stopped at 3:05 of 10:12".
function recentPlayback(video: LamissRecentVideo): HTMLElement {
  const playback = document.createElement('div');
  playback.className = 'recent-playback';
  const text = document.createElement('span');
  const positionMs = video.playback?.lastPositionMs;
  if (positionMs === undefined) {
    text.textContent = lamissT('recent.notPlayed');
    playback.dataset.empty = 'true';
    playback.append(text);
    return playback;
  }
  const position = formatLamissDuration(positionMs / 1000);
  const duration = video.durationSeconds ?? 0;
  text.textContent = duration > 0
    ? lamissT('recent.stoppedAt', { position, duration: formatLamissDuration(duration) })
    : lamissT('recent.stoppedAtNoDuration', { position });
  if (duration > 0) {
    const bar = document.createElement('span');
    bar.className = 'recent-bar';
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', `${lamissT('recent.playback')}: ${text.textContent}`);
    const fill = document.createElement('span');
    fill.className = 'recent-bar-fill';
    fill.style.width = `${Math.min(100, Math.round((positionMs / (duration * 1000)) * 100))}%`;
    bar.append(fill);
    playback.append(bar);
  }
  playback.append(text);
  return playback;
}

function recentItem(video: LamissRecentVideo): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'recent-item';
  item.dataset.videoId = String(video.videoId);

  const text = document.createElement('div');
  text.className = 'recent-text';
  const title = document.createElement('p');
  title.className = 'recent-title';
  title.textContent = recentTitle(video);
  title.title = recentTitle(video);
  const when = document.createElement('p');
  when.className = 'recent-when';
  when.textContent = formatLamissRelativeTime(video.lastStudiedAt);

  const footer = document.createElement('div');
  footer.className = 'recent-footer';
  // The learning progress, kept apart from the playback position.
  const progress = document.createElement('span');
  progress.className = 'recent-progress';
  progress.dataset.answered = String(video.learningProgress.questionsAnswered);
  const progressText = document.createElement('span');
  progressText.textContent = recentQuestionsText(video.learningProgress.questionsAnswered);
  // Static markup with no user data.
  progress.innerHTML = RECENT_ANSWERED_ICON;
  progress.append(progressText);
  footer.append(progress);

  const url = lamissResumeUrl(video);
  if (url) {
    const resume = document.createElement('button');
    resume.type = 'button';
    resume.className = 'btn btn-primary btn-small recent-resume';
    const positionMs = video.playback?.lastPositionMs ?? 0;
    const label = document.createElement('span');
    label.textContent = lamissT(positionMs >= 1000 ? 'recent.resume' : 'recent.watch');
    resume.innerHTML = RECENT_PLAY_ICON;
    resume.append(label);
    resume.setAttribute('aria-label', positionMs >= 1000
      ? lamissT('recent.resumeLabel', { title: recentTitle(video), position: formatLamissDuration(positionMs / 1000) })
      : lamissT('recent.watchLabel', { title: recentTitle(video) }));
    resume.addEventListener('click', () => void openRecentVideo(url));
    footer.append(resume);
  }

  text.append(title, when, recentPlayback(video), footer);
  item.append(recentThumbnail(video), text);
  return item;
}

// A new tab, so the tab the user is on (and its player) is left alone.
async function openRecentVideo(url: string): Promise<void> {
  try {
    await chrome.tabs.create({ url });
    window.close();
  } catch (error) {
    console.error('Lamiss POC: could not open the video:', error);
    recentMessage.textContent = lamissT('recent.cantOpen');
  }
}

function renderRecentVideos(videos: LamissRecentVideo[]): void {
  recentEmpty.hidden = videos.length > 0;
  recentList.hidden = videos.length === 0;
  recentList.replaceChildren(...videos.map(recentItem));
}

async function loadRecentVideos(): Promise<void> {
  const generation = ++recentGeneration;
  recentLoading.hidden = false;
  recentError.hidden = true;
  recentEmpty.hidden = true;
  recentList.hidden = true;
  recentMessage.textContent = '';
  const result = await fetchRecentVideos();
  if (generation !== recentGeneration || popupCurrentView !== 'recent') {
    return;
  }
  recentLoading.hidden = true;
  if (!result.ok) {
    recentVideos = undefined;
    recentErrorText.textContent = describePopupFailure(result);
    recentError.hidden = false;
    return;
  }
  recentVideos = result.data.videos ?? [];
  renderRecentVideos(recentVideos);
}

recentRetryButton.addEventListener('click', () => void loadRecentVideos());

registerPopupView('recent', {
  enter: () => {
    // Another app language: the same list, rendered again without a new request.
    if (recentVideos && !recentList.hidden) {
      renderRecentVideos(recentVideos);
      return;
    }
    void loadRecentVideos();
  },
  leave: () => {
    recentGeneration += 1;
    recentVideos = undefined;
  }
});
