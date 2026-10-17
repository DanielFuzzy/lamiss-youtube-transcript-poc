const MAX_QUESTION_DURATION_MS = 60_000;
const MIN_QUESTION_DURATION_MS = 500;

const loadTranscriptButton = document.getElementById('loadTranscript') as HTMLButtonElement | null;
const statusBox = document.getElementById('status') as HTMLDivElement | null;
const askButton = document.getElementById('askButton') as HTMLButtonElement | null;
const askHint = document.getElementById('askHint') as HTMLParagraphElement | null;
const answerBox = document.getElementById('answer') as HTMLDivElement | null;
const answerText = document.getElementById('answerText') as HTMLParagraphElement | null;
const answerMeta = document.getElementById('answerMeta') as HTMLSpanElement | null;
const accountName = document.getElementById('accountName') as HTMLParagraphElement | null;
const accountDetail = document.getElementById('accountDetail') as HTMLParagraphElement | null;
const signInButton = document.getElementById('signInButton') as HTMLButtonElement | null;
const signOutButton = document.getElementById('signOutButton') as HTMLButtonElement | null;

// ---------------------------------------------------------------------------
// Account: who is signed in. Loading transcripts and asking need a sign-in.
// ---------------------------------------------------------------------------

let popupAuthState: LamissAuthState = { status: 'signedOut' };
let popupAuthBusy = false;

function popupSignedIn(): boolean {
  return popupAuthState.status === 'signedIn';
}

function renderAccount(detail?: { text: string; error?: boolean }): void {
  const state = popupAuthState;
  if (accountName) {
    accountName.textContent = state.status === 'signedIn'
      ? state.user.username || state.user.email
      : state.status === 'expired' ? 'Your session ended' : 'You are not signed in';
  }
  if (accountDetail) {
    accountDetail.textContent = detail?.text
      ?? (state.status === 'signedIn' ? state.user.email : state.status === 'expired' ? LAMISS_SIGN_IN_AGAIN_MESSAGE : LAMISS_SIGN_IN_REQUIRED_MESSAGE);
    accountDetail.classList.toggle('error', detail?.error === true);
  }
  if (signInButton) {
    signInButton.hidden = state.status === 'signedIn';
    signInButton.disabled = popupAuthBusy;
    signInButton.textContent = popupAuthBusy ? 'Signing in…' : 'Sign in with Google';
  }
  if (signOutButton) {
    signOutButton.hidden = state.status !== 'signedIn';
    signOutButton.disabled = popupAuthBusy;
  }
  if (loadTranscriptButton) {
    loadTranscriptButton.disabled = !popupSignedIn();
  }
  if (askState === 'idle') {
    setAskState('idle', popupSignedIn() ? 'Tap the mic and ask about this moment' : 'Sign in to ask Lamiss');
  }
}

async function refreshAccount(detail?: { text: string; error?: boolean }): Promise<void> {
  popupAuthState = await readAuthState();
  renderAccount(detail);
}

signInButton?.addEventListener('click', async () => {
  if (popupAuthBusy) {
    return;
  }
  popupAuthBusy = true;
  renderAccount({ text: 'Continue in the Google window' });
  // The worker runs the sign-in, so it finishes even if this popup closes.
  const result = await chrome.runtime.sendMessage({ type: LAMISS_SIGN_IN_MESSAGE })
    .catch((error: unknown): LamissSignInResult => ({ ok: false, reason: 'failed', error: error instanceof Error ? error.message : String(error) })) as LamissSignInResult | undefined;
  popupAuthBusy = false;
  if (!result?.ok) {
    await refreshAccount({ text: result?.error ?? 'Sign-in failed. Please try again.', error: result?.reason !== 'cancelled' });
    return;
  }
  await refreshAccount();
});

signOutButton?.addEventListener('click', async () => {
  if (popupAuthBusy) {
    return;
  }
  popupAuthBusy = true;
  renderAccount({ text: 'Signing out…' });
  await chrome.runtime.sendMessage({ type: LAMISS_SIGN_OUT_MESSAGE }).catch(() => undefined);
  popupAuthBusy = false;
  await refreshAccount();
});

chrome.runtime.onMessage.addListener((message: { type?: string } | undefined, sender) => {
  if (message?.type === LAMISS_AUTH_CHANGED_MESSAGE && sender.id === chrome.runtime.id) {
    void refreshAccount();
  }
  return false;
});

function setStatus(message: string): void {
  if (statusBox) {
    statusBox.textContent = message;
  }
}

