const languageSelect = document.getElementById('language') as HTMLSelectElement | null;
const loadTranscriptButton = document.getElementById('loadTranscript') as HTMLButtonElement | null;
const statusBox = document.getElementById('status') as HTMLDivElement | null;

function setStatus(message: string): void {
  if (statusBox) {
    statusBox.textContent = message;
  }
}

loadTranscriptButton?.addEventListener('click', async () => {
  const selectedLanguage = languageSelect?.value ?? 'en';

  setStatus('Status: Loading...');

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];

    if (!activeTab?.id) {
      setStatus('Status: No active tab');
      return;
    }

    if (!activeTab.url?.includes('youtube.com/watch')) {
      setStatus('Status: Active tab is not YouTube');
      return;
    }

    chrome.tabs.sendMessage(
      activeTab.id,
      {
        type: 'LOAD_TRANSCRIPT',
        language: selectedLanguage
      },
      (response) => {
        if (chrome.runtime.lastError) {
          setStatus('Status: Content script unavailable');
          console.error('Content script error:', chrome.runtime.lastError.message);
          return;
        }

        if (!response?.ok) {
          setStatus(`Status: ${response?.message ?? 'Transcript failed'}`);
          return;
        }

        setStatus(`Status: ${response.message ?? 'Transcript loaded'}`);
      }
    );
  } catch (error) {
    console.error('Popup error:', error);
    setStatus('Status: Failed to load transcript');
  }
});
