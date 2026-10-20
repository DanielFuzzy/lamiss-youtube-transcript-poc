// Audio & Voice: the microphone and speaker Lamiss uses on this computer
// (lamissDeviceSettings, local), its volume (local), and the tutor's voice and
// speaking speed (the user's preferences on the backend).

const audioSaveState = popupElement<HTMLSpanElement>('audioSaveState');
const audioMicSelect = popupElement<HTMLSelectElement>('micSelect');
const audioMicPermission = popupElement<HTMLDivElement>('micPermission');
const audioMicPermissionButton = popupElement<HTMLButtonElement>('micPermissionButton');
const audioMicMeter = popupElement<HTMLDivElement>('micMeter');
const audioMicTestButton = popupElement<HTMLButtonElement>('micTestButton');
const audioMicMessage = popupElement<HTMLParagraphElement>('micMessage');
const audioSpeakerSelect = popupElement<HTMLSelectElement>('speakerSelect');
const audioSpeakerUnsupported = popupElement<HTMLParagraphElement>('speakerUnsupported');
const audioSpeakerTestButton = popupElement<HTMLButtonElement>('speakerTestButton');
const audioSpeakerMessage = popupElement<HTMLParagraphElement>('speakerMessage');
const audioVoiceAccountNote = popupElement<HTMLParagraphElement>('voiceAccountNote');
const audioVoiceControls = popupElement<HTMLDivElement>('voiceControls');
const audioVoiceSelect = popupElement<HTMLSelectElement>('voiceSelect');
const audioVoiceReadOnly = popupElement<HTMLParagraphElement>('voiceReadOnly');
const audioVoiceHint = popupElement<HTMLParagraphElement>('voiceHint');
const audioVoicePreviewButton = popupElement<HTMLButtonElement>('voicePreviewButton');
const audioVoiceMessage = popupElement<HTMLParagraphElement>('voiceMessage');
const audioSpeedInput = popupElement<HTMLInputElement>('speedInput');
const audioSpeedValue = popupElement<HTMLOutputElement>('speedValue');
const audioVolumeInput = popupElement<HTMLInputElement>('volumeInput');
const audioVolumeValue = popupElement<HTMLOutputElement>('volumeValue');

const AUDIO_METER_BARS = 22;
const AUDIO_MIC_TEST_MS = 15_000;
// No sound above this level for this long: probably the wrong microphone.
const AUDIO_SILENT_LEVEL = 0.01;
const AUDIO_SILENT_HINT_MS = 4000;
const AUDIO_SPEED_SAVE_DELAY_MS = 400;

// A short line in each language a Kokoro voice can speak; others preview in English.
const AUDIO_PREVIEW_PHRASES: Record<string, string> = {
  en: 'Hi! I\'m Lamiss. Let\'s learn together while you watch.',
  es: '¡Hola! Soy Lamiss. Aprendamos juntos mientras ves el vídeo.',
  fr: 'Bonjour ! Je suis Lamiss. Apprenons ensemble pendant que tu regardes.',
  it: 'Ciao! Sono Lamiss. Impariamo insieme mentre guardi.',
  pt: 'Olá! Eu sou a Lamiss. Vamos aprender juntos enquanto você assiste.',
  hi: 'नमस्ते! मैं लामिस हूँ। चलिए साथ में सीखते हैं।',
  ja: 'こんにちは！ラミスです。一緒に楽しく学びましょう。',
  zh: '你好！我是 Lamiss。我们一起边看边学吧。',
  de: 'Hallo! Ich bin Lamiss. Lass uns zusammen lernen, während du schaust.'
};

type AudioMicTest = { stream: MediaStream; context: AudioContext; frame: number; stopTimer: number };

let audioMicTest: AudioMicTest | undefined;
let audioPlayback: { audio: HTMLAudioElement; url: string } | undefined;
let audioVoices: LamissVoiceList | undefined;
let audioSpeedTimer: number | undefined;

function setAudioMessage(element: HTMLElement, text: string, tone?: 'error' | 'ok'): void {
  element.textContent = text;
  if (tone) {
    element.dataset.tone = tone;
  } else {
    delete element.dataset.tone;
  }
}

