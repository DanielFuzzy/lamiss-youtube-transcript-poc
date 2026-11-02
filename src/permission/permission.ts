// Chrome can't show the microphone prompt from an extension popup, so the
// popup opens this tab instead. Permission is granted per extension origin,
// so once it's allowed here the popup can record too.
const micStatus = document.getElementById('micStatus') as HTMLParagraphElement | null;
const grantMicButton = document.getElementById('grantMic') as HTMLButtonElement | null;

function setMicStatus(message: LamissMessageKey, state: 'granted' | 'denied' | 'pending'): void {
  if (micStatus) {
    // Set by status from now on, not by the page's static text.
    delete micStatus.dataset.i18n;
    micStatus.dataset.message = message;
    micStatus.textContent = lamissT(message);
    micStatus.className = state;
  }
}

async function requestMicrophoneAccess(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(track => track.stop());
    setMicStatus('permission.granted', 'granted');
    if (grantMicButton) {
      grantMicButton.hidden = true;
    }
  } catch (error) {
    console.error('Lamiss POC: microphone permission error:', error);
    setMicStatus('permission.denied', 'denied');
  }
}

grantMicButton?.addEventListener('click', () => {
  void requestMicrophoneAccess();
});

// The page's text in the app language, the status line included.
function renderPermissionText(): void {
  applyLamissTranslations();
  if (micStatus?.dataset.message) {
    micStatus.textContent = lamissT(micStatus.dataset.message as LamissMessageKey);
  }
}

onAppLanguageChange(renderPermissionText);
void loadAppLanguage().then(renderPermissionText);
void requestMicrophoneAccess();
