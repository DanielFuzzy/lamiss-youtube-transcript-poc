// What the popup's views share: the sign-in state, switching views, and the
// user's preferences and profile, loaded once per popup and saved in order.
// Loaded after shared/lamiss-auth.js and before the view scripts (popup.html).

type PopupViewName = 'home' | 'captions' | 'audio' | 'tutor' | 'profile';

type PopupViewHooks = {
  // Called every time the view is shown: it reloads what it shows.
  enter?: () => void;
  // Called when the user leaves it: stop microphones and sounds.
  leave?: () => void;
};

const popupViewHooks: Partial<Record<PopupViewName, PopupViewHooks>> = {};
let popupCurrentView: PopupViewName = 'home';

function popupElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Lamiss popup: missing #${id}`);
  }
  return element as T;
}

function registerPopupView(name: PopupViewName, hooks: PopupViewHooks): void {
  popupViewHooks[name] = hooks;
}

function showPopupView(name: PopupViewName): void {
  if (name !== popupCurrentView) {
    popupViewHooks[popupCurrentView]?.leave?.();
  }
  popupCurrentView = name;
  for (const view of document.querySelectorAll<HTMLElement>('.view')) {
    view.hidden = view.dataset.view !== name;
  }
  popupViewHooks[name]?.enter?.();
  const target = document.querySelector<HTMLElement>(`.view[data-view="${name}"] [data-back]`);
  target?.focus({ preventScroll: true });
}

// The views that need the Lamiss account.
const POPUP_ACCOUNT_VIEWS: ReadonlySet<PopupViewName> = new Set(['tutor', 'profile']);

// --- Sign-in ------------------------------------------------------------------

let popupAuthState: LamissAuthState = { status: 'signedOut' };
const popupAuthListeners: Array<() => void> = [];

function popupSignedIn(): boolean {
  return popupAuthState.status === 'signedIn';
}

function onPopupAuthChange(listener: () => void): void {
  popupAuthListeners.push(listener);
}

async function refreshPopupAuth(): Promise<void> {
  const before = popupAuthState.status === 'signedIn' ? popupAuthState.user.id : undefined;
  popupAuthState = await readAuthState();
  const after = popupAuthState.status === 'signedIn' ? popupAuthState.user.id : undefined;
  if (before !== after) {
    // Another user's (or nobody's) settings.
    popupPreferences = undefined;
    popupProfile = undefined;
  }
  if (!popupSignedIn() && POPUP_ACCOUNT_VIEWS.has(popupCurrentView)) {
    showPopupView('home');
  }
  popupAuthListeners.forEach(listener => listener());
}

// --- Backend results ------------------------------------------------------------

const POPUP_UNREACHABLE_TEXT = 'Lamiss can\'t be reached right now. Check your connection and try again.';

// What to tell the user about a failed call. A 401 already ended the stored
// session (callLamiss); the popup then shows its sign-in again.
function describePopupFailure(result: { ok: false; status?: number; error: string; signInRequired?: boolean }): string {
  if (result.signInRequired) {
    void refreshPopupAuth();
    return result.error;
  }
  if (result.status === undefined) {
    return POPUP_UNREACHABLE_TEXT;
  }
  return result.error;
}

type PopupSaveTone = 'saving' | 'saved' | 'error' | 'idle';

const popupSavedTimers = new WeakMap<HTMLElement, number>();

// The "Saving… / Saved / Not saved" note in a view's header; why a save
// failed shows in a line under the header.
function setPopupSaveState(element: HTMLElement, tone: PopupSaveTone, text?: string): void {
  window.clearTimeout(popupSavedTimers.get(element));
  element.dataset.tone = tone;
  element.title = '';
  const errorLine = element.closest('.view')?.querySelector<HTMLElement>('[data-save-error]');
  if (errorLine) {
    errorLine.hidden = tone !== 'error';
    errorLine.textContent = tone === 'error' ? `Not saved: ${text ?? 'please try again.'}` : '';
  }
  if (tone === 'saving') {
    element.textContent = 'Saving…';
  } else if (tone === 'saved') {
    element.textContent = 'Saved';
    popupSavedTimers.set(element, window.setTimeout(() => setPopupSaveState(element, 'idle'), 2000));
  } else if (tone === 'error') {
    element.textContent = 'Not saved';
    element.title = text ?? '';
  } else {
    element.textContent = '';
  }
}

