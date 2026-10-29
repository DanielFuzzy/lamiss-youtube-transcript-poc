// Profile & Account: who is signed in (GET /api/auth/me) and their username
// (PATCH /api/me/profile), the languages, level, learning goal and daily goal
// Lamiss teaches for (the user's preferences on the backend), today's practice
// against that goal (GET /api/me/practice/today), and Log Out.

const profileSaveState = popupElement<HTMLSpanElement>('profileSaveState');
const profileAvatar = popupElement<HTMLImageElement>('profileAvatar');
const profileInitials = popupElement<HTMLSpanElement>('profileInitials');
const profileName = popupElement<HTMLSpanElement>('profileName');
const profileEmail = popupElement<HTMLSpanElement>('profileEmail');
const profileUsername = popupElement<HTMLSpanElement>('profileUsername');
const profileEditButton = popupElement<HTMLButtonElement>('profileEditButton');
const profileUsernameForm = popupElement<HTMLFormElement>('usernameForm');
const profileUsernameInput = popupElement<HTMLInputElement>('usernameInput');
const profileUsernameMessage = popupElement<HTMLParagraphElement>('usernameMessage');
const profileUsernameCancel = popupElement<HTMLButtonElement>('usernameCancelButton');
const profileUsernameSave = popupElement<HTMLButtonElement>('usernameSaveButton');
const profileGoalSelect = popupElement<HTMLSelectElement>('goalSelect');
const profileDailyGoalInput = popupElement<HTMLInputElement>('dailyGoalInput');
const profileDailyGoalValue = popupElement<HTMLOutputElement>('dailyGoalValue');
const profileProgressParts = {
  container: popupElement<HTMLDivElement>('profileProgress'),
  text: popupElement<HTMLSpanElement>('profileProgressText'),
  fill: popupElement<HTMLSpanElement>('profileProgressFill')
};
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
let profileSavingUsername = false;
// Bumped by every practice request; an older answer is dropped.
let profilePracticeGeneration = 0;

function profileInitialsOf(name: string): string {
  const words = name.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] ?? '?').slice(0, 2)).toUpperCase();
}

function renderProfileUser(user: { email: string; username: string; displayName?: string | null; pictureUrl?: string | null }): void {
  const name = user.displayName || user.username || user.email;
  profileName.textContent = name;
  profileEmail.textContent = user.email;
  profileUsername.textContent = user.username ? `@${user.username}` : '';
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
  profileGoalSelect.replaceChildren(new Option('Not set', ''), ...LAMISS_LEARNING_GOALS.map(entry => new Option(entry.label, entry.goal)));
  profileGoalSelect.value = preferences.learningGoal ?? '';
  renderProfileDailyGoal(preferences.dailyGoalMinutes ?? null);
}

function renderProfileDailyGoal(minutes: number | null): void {
  profileDailyGoalInput.value = String(minutes ?? 0);
  profileDailyGoalValue.textContent = formatDailyGoal(minutes);
  paintSlider(profileDailyGoalInput);
}

// Today's practice; hidden when there is no daily goal or it can't be read.
async function refreshProfilePractice(): Promise<void> {
  const generation = ++profilePracticeGeneration;
  const practice = await loadPopupPractice();
  if (generation !== profilePracticeGeneration || popupCurrentView !== 'profile') {
    return;
  }
  renderPracticeProgress(profileProgressParts, practice.ok ? practice.data : undefined);
}

async function loadProfile(): Promise<void> {
  profileError.hidden = true;
  profilePreferences.hidden = true;
  closeUsernameForm();
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
    void refreshProfilePractice();
  }
}

