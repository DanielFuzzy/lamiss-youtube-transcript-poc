// Tutor Behavior: kindness, response length, encouragement, the tutor
// language (TDR-0003) and auto-pause (the user's preferences on the backend), and how often Lamiss asks
// its own questions (lamissQuestionSettings, local; the worker sends it over
// the live connection).

const tutorSaveState = popupElement<HTMLSpanElement>('tutorSaveState');
const tutorLoading = popupElement<HTMLDivElement>('tutorLoading');
const tutorError = popupElement<HTMLDivElement>('tutorError');
const tutorErrorText = popupElement<HTMLParagraphElement>('tutorErrorText');
const tutorRetryButton = popupElement<HTMLButtonElement>('tutorRetryButton');
const tutorForm = popupElement<HTMLDivElement>('tutorForm');
const tutorKindness = document.querySelector<HTMLElement>('[data-segment="kindness"]')!;
const tutorFrequency = document.querySelector<HTMLElement>('[data-segment="frequency"]')!;
const tutorResponseLength = document.querySelector<HTMLElement>('[data-segment="responseLength"]')!;
const tutorEncouragementInput = popupElement<HTMLInputElement>('encouragementInput');
const tutorLanguageSelect = popupElement<HTMLSelectElement>('tutorLanguageSelect');
const tutorAutoPauseInput = popupElement<HTMLInputElement>('autoPauseInput');
const tutorAutoPauseHint = popupElement<HTMLParagraphElement>('autoPauseHint');

function renderTutorAutoPause(on: boolean): void {
  tutorAutoPauseInput.checked = on;
  tutorAutoPauseHint.textContent = on ? lamissT('tutor.autoPauseOn') : lamissT('tutor.autoPauseOff');
}

function renderTutor(preferences: LamissPreferences): void {
  setSegmentValue(tutorKindness, preferences.tutor.kindness);
  setSegmentValue(tutorResponseLength, preferences.tutor.responseLength);
  tutorEncouragementInput.checked = preferences.tutor.encouragement;
  // Not chosen: the video's (caption) language, as before TDR-0003.
  fillLanguageSelect(tutorLanguageSelect, lamissT('common.videosLanguage'), lamissTutorLanguage(preferences));
  // Not set (or an older backend) means on.
  renderTutorAutoPause(preferences.tutor.autoPause !== false);
}

async function loadTutor(): Promise<void> {
  tutorLoading.hidden = false;
  tutorError.hidden = true;
  tutorForm.hidden = true;
  const [preferences, questions] = await Promise.all([loadPopupPreferences(), readQuestionSettings()]);
  if (popupCurrentView !== 'tutor') {
    return;
  }
  tutorLoading.hidden = true;
  if (!preferences.ok) {
    tutorErrorText.textContent = describePopupFailure(preferences);
    tutorError.hidden = false;
    return;
  }
  renderTutor(preferences.data);
  setSegmentValue(tutorFrequency, questionFrequencyFor(questions.minSecondsBetweenQuestions));
  tutorForm.hidden = false;
}

// Saves one tutor field; on failure the controls go back to what is saved.
async function saveTutor(change: Partial<LamissPreferences['tutor']>): Promise<void> {
  const { error } = await savePopupPreferences(tutorSaveState, current => ({ ...current, tutor: { ...current.tutor, ...change } }));
  if (error && popupPreferences) {
    renderTutor(popupPreferences);
  }
}

function onSegmentClick(group: HTMLElement, handler: (value: string) => void): void {
  group.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-value]');
    if (!button?.dataset.value || button.getAttribute('aria-pressed') === 'true') {
      return;
    }
    setSegmentValue(group, button.dataset.value);
    handler(button.dataset.value);
  });
}

onSegmentClick(tutorKindness, value => void saveTutor({ kindness: value as LamissKindness }));
onSegmentClick(tutorResponseLength, value => void saveTutor({ responseLength: value as LamissResponseLength }));

// Only the gap changes: the difficulty stays what the chat panel set.
onSegmentClick(tutorFrequency, async (value) => {
  const choice = LAMISS_QUESTION_FREQUENCIES.find(frequency => frequency.key === value);
  if (!choice) {
    return;
  }
  try {
    const current = await readQuestionSettings();
    await saveQuestionSettings({ ...current, minSecondsBetweenQuestions: choice.seconds });
    setPopupSaveState(tutorSaveState, 'saved');
  } catch (error) {
    setPopupSaveState(tutorSaveState, 'error', error instanceof Error ? error.message : String(error));
  }
});

tutorEncouragementInput.addEventListener('change', () => {
  void saveTutor({ encouragement: tutorEncouragementInput.checked });
});

tutorAutoPauseInput.addEventListener('change', () => {
  renderTutorAutoPause(tutorAutoPauseInput.checked);
  void saveTutor({ autoPause: tutorAutoPauseInput.checked });
});

tutorLanguageSelect.addEventListener('change', async () => {
  const tutorLanguage = tutorLanguageSelect.value || null;
  const { error } = await savePopupPreferences(tutorSaveState, current => ({ ...current, tutorLanguage }));
  if (error && popupPreferences) {
    renderTutor(popupPreferences);
  }
});

tutorRetryButton.addEventListener('click', () => void loadTutor());

registerPopupView('tutor', {
  enter: () => {
    setPopupSaveState(tutorSaveState, 'idle');
    void loadTutor();
  }
});