// --- Preferences and profile -------------------------------------------------------

let popupPreferences: LamissPreferences | undefined;
let popupPreferencesLoading: Promise<LamissCallResult<LamissPreferences>> | undefined;
let popupProfile: LamissProfile | undefined;
let popupProfileLoading: Promise<LamissCallResult<LamissProfile>> | undefined;
// Saves run one after another, each on top of the last saved object, so two
// quick changes in different views never undo each other.
let popupSaveQueue: Promise<unknown> = Promise.resolve();

function loadPopupPreferences(): Promise<LamissCallResult<LamissPreferences>> {
  if (popupPreferences) {
    return Promise.resolve({ ok: true, data: popupPreferences });
  }
  popupPreferencesLoading ??= fetchPreferences().then((result) => {
    popupPreferencesLoading = undefined;
    if (result.ok) {
      popupPreferences = result.data;
    }
    return result;
  });
  return popupPreferencesLoading;
}

function loadPopupProfile(): Promise<LamissCallResult<LamissProfile>> {
  if (popupProfile) {
    return Promise.resolve({ ok: true, data: popupProfile });
  }
  popupProfileLoading ??= fetchProfile().then((result) => {
    popupProfileLoading = undefined;
    if (result.ok) {
      popupProfile = result.data;
    }
    return result;
  });
  return popupProfileLoading;
}

// Applies change to the latest saved preferences and saves the whole object.
function queuePreferencesSave(change: (current: LamissPreferences) => LamissPreferences): Promise<LamissCallResult<LamissPreferences>> {
  const run = async (): Promise<LamissCallResult<LamissPreferences>> => {
    const loaded = await loadPopupPreferences();
    if (!loaded.ok) {
      return loaded;
    }
    const result = await savePreferences(change(structuredClone(loaded.data)));
    if (result.ok) {
      popupPreferences = result.data;
    }
    return result;
  };
  const next = popupSaveQueue.then(run, run);
  popupSaveQueue = next.catch(() => undefined);
  return next;
}

// Saves one change with the view's header note, and reports what was saved
// (undefined when it failed: the message is in the note's tooltip and returned).
async function savePopupPreferences(
  saveState: HTMLElement,
  change: (current: LamissPreferences) => LamissPreferences
): Promise<{ saved?: LamissPreferences; error?: string }> {
  setPopupSaveState(saveState, 'saving');
  const result = await queuePreferencesSave(change);
  if (result.ok) {
    setPopupSaveState(saveState, 'saved');
    return { saved: result.data };
  }
  const error = describePopupFailure(result);
  setPopupSaveState(saveState, 'error', error);
  return { error };
}

// --- Form helpers -------------------------------------------------------------------

function fillLanguageSelect(select: HTMLSelectElement, emptyLabel: string, value: string | null): void {
  select.replaceChildren(new Option(emptyLabel, ''), ...LAMISS_LANGUAGES.map(language => new Option(language.name, language.code)));
  select.value = value ?? '';
}

// Marks the chosen button of a segmented control.
function setSegmentValue(group: HTMLElement, value: string | undefined): void {
  for (const button of group.querySelectorAll<HTMLButtonElement>('button[data-value]')) {
    button.setAttribute('aria-pressed', String(button.dataset.value === value));
  }
}

// Paints the filled part of a range input.
function paintSlider(input: HTMLInputElement): void {
  const min = Number(input.min);
  const max = Number(input.max);
  const fill = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--fill', `${fill}%`);
}