function audioSinkSupported(): boolean {
  return typeof (HTMLMediaElement.prototype as HTMLMediaElement & { setSinkId?: unknown }).setSinkId === 'function';
}

// --- Devices ------------------------------------------------------------------------

function fillDeviceSelect(select: HTMLSelectElement, devices: MediaDeviceInfo[], fallbackName: string, selected: string | undefined): void {
  // "default" and "communications" are Chrome's aliases of real devices.
  const real = devices.filter(device => device.deviceId && device.deviceId !== 'default' && device.deviceId !== 'communications');
  select.replaceChildren(
    new Option('System default', ''),
    ...real.map((device, index) => new Option(device.label || `${fallbackName} ${index + 1}`, device.deviceId))
  );
  // A device that is gone (or not listed without permission) shows as the default.
  select.value = selected && real.some(device => device.deviceId === selected) ? selected : '';
}

async function loadAudioDevices(): Promise<void> {
  const settings = await readDeviceSettings();
  audioVolumeInput.value = String(Math.round(settings.volume * 100));
  renderAudioVolume();

  if (!navigator.mediaDevices?.enumerateDevices) {
    audioMicSelect.disabled = true;
    audioSpeakerSelect.disabled = true;
    audioMicTestButton.disabled = true;
    setAudioMessage(audioMicMessage, 'This browser doesn\'t let Lamiss list your devices; it uses the default ones.', 'error');
    return;
  }

  let devices: MediaDeviceInfo[] = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch (error) {
    console.error('Lamiss POC: could not list devices:', error);
  }
  const inputs = devices.filter(device => device.kind === 'audioinput');
  const outputs = devices.filter(device => device.kind === 'audiooutput');
  // Without the microphone permission Chrome hides names and IDs.
  const permitted = inputs.some(device => device.label);
  audioMicPermission.hidden = permitted;

  fillDeviceSelect(audioMicSelect, permitted ? inputs : [], 'Microphone', settings.micDeviceId);
  fillDeviceSelect(audioSpeakerSelect, permitted ? outputs : [], 'Speaker', settings.speakerDeviceId);

  const sinkSupported = audioSinkSupported();
  audioSpeakerSelect.disabled = !sinkSupported;
  audioSpeakerUnsupported.hidden = sinkSupported;
}

audioMicSelect.addEventListener('change', async () => {
  stopAudioMicTest();
  await saveDeviceSettings({ micDeviceId: audioMicSelect.value || undefined });
  setAudioMessage(audioMicMessage, 'Lamiss will listen with this microphone.', 'ok');
});

audioSpeakerSelect.addEventListener('change', async () => {
  await saveDeviceSettings({ speakerDeviceId: audioSpeakerSelect.value || undefined });
  setAudioMessage(audioSpeakerMessage, 'Lamiss will speak on this speaker.', 'ok');
});

// The popup can't always show Chrome's microphone prompt; a regular extension
// tab can, and the permission then covers every extension page.
audioMicPermissionButton.addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('permission/permission.html') });
});

navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  if (popupCurrentView === 'audio') {
    void loadAudioDevices();
  }
});

// --- Microphone test ------------------------------------------------------------------

function renderAudioMeter(level: number): void {
  const lit = Math.round(Math.min(1, Math.sqrt(level) * 2.4) * AUDIO_METER_BARS);
  audioMicMeter.querySelectorAll('span').forEach((bar, index) => {
    bar.dataset.on = String(index < lit);
  });
}

function stopAudioMicTest(): void {
  const test = audioMicTest;
  audioMicTest = undefined;
  audioMicTestButton.dataset.active = 'false';
  audioMicTestButton.querySelector('span')!.textContent = 'Test microphone';
  renderAudioMeter(0);
  if (!test) {
    return;
  }
  cancelAnimationFrame(test.frame);
  window.clearTimeout(test.stopTimer);
  test.stream.getTracks().forEach(track => track.stop());
  void test.context.close();
}

