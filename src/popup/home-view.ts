// Home: Start Learning, today's progress when a daily goal is set, the
// category cards, the sign-in card when signed out, and a status line built from real signals: the sign-in, whether the
// backend answers, whether the active tab is a YouTube video, and what the
// in-page Lamiss button on it is doing.

const homeSignInCard = popupElement<HTMLElement>('signInCard');
const homeSignInTitle = popupElement<HTMLParagraphElement>('signInTitle');
const homeSignInDetail = popupElement<HTMLParagraphElement>('signInDetail');
const homeSignInButton = popupElement<HTMLButtonElement>('signInButton');
const homeStartButton = popupElement<HTMLButtonElement>('startButton');
const homeStartLabel = popupElement<HTMLSpanElement>('startLabel');
const homeStartDetail = popupElement<HTMLSpanElement>('startDetail');
const homeStatusDot = popupElement<HTMLSpanElement>('statusDot');
const homeStatusText = popupElement<HTMLSpanElement>('statusText');
const homeProgressParts = {
  container: popupElement<HTMLDivElement>('homeProgress'),
  text: popupElement<HTMLSpanElement>('homeProgressText'),
  fill: popupElement<HTMLSpanElement>('homeProgressFill')
};

type HomeStatusTone = 'ready' | 'attention' | 'error' | 'busy';

let homeSignInBusy = false;
// The YouTube tab Start Learning acts on, once its content script answered.
let homeTabId: number | undefined;
let homePageState: string | undefined;
// Why Start Learning can't run right now, under its label.
let homeStartBlocked: LamissMessageKey = 'home.openVideoFirst';
// Bumped by every status check; an older one stops writing.
let homeStatusGeneration = 0;

function setHomeStatus(tone: HomeStatusTone, text: string): void {
  homeStatusDot.dataset.tone = tone;
  homeStatusText.textContent = text;
}

function renderHomeAccount(detail?: { text: string; error?: boolean }): void {
  const signedIn = popupSignedIn();
  homeSignInCard.hidden = signedIn;
  homeSignInTitle.textContent = lamissT(popupAuthState.status === 'expired' ? 'home.sessionEnded' : 'home.signInTitle');
  homeSignInDetail.textContent = detail?.text ?? lamissT(popupAuthState.status === 'expired'
    ? 'home.signInAgainDetail'
    : 'home.signInDetail');
  homeSignInDetail.classList.toggle('error', detail?.error === true);
  homeSignInButton.disabled = homeSignInBusy;
  homeSignInButton.textContent = lamissT(homeSignInBusy ? 'common.signingIn' : 'privacy.agreeAndSignIn');

  for (const card of document.querySelectorAll<HTMLButtonElement>('.category[data-needs-account]')) {
    card.disabled = !signedIn;
    const detailText = card.querySelector<HTMLElement>('.category-detail');
    if (detailText) {
      const signedInKey = detailText.dataset.signedInKey as LamissMessageKey | undefined;
      detailText.textContent = signedIn ? (signedInKey ? lamissT(signedInKey) : '') : lamissT('home.signInToChange');
    }
  }
}

function renderHomeStart(): void {
  const ready = homePageState === 'ready';
  const loading = homePageState === 'loading';
  homeStartButton.disabled = !popupSignedIn() || homeTabId === undefined || loading;
  homeStartLabel.textContent = lamissT(ready ? 'home.openChat' : loading ? 'home.gettingReady' : 'home.start');
  homeStartDetail.textContent = lamissT(!popupSignedIn()
    ? 'home.signInFirst'
    : ready ? 'home.alreadyHere'
      : homeTabId === undefined ? homeStartBlocked : 'home.willJoin');
}

type HomeActiveVideo = { tabId: number; videoId: string };

// The active tab, if it is a YouTube watch page. The extension can only read
// the address of YouTube tabs, so any other tab has no URL here.
async function readHomeActiveVideo(): Promise<HomeActiveVideo | undefined> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined || !tab.url) {
      return undefined;
    }
    const url = new URL(tab.url);
    const videoId = url.searchParams.get('v');
    if (url.hostname !== 'www.youtube.com' || url.pathname !== '/watch' || !videoId) {
      return undefined;
    }
    return { tabId: tab.id, videoId };
  } catch {
    return undefined;
  }
}

// Rejects when the tab has no Lamiss content script (it was open before the
// extension was installed or reloaded).
function readHomePageStatus(tabId: number): Promise<LamissPageStatus | undefined> {
  return chrome.tabs.sendMessage(tabId, { type: LAMISS_PAGE_STATUS_MESSAGE }) as Promise<LamissPageStatus | undefined>;
}