async function saveProfileField(change: (current: LamissPreferences) => LamissPreferences): Promise<boolean> {
  const { error } = await savePopupPreferences(profileSaveState, change);
  if (error && popupPreferences) {
    renderProfilePreferences(popupPreferences);
  }
  return !error;
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

profileGoalSelect.addEventListener('change', () => {
  const learningGoal = (profileGoalSelect.value || null) as LamissLearningGoal | null;
  void saveProfileField(current => ({ ...current, learningGoal }));
});

// The label follows the thumb; the goal is saved when it is let go.
profileDailyGoalInput.addEventListener('input', () => {
  profileDailyGoalValue.textContent = formatDailyGoal(dailyGoalFromSlider(Number(profileDailyGoalInput.value)));
  paintSlider(profileDailyGoalInput);
});

profileDailyGoalInput.addEventListener('change', async () => {
  const dailyGoalMinutes = dailyGoalFromSlider(Number(profileDailyGoalInput.value));
  if (await saveProfileField(current => ({ ...current, dailyGoalMinutes }))) {
    void refreshProfilePractice();
  }
});

// --- Username -------------------------------------------------------------------

function currentUsername(): string {
  return popupProfile?.username ?? (popupAuthState.status === 'signedIn' ? popupAuthState.user.username : '');
}

function setUsernameMessage(text: string, tone?: 'error' | 'ok'): void {
  profileUsernameMessage.textContent = text;
  if (tone) {
    profileUsernameMessage.dataset.tone = tone;
  } else {
    delete profileUsernameMessage.dataset.tone;
  }
  profileUsernameInput.parentElement!.dataset.invalid = String(tone === 'error');
  profileUsernameInput.setAttribute('aria-invalid', String(tone === 'error'));
}

function openUsernameForm(): void {
  profileUsernameForm.hidden = false;
  profileEditButton.setAttribute('aria-expanded', 'true');
  profileUsernameInput.value = currentUsername();
  setUsernameMessage('');
  profileUsernameInput.focus();
  profileUsernameInput.select();
}

function closeUsernameForm(): void {
  profileUsernameForm.hidden = true;
  profileEditButton.setAttribute('aria-expanded', 'false');
  setUsernameMessage('');
}

function renderUsernameBusy(): void {
  profileUsernameInput.readOnly = profileSavingUsername;
  profileUsernameSave.disabled = profileSavingUsername;
  profileUsernameCancel.disabled = profileSavingUsername;
  profileUsernameSave.textContent = profileSavingUsername ? 'Saving…' : 'Save';
}

profileEditButton.addEventListener('click', () => {
  if (profileUsernameForm.hidden) {
    openUsernameForm();
  } else if (!profileSavingUsername) {
    closeUsernameForm();
  }
});

profileUsernameCancel.addEventListener('click', () => {
  closeUsernameForm();
  profileEditButton.focus();
});

// Escape cancels the edit instead of leaving the view.
profileUsernameForm.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !profileSavingUsername) {
    event.preventDefault();
    event.stopPropagation();
    closeUsernameForm();
    profileEditButton.focus();
  }
});

// A message about the rules goes away as soon as the name follows them.
profileUsernameInput.addEventListener('input', () => {
  if (profileUsernameMessage.dataset.tone === 'error' && !usernameProblem(profileUsernameInput.value.trim())) {
    setUsernameMessage('');
  }
});

profileUsernameForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (profileSavingUsername) {
    return;
  }
  const username = profileUsernameInput.value.trim();
  if (username === currentUsername()) {
    closeUsernameForm();
    return;
  }
  const problem = usernameProblem(username);
  if (problem) {
    setUsernameMessage(problem, 'error');
    profileUsernameInput.focus();
    return;
  }
  profileSavingUsername = true;
  renderUsernameBusy();
  setUsernameMessage('');
  const result = await updateUsername(username);
  profileSavingUsername = false;
  renderUsernameBusy();
  if (result.ok) {
    popupProfile = result.data;
    if (popupAuthState.status === 'signedIn') {
      popupAuthState.user = { ...popupAuthState.user, username: result.data.username };
    }
    renderProfileUser(result.data);
    closeUsernameForm();
    setPopupSaveState(profileSaveState, 'saved');
    profileEditButton.focus();
    return;
  }
  const message = result.signInRequired || result.status === undefined
    ? describePopupFailure(result)
    : describeUsernameFailure(result);
  setUsernameMessage(message, 'error');
  profileUsernameInput.focus();
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
  },
  leave: () => {
    profilePracticeGeneration += 1;
  }
});