async function startAudioMicTest(): Promise<void> {
  setAudioMessage(audioMicMessage, 'Opening the microphone…');
  let stream: MediaStream;
  try {
    stream = await getMicrophoneStream(audioMicSelect.value || undefined);
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      audioMicPermission.hidden = false;
      setAudioMessage(audioMicMessage, 'Lamiss isn\'t allowed to use the microphone yet. Click "Allow microphone" above.', 'error');
    } else if (name === 'NotFoundError') {
      setAudioMessage(audioMicMessage, 'No microphone was found. Plug one in and try again.', 'error');
    } else if (name === 'NotReadableError') {
      setAudioMessage(audioMicMessage, 'The microphone is busy in another app. Close it there and try again.', 'error');
    } else {
      setAudioMessage(audioMicMessage, 'The microphone could not be opened.', 'error');
    }
    return;
  }
  if (popupCurrentView !== 'audio') {
    stream.getTracks().forEach(track => track.stop());
    return;
  }

  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const startedAt = Date.now();
  let heardSomething = false;

  const test: AudioMicTest = { stream, context, frame: 0, stopTimer: 0 };
  audioMicTest = test;
  audioMicTestButton.dataset.active = 'true';
  audioMicTestButton.querySelector('span')!.textContent = 'Stop test';
  setAudioMessage(audioMicMessage, 'Say something: the bars should move.');
  // Labels appear once the permission is granted.
  if (!audioMicPermission.hidden) {
    void loadAudioDevices();
  }

  const tick = () => {
    if (audioMicTest !== test) {
      return;
    }
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      sum += sample * sample;
    }
    const level = Math.sqrt(sum / samples.length);
    renderAudioMeter(level);
    if (level > AUDIO_SILENT_LEVEL && !heardSomething) {
      heardSomething = true;
      setAudioMessage(audioMicMessage, 'Lamiss can hear you.', 'ok');
    } else if (!heardSomething && Date.now() - startedAt > AUDIO_SILENT_HINT_MS) {
      setAudioMessage(audioMicMessage, 'Lamiss can\'t hear anything. Is the right microphone selected and unmuted?', 'error');
    }
    test.frame = requestAnimationFrame(tick);
  };
  test.stopTimer = window.setTimeout(stopAudioMicTest, AUDIO_MIC_TEST_MS);
  tick();
}

audioMicTestButton.addEventListener('click', () => {
  if (audioMicTest) {
    stopAudioMicTest();
  } else {
    void startAudioMicTest();
  }
});

// --- Playback ---------------------------------------------------------------------------

function stopAudioPlayback(): void {
  if (audioPlayback) {
    audioPlayback.audio.pause();
    URL.revokeObjectURL(audioPlayback.url);
    audioPlayback = undefined;
  }
}

// Plays on the chosen speaker at the chosen volume, as Lamiss's voice will.
async function playAudioSample(blob: Blob): Promise<void> {
  stopAudioPlayback();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  const playback = { audio, url };
  audioPlayback = playback;
  audio.volume = Number(audioVolumeInput.value) / 100;
  await routeAudioToSpeaker(audio, audioSinkSupported() ? audioSpeakerSelect.value || undefined : undefined);
  audio.addEventListener('ended', () => {
    if (audioPlayback === playback) {
      stopAudioPlayback();
    }
  });
  await audio.play();
}