// The background worker owns the ingest call so the popup and the in-page
// Lamiss button send transcripts the same way.
function sendTranscriptToBackend(payload: TranscriptIngestPayload): Promise<TranscriptIngestOutcome> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'INGEST_TRANSCRIPT', payload }, (response?: TranscriptIngestOutcome) => {
      if (chrome.runtime.lastError || !response) {
        resolve({ ok: false, error: chrome.runtime.lastError?.message ?? 'No response from the extension' });
        return;
      }
      resolve(response);
    });
  });
}

loadTranscriptButton?.addEventListener('click', async () => {
  if (!popupSignedIn()) {
    setStatus(`Status: ${LAMISS_SIGN_IN_REQUIRED_MESSAGE}`);
    return;
  }
  setStatus('Status: Loading...');

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];

    if (!activeTab?.id) {
      setStatus('Status: No active tab');
      return;
    }

    // The extension can only read the address of YouTube tabs.
    if (!activeTab.url) {
      setStatus('Status: Active tab is not a YouTube watch page');
      return;
    }

    const parsedActiveTabUrl = new URL(activeTab.url);
    if (parsedActiveTabUrl.hostname !== 'www.youtube.com' && parsedActiveTabUrl.hostname !== 'youtube.com') {
      setStatus('Status: Active tab is not a YouTube watch page');
      return;
    }

    if (parsedActiveTabUrl.pathname !== '/watch') {
      setStatus('Status: Active tab is not a YouTube watch page');
      return;
    }

    if (!parsedActiveTabUrl.searchParams.get('v')) {
      setStatus('Status: Active tab is not a YouTube watch page');
      return;
    }

    chrome.tabs.sendMessage(
      activeTab.id,
      {
        type: 'LOAD_TRANSCRIPT',
        tabId: activeTab.id
      },
      async (response) => {
        if (chrome.runtime.lastError) {
          setStatus('Status: Content script unavailable');
          console.error('Content script error:', chrome.runtime.lastError.message);
          return;
        }

        if (!response?.success) {
          setStatus(`Status: ${response?.error ?? 'Transcript failed'}`);
          return;
        }

        const loadedNote = `Video ${response.videoId ?? 'unknown'} loaded in ${response.language ?? 'unknown'}`;

        setStatus(`Status: ${loadedNote} — sending to Lamiss...`);

        const uploadResult = await sendTranscriptToBackend({
          videoExternalId: response.videoId,
          videoPlatform: 'YOUTUBE',
          videoTitle: response.videoTitle,
          videoDurationSeconds: response.videoDurationSeconds,
          language: response.language,
          translated: response.translated,
          rawCaptionResponse: response.rawCaptionResponse
        });

        if (!uploadResult.ok) {
          console.error('Lamiss backend upload failed:', uploadResult.error ?? uploadResult.status);
          setStatus(`Status: ${loadedNote} — ${uploadResult.signInRequired ? uploadResult.error ?? LAMISS_SIGN_IN_REQUIRED_MESSAGE : 'upload failed'}`);
          if (uploadResult.signInRequired) {
            void refreshAccount();
          }
          return;
        }

        setStatus(`Status: ${loadedNote} — sent to Lamiss`);
      }
    );
  } catch (error) {
    console.error('Popup error:', error);
    setStatus('Status: Failed to load transcript');
  }
});

// ---------------------------------------------------------------------------
// Ask Lamiss: record a spoken question and send it to the user-asks endpoint.
// ---------------------------------------------------------------------------

type AskState = 'idle' | 'recording' | 'sending';

let askState: AskState = 'idle';
let mediaRecorder: MediaRecorder | null = null;
let recordedChunks: Blob[] = [];
let recordingStartedAt = 0;
let recordingTimer: number | undefined;
let recordingAutoStop: number | undefined;
let questionVideoPositionMs = 0;
let questionVideoId = '';

function setAskState(state: AskState, hint: string): void {
  askState = state;
  if (askButton) {
    askButton.dataset.state = state;
    askButton.disabled = state === 'sending' || (state === 'idle' && !popupSignedIn());
    askButton.setAttribute('aria-label', state === 'recording' ? 'Stop recording and send question' : 'Start recording your question');
  }
  if (askHint) {
    askHint.textContent = hint;
  }
}

function showAnswer(text: string, meta: string, isError = false): void {
  if (!answerBox || !answerText || !answerMeta) {
    return;
  }
  answerBox.hidden = false;
  answerBox.classList.toggle('error', isError);
  answerText.textContent = text;
  answerMeta.textContent = meta;
}

