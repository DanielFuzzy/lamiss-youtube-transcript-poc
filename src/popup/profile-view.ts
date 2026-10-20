// Profile & Account: who is signed in (GET /api/auth/me), the languages and
// level Lamiss teaches for (the user's preferences on the backend), and Log Out.

const profileSaveState = popupElement<HTMLSpanElement>('profileSaveState');
const profileAvatar = popupElement<HTMLImageElement>('profileAvatar');
const profileInitials = popupElement<HTMLSpanElement>('profileInitials');
const profileName = popupElement<HTMLParagraphElement>('profileName');
const profileEmail = popupElement<HTMLParagraphElement>('profileEmail');
const profileError = popupElement<HTMLDivElement>('profileError');
const profileErrorText = popupElement<HTMLParagraphElement>('profileErrorText');
const profileRetryButton = popupElement<HTMLButtonElement>('profileRetryButton');
const profilePreferences = popupElement<HTMLElement>('profilePreferences');
const profileNativeSelect = popupElement<HTMLSelectElement>('nativeSelect');
const profileLearningSelect = popupElement<HTMLSelectElement>('learningSelect');
const profileLevelSelect = popupElement<HTMLSelectElement>('levelSelect');
const profileSignOutButton = popupElement<HTMLButtonElement>('signOutButton');

const PROFILE_LEVELS: ReadonlyArray<{ level: LamissProficiencyLevel; label: string }> = [
  { level: 'A1', label: 'A1 · Beginner' },
  { level: 'A2', label: 'A2 · Elementary' },
  { level: 'B1', label: 'B1 · Intermediate' },
  { level: 'B2', label: 'B2 · Upper intermediate' },
  { level: 'C1', label: 'C1 · Advanced' },
  { level: 'C2', label: 'C2 · Proficient' }
];

let profileSigningOut = false;

function profileInitialsOf(name: string): string {
  const words = name.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] ?? '?').slice(0, 2)).toUpperCase();
}

function renderProfileUser(user: { email: string; username: string; displayName?: string | null; pictureUrl?: string | null }): void {
  const name = user.displayName || user.username || user.email;
  profileName.textContent = name;
  profileEmail.textContent = user.email;
  profileInitials.textContent = profileInitialsOf(name);
  // The backend only keeps https pictures from Google's servers (TDR-0002).
  if (user.pictureUrl && user.pictureUrl.startsWith('https://')) {
    profileAvatar.src = user.pictureUrl;
    profileAvatar.hidden = false;
  } else {
    profileAvatar.removeAttribute('src');
    profileAvatar.hidden = true;
  }
}

profileAvatar.addEventListener('error', () => {
  profileAvatar.hidden = true;
});

function renderProfilePreferences(preferences: LamissPreferences): void {
  fillLanguageSelect(profileNativeSelect, 'Not set', preferences.nativeLanguage);
  fillLanguageSelect(profileLearningSelect, 'Not set', preferences.learningLanguage);
  profileLevelSelect.replaceChildren(new Option('Not set', ''), ...PROFILE_LEVELS.map(entry => new Option(entry.label, entry.level)));
  profileLevelSelect.value = preferences.proficiencyLevel ?? '';
}

async function loadProfile(): Promise<void> {
  profileError.hidden = true;
  profilePreferences.hidden = true;
  if (popupAuthState.status === 'signedIn') {
    // What the sign-in stored, until the backend answers.
    renderProfileUser(popupAuthState.user);
  }
  const [profile, preferences] = await Promise.all([loadPopupProfile(), loadPopupPreferences()]);
  if (popupCurrentView !== 'profile') {
    return;
  }
  if (profile.ok) {
    renderProfileUser(profile.data);
  }
  const failed = !preferences.ok ? preferences : !profile.ok ? profile : undefined;
  if (failed && !failed.ok) {
    profileErrorText.textContent = describePopupFailure(failed);
    profileError.hidden = false;
  }
  if (preferences.ok) {
    renderProfilePreferences(preferences.data);
    profilePreferences.hidden = false;
  }
}

async function saveProfileField(change: (current: LamissPreferences) => LamissPreferences): Promise<void> {
  const { error } = await savePopupPreferences(profileSaveState, change);
  if (error && popupPreferences) {
    renderProfilePreferences(popupPreferences);
  }
}

profileNativeSelect.addEventListener('change', () => {
  const nativeLanguage = profileNativeSelect.value || null;
  void saveProfileField(current => ({ ...current, nativeLanguage }));
});

profileLearningSelect.addEventListener('change', () => {
  const learningLanguage = profileLearningSelect.value || null;
  void saveProfileField(current => ({ ...current, learningLanguage }));
});

profileLevelSelect.addEventListener('change', () => {
  const proficiencyLevel = (profileLevelSelect.value || null) as LamissProficiencyLevel | null;
  void saveProfileField(current => ({ ...current, proficiencyLevel }));
});

profileRetryButton.addEventListener('click', () => void loadProfile());

// The TDR-0001 sign-out, run by the worker; the popup then shows the
// signed-out home.
profileSignOutButton.addEventListener('click', async () => {
  if (profileSigningOut) {
    return;
  }
  profileSigningOut = true;
  profileSignOutButton.disabled = true;
  profileSignOutButton.querySelector('span')!.textContent = 'Logging out…';
  await chrome.runtime.sendMessage({ type: LAMISS_SIGN_OUT_MESSAGE }).catch(() => undefined);
  profileSigningOut = false;
  profileSignOutButton.disabled = false;
  profileSignOutButton.querySelector('span')!.textContent = 'Log Out';
  await refreshPopupAuth();
  showPopupView('home');
});

registerPopupView('profile', {
  enter: () => {
    setPopupSaveState(profileSaveState, 'idle');
    void loadProfile();
  }
});