const HOME_PAGE_STATUS_TEXT: Record<string, { tone: HomeStatusTone; text: LamissMessageKey }> = {
  idle: { tone: 'ready', text: 'home.statusIdle' },
  ready: { tone: 'ready', text: 'home.statusReady' },
  loading: { tone: 'busy', text: 'home.statusLoading' },
  error: { tone: 'error', text: 'home.statusError' },
  // The page hasn't seen the sign-in yet; it catches up by itself.
  'signed-out': { tone: 'ready', text: 'home.statusIdle' },
  'signing-in': { tone: 'busy', text: 'common.signingIn' }
};

async function refreshHomeStatus(): Promise<void> {
  const generation = ++homeStatusGeneration;
  const current = () => generation === homeStatusGeneration;
  homeTabId = undefined;
  homePageState = undefined;
  homeStartBlocked = 'home.checkingTab';
  renderHomeStart();
  const blocked = (tone: HomeStatusTone, text: string, startDetail: LamissMessageKey) => {
    homeStartBlocked = startDetail;
    setHomeStatus(tone, text);
    renderHomeStart();
  };

  if (!popupSignedIn()) {
    renderPracticeProgress(homeProgressParts, undefined);
    setHomeStatus('attention', lamissT(popupAuthState.status === 'expired' ? 'home.statusSessionEnded' : 'home.signInTitle'));
    return;
  }

  setHomeStatus('busy', lamissT('home.checking'));
  const [profile, video] = await Promise.all([loadPopupProfile(), readHomeActiveVideo()]);
  if (!current()) {
    return;
  }
  if (!profile.ok) {
    if (profile.signInRequired) {
      void refreshPopupAuth();
      return;
    }
    blocked('error', profile.status === undefined ? lamissT('home.statusCantReach') : lamissT('home.statusUnavailable', { error: profile.error }), 'home.startUnreachable');
    return;
  }
  // The daily goal line, alongside the tab checks; hidden when there is no goal.
  void loadPopupPractice().then((practice) => {
    if (current()) {
      renderPracticeProgress(homeProgressParts, practice.ok ? practice.data : undefined);
    }
  });
  if (!video) {
    blocked('attention', lamissT('home.statusOpenVideo'), 'home.openVideoFirst');
    return;
  }

  let page: LamissPageStatus | undefined;
  try {
    page = await readHomePageStatus(video.tabId);
  } catch {
    page = undefined;
  }
  if (!current()) {
    return;
  }
  if (!page) {
    blocked('attention', lamissT('home.statusReloadTab'), 'home.startReloadTab');
    return;
  }

  homeTabId = video.tabId;
  homePageState = page.buttonState;
  const status = HOME_PAGE_STATUS_TEXT[page.buttonState] ?? HOME_PAGE_STATUS_TEXT.idle;
  setHomeStatus(status.tone, lamissT(status.text));
  renderHomeStart();
}

homeStartButton.addEventListener('click', async () => {
  if (homeTabId === undefined) {
    return;
  }
  homeStartButton.disabled = true;
  try {
    // The page runs the same flow as its own Lamiss button.
    await chrome.tabs.sendMessage(homeTabId, { type: LAMISS_START_LEARNING_MESSAGE });
    setHomeStatus('busy', lamissT(homePageState === 'ready' ? 'home.statusOpeningChat' : 'home.statusJoining'));
    // The video page shows the progress and the chat from here on.
    window.setTimeout(() => window.close(), 700);
  } catch {
    setHomeStatus('attention', lamissT('home.statusReloadTab'));
    renderHomeStart();
  }
});

homeSignInButton.addEventListener('click', async () => {
  if (homeSignInBusy) {
    return;
  }
  homeSignInBusy = true;
  renderHomeAccount({ text: lamissT('common.continueInGoogle') });
  // The worker runs the sign-in, so it finishes even if this popup closes.
  // The button says "Agree and sign in": clicking it accepts the notice above it.
  const result = await chrome.runtime.sendMessage({ type: LAMISS_SIGN_IN_MESSAGE, acceptPrivacyNotice: true })
    .catch((error: unknown): LamissSignInResult => ({ ok: false, reason: 'failed', error: error instanceof Error ? error.message : String(error) })) as LamissSignInResult | undefined;
  homeSignInBusy = false;
  await refreshPopupAuth();
  if (!result?.ok) {
    renderHomeAccount({ text: result?.error ?? lamissT('common.signInFailed'), error: result?.reason !== 'cancelled' });
  }
});

onPopupAuthChange(() => {
  renderHomeAccount();
  if (popupCurrentView === 'home') {
    void refreshHomeStatus();
  }
});

registerPopupView('home', {
  enter: () => {
    renderHomeAccount();
    void refreshHomeStatus();
  }
});
