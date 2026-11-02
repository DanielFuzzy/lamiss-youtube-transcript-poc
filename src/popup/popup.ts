// The toolbar popup: a home view and one view per settings category
// (TDR-0002). Each view lives in its own script (home-view.ts, audio-view.ts,
// tutor-view.ts, profile-view.ts) on top of popup-shared.ts; this one, loaded
// last, wires the navigation and shows the home view.

for (const card of document.querySelectorAll<HTMLButtonElement>('[data-open]')) {
  card.addEventListener('click', () => {
    const view = card.dataset.open as PopupViewName;
    if (POPUP_ACCOUNT_VIEWS.has(view) && !popupSignedIn()) {
      return;
    }
    showPopupView(view);
  });
}

for (const back of document.querySelectorAll<HTMLButtonElement>('[data-back]')) {
  back.addEventListener('click', () => showPopupView('home'));
}

document.addEventListener('keydown', (event) => {
  // Escape goes back first; on the home view Chrome closes the popup.
  if (event.key === 'Escape' && popupCurrentView !== 'home') {
    event.preventDefault();
    showPopupView('home');
  }
});

chrome.runtime.onMessage.addListener((message: { type?: string } | undefined, sender) => {
  if (message?.type === LAMISS_AUTH_CHANGED_MESSAGE && sender.id === chrome.runtime.id) {
    void refreshPopupAuth();
  }
  return false;
});

// --- App language (TDR-0003) ------------------------------------------------------

const popupLanguagePicker = popupElement<HTMLDivElement>('appLanguagePicker');

function createAppLanguagePicker(): void {
  popupLanguagePicker.replaceChildren(...LAMISS_APP_LANGUAGES.map((language) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.lang = language.code;
    button.dataset.language = language.code;
    button.textContent = language.code.toUpperCase();
    button.title = language.nativeName;
    button.setAttribute('aria-label', language.nativeName);
    button.addEventListener('click', () => {
      if (language.code !== lamissAppLanguage) {
        void saveAppLanguage(language.code);
      }
    });
    return button;
  }));
  renderAppLanguagePicker();
}

function renderAppLanguagePicker(): void {
  for (const button of popupLanguagePicker.querySelectorAll<HTMLButtonElement>('button[data-language]')) {
    button.setAttribute('aria-pressed', String(button.dataset.language === lamissAppLanguage));
  }
}

// The static text changes at once; the view on screen renders again from
// what it already loaded.
onAppLanguageChange(() => {
  applyLamissTranslations();
  renderAppLanguagePicker();
  popupViewHooks[popupCurrentView]?.enter?.();
});

void (async () => {
  try {
    await loadAppLanguage();
    applyLamissTranslations();
    createAppLanguagePicker();
  } finally {
    document.documentElement.removeAttribute('data-lamiss-i18n');
  }
  await refreshPopupAuth();
  showPopupView('home');
})();