// A short two-note chime as a WAV file, made here: no backend needed.
function makeAudioTestTone(): Blob {
  const sampleRate = 44_100;
  const notes = [{ frequency: 659.25, seconds: 0.22 }, { frequency: 987.77, seconds: 0.42 }];
  const total = notes.reduce((sum, note) => sum + Math.round(note.seconds * sampleRate), 0);
  const buffer = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + total * 2, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, total * 2, true);
  let offset = 44;
  for (const note of notes) {
    const count = Math.round(note.seconds * sampleRate);
    for (let i = 0; i < count; i += 1) {
      const t = i / sampleRate;
      const envelope = Math.min(1, t / 0.01) * Math.exp(-4 * t);
      view.setInt16(offset, Math.sin(2 * Math.PI * note.frequency * t) * envelope * 0.5 * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

audioSpeakerTestButton.addEventListener('click', async () => {
  try {
    await playAudioSample(makeAudioTestTone());
    setAudioMessage(audioSpeakerMessage, 'Playing a test sound. Didn\'t hear it? Try another speaker or turn the volume up.');
  } catch (error) {
    console.error('Lamiss POC: test sound failed:', error);
    setAudioMessage(audioSpeakerMessage, 'The test sound could not be played.', 'error');
  }
});

// --- Volume (local) ---------------------------------------------------------------------

function renderAudioVolume(): void {
  audioVolumeValue.textContent = `${audioVolumeInput.value}%`;
  paintSlider(audioVolumeInput);
}

audioVolumeInput.addEventListener('input', () => {
  renderAudioVolume();
  if (audioPlayback) {
    audioPlayback.audio.volume = Number(audioVolumeInput.value) / 100;
  }
});

audioVolumeInput.addEventListener('change', () => {
  void saveDeviceSettings({ volume: Number(audioVolumeInput.value) / 100 });
});

// --- Voice and speed (backend) -----------------------------------------------------------

function renderAudioSpeed(): void {
  audioSpeedValue.textContent = `${Number(audioSpeedInput.value).toFixed(2).replace(/0$/, '')}x`;
  paintSlider(audioSpeedInput);
}

function setAudioVoiceEnabled(enabled: boolean): void {
  audioVoiceSelect.disabled = !enabled;
  audioVoicePreviewButton.disabled = !enabled;
  audioSpeedInput.disabled = !enabled;
}

function renderAudioVoices(list: LamissVoiceList, preferences: LamissPreferences): void {
  const learning = preferences.learningLanguage;
  audioSpeedInput.value = String(preferences.voice.speed);
  renderAudioSpeed();
  setAudioVoiceEnabled(true);

  if (!list.selectable) {
    // One voice for everything (the OpenAI provider): shown, not chosen.
    const only = list.voices[0];
    audioVoiceSelect.hidden = true;
    audioVoiceReadOnly.hidden = false;
    audioVoiceReadOnly.textContent = only ? `${only.label} (${list.provider})` : `The ${list.provider} voice`;
    audioVoiceHint.textContent = 'Your Lamiss server uses this one voice for every language.';
    return;
  }

  audioVoiceSelect.hidden = false;
  audioVoiceReadOnly.hidden = true;
  const offered = voicesForLanguage(list.voices, learning);
  const options: Array<HTMLOptionElement | HTMLOptGroupElement> = [];
  const defaultVoice = learning ? offered.find(voice => voice.default) : undefined;
  options.push(new Option(defaultVoice ? `Default voice (${defaultVoice.label})` : 'Default voice for each language', ''));
  if (learning) {
    options.push(...offered.map(voice => new Option(voice.label, voice.id)));
    audioVoiceHint.textContent = offered.length > 0
      ? `Voices for ${lamissLanguageName(learning)}, the language you're learning.`
      : `There are no other voices for ${lamissLanguageName(learning)} yet.`;
  } else {
    const languages = [...new Set(offered.map(voice => voice.language))]
      .sort((a, b) => lamissLanguageName(a).localeCompare(lamissLanguageName(b)));
    for (const language of languages) {
      const group = document.createElement('optgroup');
      group.label = lamissLanguageName(language);
      group.append(...offered.filter(voice => voice.language === language).map(voice => new Option(voice.label, voice.id)));
      options.push(group);
    }
    audioVoiceHint.textContent = 'Set the language you\'re learning in Profile & Account to see just its voices.';
  }
  audioVoiceSelect.replaceChildren(...options);
  const saved = preferences.voice.voiceId;
  if (saved && !offered.some(voice => voice.id === saved)) {
    // A voice of another language: keep it visible rather than dropping it.
    const voice = list.voices.find(candidate => candidate.id === saved);
    audioVoiceSelect.append(new Option(voice ? `${voice.label} (${lamissLanguageName(voice.language)})` : saved, saved));
  }
  audioVoiceSelect.value = saved ?? '';
}

async function loadAudioVoices(): Promise<void> {
  const signedIn = popupSignedIn();
  audioVoiceAccountNote.hidden = signedIn;
  audioVoiceControls.hidden = !signedIn;
  setAudioVoiceEnabled(false);
  if (!signedIn) {
    return;
  }
  setAudioMessage(audioVoiceMessage, '');
  audioVoiceSelect.hidden = false;
  audioVoiceReadOnly.hidden = true;
  audioVoiceSelect.replaceChildren(new Option('Loading voices…', ''));

  const [voices, preferences] = await Promise.all([fetchVoices(), loadPopupPreferences()]);
  if (popupCurrentView !== 'audio') {
    return;
  }
  const failed = !voices.ok ? voices : !preferences.ok ? preferences : undefined;
  if (failed && !failed.ok) {
    audioVoiceSelect.replaceChildren(new Option('Voices unavailable', ''));
    audioVoiceHint.textContent = '';
    setAudioMessage(audioVoiceMessage, describePopupFailure(failed), 'error');
    return;
  }
  if (voices.ok && preferences.ok) {
    audioVoices = voices.data;
    renderAudioVoices(voices.data, preferences.data);
  }
}

audioVoiceSelect.addEventListener('change', async () => {
  const voiceId = audioVoiceSelect.value || null;
  setAudioMessage(audioVoiceMessage, '');
  const { error } = await savePopupPreferences(audioSaveState, current => ({ ...current, voice: { ...current.voice, voiceId } }));
  if (error) {
    setAudioMessage(audioVoiceMessage, error, 'error');
  }
});

audioSpeedInput.addEventListener('input', renderAudioSpeed);

// Saved once the slider is let go, and only the last of quick changes.
audioSpeedInput.addEventListener('change', () => {
  window.clearTimeout(audioSpeedTimer);
  audioSpeedTimer = window.setTimeout(async () => {
    const speed = Number(audioSpeedInput.value);
    const { error } = await savePopupPreferences(audioSaveState, current => ({ ...current, voice: { ...current.voice, speed } }));
    if (error) {
      setAudioMessage(audioVoiceMessage, error, 'error');
    }
  }, AUDIO_SPEED_SAVE_DELAY_MS);
});

// The backend speaks with the saved voice and speed, so they are saved first.
audioVoicePreviewButton.addEventListener('click', async () => {
  audioVoicePreviewButton.disabled = true;
  setAudioMessage(audioVoiceMessage, 'Lamiss is getting ready to speak…');
  window.clearTimeout(audioSpeedTimer);
  const voiceId = audioVoiceSelect.hidden ? undefined : audioVoiceSelect.value || null;
  const speed = Number(audioSpeedInput.value);
  const { saved, error } = await savePopupPreferences(audioSaveState, current => ({
    ...current,
    voice: { voiceId: voiceId === undefined ? current.voice.voiceId : voiceId, speed }
  }));
  if (!saved) {
    audioVoicePreviewButton.disabled = false;
    setAudioMessage(audioVoiceMessage, error ?? 'Could not save the voice.', 'error');
    return;
  }

  const voice = audioVoices?.voices.find(candidate => candidate.id === saved.voice.voiceId);
  const wanted = voice?.language ?? saved.learningLanguage ?? 'en';
  const language = AUDIO_PREVIEW_PHRASES[wanted] ? wanted : 'en';
  const result = await synthesizeSpeech(AUDIO_PREVIEW_PHRASES[language], language);
  audioVoicePreviewButton.disabled = false;
  if (!result.ok) {
    setAudioMessage(audioVoiceMessage, describePopupFailure(result), 'error');
    return;
  }
  try {
    await playAudioSample(result.data);
    setAudioMessage(audioVoiceMessage, language === wanted ? 'Playing a preview of this voice.' : `There's no ${lamissLanguageName(wanted)} preview yet, so this one is in English.`);
  } catch (playError) {
    console.error('Lamiss POC: voice preview failed:', playError);
    setAudioMessage(audioVoiceMessage, 'The preview could not be played.', 'error');
  }
});

// --- View ------------------------------------------------------------------------------

audioMicMeter.append(...Array.from({ length: AUDIO_METER_BARS }, () => document.createElement('span')));

registerPopupView('audio', {
  enter: () => {
    setPopupSaveState(audioSaveState, 'idle');
    setAudioMessage(audioMicMessage, '');
    setAudioMessage(audioSpeakerMessage, '');
    void loadAudioDevices();
    void loadAudioVoices();
  },
  leave: () => {
    stopAudioMicTest();
    stopAudioPlayback();
  }
});

onPopupAuthChange(() => {
  if (popupCurrentView === 'audio') {
    void loadAudioVoices();
  }
});
