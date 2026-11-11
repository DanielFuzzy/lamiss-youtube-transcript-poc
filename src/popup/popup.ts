// The toolbar popup: a home view and one view per settings category
// (TDR-0002). Each view lives in its own script (home-view.ts, captions-view.ts, audio-view.ts,
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

// A small flag for each choice, drawn here (emoji flags don't render on
// Windows). A flag stands for the language: the United Kingdom for English
// and Portugal for Portuguese. Static markup with no user data.
const POPUP_LANGUAGE_FLAGS: Record<LamissAppLanguage, string> = {
  en: '<svg viewBox="0 0 60 30" preserveAspectRatio="xMidYMid slice"><clipPath id="flagUkCross"><path d="M30 15h30v15zv15H0zH0V0zV0h30z"/></clipPath>'
    + '<path d="M0 0v30h60V0z" fill="#012169"/><path d="M0 0l60 30m0-30L0 30" stroke="#fff" stroke-width="6"/>'
    + '<path d="M0 0l60 30m0-30L0 30" clip-path="url(#flagUkCross)" stroke="#c8102e" stroke-width="4"/>'
    + '<path d="M30 0v30M0 15h60" stroke="#fff" stroke-width="10"/><path d="M30 0v30M0 15h60" stroke="#c8102e" stroke-width="6"/></svg>',
  es: '<svg viewBox="0 0 3 2"><path d="M0 0h3v2H0z" fill="#aa151b"/><path d="M0 .5h3v1H0z" fill="#f1bf00"/></svg>',
  fr: '<svg viewBox="0 0 3 2"><path d="M0 0h1v2H0z" fill="#002654"/><path d="M1 0h1v2H1z" fill="#fff"/><path d="M2 0h1v2H2z" fill="#ce1126"/></svg>',
  de: '<svg viewBox="0 0 3 2"><path d="M0 0h3v.67H0z" fill="#000"/><path d="M0 .67h3v.66H0z" fill="#dd0000"/><path d="M0 1.33h3V2H0z" fill="#ffce00"/></svg>',
  pt: '<svg viewBox="0 0 3 2"><path d="M0 0h1.2v2H0z" fill="#046a38"/><path d="M1.2 0H3v2H1.2z" fill="#da291c"/>'
    + '<circle cx="1.2" cy="1" r=".4" fill="#ffe900"/><circle cx="1.2" cy="1" r=".24" fill="#da291c"/><circle cx="1.2" cy="1" r=".16" fill="#fff"/></svg>'
};

function createAppLanguagePicker(): void {
  popupLanguagePicker.replaceChildren(...LAMISS_APP_LANGUAGES.map((language) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.lang = language.code;
    button.dataset.language = language.code;
    button.innerHTML = POPUP_LANGUAGE_FLAGS[language.code];
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
