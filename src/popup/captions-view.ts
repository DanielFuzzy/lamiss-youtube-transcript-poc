// Double Captions (the backend's docs/TDR-0006-Double-Captions.md): on or off
// for this browser profile (lamissCaptionSettings, local). The translation is
// in the user's native language (Profile & Account), which this view names.

const captionsInput = popupElement<HTMLInputElement>('doubleCaptionsInput');
const captionsHint = popupElement<HTMLParagraphElement>('doubleCaptionsHint');

async function loadCaptions(): Promise<void> {
  captionsInput.checked = (await readCaptionSettings()).enabled;
  if (!popupSignedIn()) {
    captionsHint.textContent = lamissT('captions.signIn');
    return;
  }
  captionsHint.textContent = '';
  const preferences = await loadPopupPreferences();
  if (popupCurrentView !== 'captions') {
    return;
  }
  if (!preferences.ok) {
    captionsHint.textContent = describePopupFailure(preferences);
    return;
  }
  const nativeLanguage = preferences.data.nativeLanguage;
  captionsHint.textContent = nativeLanguage
    ? lamissT('captions.translatedInto', { language: lamissLanguageLabel(nativeLanguage) })
    : lamissT('captions.needsNative');
}

captionsInput.addEventListener('change', () => void saveCaptionSettings({ enabled: captionsInput.checked }));

registerPopupView('captions', { enter: () => void loadCaptions() });
