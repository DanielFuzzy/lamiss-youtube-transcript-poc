"use strict";
const languageSelect = document.getElementById('language');
const loadTranscriptButton = document.getElementById('loadTranscript');
const statusBox = document.getElementById('status');
function setStatus(message) {
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
        if (!activeTab.url) {
            setStatus('Status: Active tab has no URL');
            return;
        }
        const parsedActiveTabUrl = new URL(activeTab.url);
        if (parsedActiveTabUrl.hostname !== 'www.youtube.com' && parsedActiveTabUrl.hostname !== 'youtube.com') {
            setStatus('Status: Active tab is not a YouTube watch page');
            return;
        }
        if (parsedActiveTabUrl.pathname !== '/watch') {
            setStatus('Status: Active tab is not a YouTube watch page');
            return;
        }
        if (!parsedActiveTabUrl.searchParams.get('v')) {
            setStatus('Status: Active tab is not a YouTube watch page');
            return;
        }
        chrome.tabs.sendMessage(activeTab.id, {
            type: 'LOAD_TRANSCRIPT',
            language: selectedLanguage,
            tabId: activeTab.id
        }, (response) => {
            if (chrome.runtime.lastError) {
                setStatus('Status: Content script unavailable');
                console.error('Content script error:', chrome.runtime.lastError.message);
                return;
            }
            if (!response?.success) {
                setStatus(`Status: ${response?.error ?? 'Transcript failed'}`);
                return;
            }
            setStatus(`Status: Video ${response.videoId ?? 'unknown'} loaded for ${response.language ?? selectedLanguage}`);
        });
    }
    catch (error) {
        console.error('Popup error:', error);
        setStatus('Status: Failed to load transcript');
    }
});