// The question is asked about the video in the active tab: its learning
// session, and its playback position when recording started.
async function readActiveVideo(): Promise<{ tabId: number; videoId: string } | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    return null;
  }
  const url = new URL(tab.url);
  const videoId = url.searchParams.get('v');
  if ((url.hostname !== 'www.youtube.com' && url.hostname !== 'youtube.com') || url.pathname !== '/watch' || !videoId) {
    return null;
  }
  return { tabId: tab.id, videoId };
}

function clearRecordingTimers(): void {
  window.clearInterval(recordingTimer);
  window.clearTimeout(recordingAutoStop);
  recordingTimer = undefined;
  recordingAutoStop = undefined;
}

async function startRecording(): Promise<void> {
  const activeVideo = await readActiveVideo();
  if (!activeVideo) {
    setAskState('idle', 'Open a YouTube video to ask about it');
    return;
  }

  setAskState('sending', 'Opening microphone…');

  let stream: MediaStream | null;
  try {
    stream = await openMicrophone();
  } catch (error) {
    console.error('Lamiss POC: microphone error:', error);
    setAskState('idle', 'Could not open the microphone');
    return;
  }

  if (!stream) {
    setAskState('idle', 'Allow microphone access in the new tab, then try again');
    return;
  }

  questionVideoId = activeVideo.videoId;
  questionVideoPositionMs = await readVideoPositionMs(activeVideo.tabId);

  const mimeType = pickRecordingMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  recordedChunks = [];

  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  });

  recorder.addEventListener('stop', () => {
    stream?.getTracks().forEach(track => track.stop());
    const durationMs = Date.now() - recordingStartedAt;
    const containerType = (recorder.mimeType || 'audio/webm').split(';')[0];
    const audio = new Blob(recordedChunks, { type: containerType });

    if (durationMs < MIN_QUESTION_DURATION_MS || audio.size === 0) {
      setAskState('idle', 'That was too short — tap and ask again');
      return;
    }

    void sendQuestion(audio, questionVideoId, questionVideoPositionMs);
  });

  mediaRecorder = recorder;
  recordingStartedAt = Date.now();
  recorder.start();

  setAskState('recording', 'Listening… 0:00 — tap to send');
  recordingTimer = window.setInterval(() => {
    setAskState('recording', `Listening… ${formatVideoPosition(Date.now() - recordingStartedAt)} — tap to send`);
  }, 250);
  recordingAutoStop = window.setTimeout(stopRecording, MAX_QUESTION_DURATION_MS);
}

function stopRecording(): void {
  clearRecordingTimers();
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    setAskState('sending', 'Sending your question…');
    mediaRecorder.stop();
  }
  mediaRecorder = null;
}

async function sendQuestion(audio: Blob, videoId: string, videoPositionMs: number): Promise<void> {
  setAskState('sending', 'Lamiss is thinking…');
  const meta = `Asked at ${formatVideoPosition(videoPositionMs)}`;

  console.log('Lamiss POC: user-ask audio type =', audio.type, 'size =', audio.size, 'videoPositionMs =', videoPositionMs);

  const session = await startLearningSession(videoId);
  if (!session.ok) {
    showAnswer(session.status === 404 ? 'Click "Start using Lamiss" on the video first.' : session.error, meta, true);
    if (session.signInRequired) {
      void refreshAccount();
    }
    setAskState('idle', 'Tap the mic to try again');
    return;
  }

  const result = await askLamiss({
    interactionId: crypto.randomUUID(),
    learningSessionId: session.data.learningSessionId,
    videoPositionMs,
    audio
  });

  if (!result.ok) {
    showAnswer(`Lamiss couldn't answer: ${result.error}`, meta, true);
    if (result.signInRequired) {
      void refreshAccount();
    }
    setAskState('idle', 'Tap the mic to try again');
    return;
  }

  const askedMeta = result.data.question ? `${meta} · "${result.data.question}"` : meta;
  showAnswer(result.data.answer?.trim() || 'Lamiss returned an empty answer.', askedMeta);
  setAskState('idle', 'Tap the mic to ask another question');
}

askButton?.addEventListener('click', () => {
  if (askState === 'idle' && !popupSignedIn()) {
    setAskState('idle', 'Sign in to ask Lamiss');
  } else if (askState === 'idle') {
    void startRecording();
  } else if (askState === 'recording') {
    stopRecording();
  }
});

void refreshAccount();
