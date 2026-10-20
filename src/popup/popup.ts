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

void refreshPopupAuth().then(() => showPopupView('home'));
