"use strict";
const LAMISS_BACKEND_ENDPOINT = 'http://localhost:8080/api/transcripts/';
const languageSelect = document.getElementById('language');
const loadTranscriptButton = document.getElementById('loadTranscript');
const statusBox = document.getElementById('status');
function setStatus(message) {
    if (statusBox) {
        statusBox.textContent = message;
    }
}
async function sendTranscriptToBackend(payload) {
    try {
        const response = await fetch(LAMISS_BACKEND_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        return { ok: response.ok, status: response.status };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
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
        }, async (response) => {
            if (chrome.runtime.lastError) {
                setStatus('Status: Content script unavailable');
                console.error('Content script error:', chrome.runtime.lastError.message);
                return;
            }
            if (!response?.success) {
                setStatus(`Status: ${response?.error ?? 'Transcript failed'}`);
                return;
            }
            const translatedNote = response.translated ? ' (machine-translated)' : '';
            const loadedNote = `Video ${response.videoId ?? 'unknown'} loaded for ${response.language ?? selectedLanguage}${translatedNote}`;
            setStatus(`Status: ${loadedNote} — sending to Lamiss...`);
            const uploadResult = await sendTranscriptToBackend({
                videoExternalId: response.videoId,
                language: response.language,
                translated: response.translated,
                rawCaptionResponse: response.rawCaptionResponse
            });
            if (!uploadResult.ok) {
                console.error('Lamiss backend upload failed:', uploadResult.error ?? uploadResult.status);
                setStatus(`Status: ${loadedNote} — upload failed`);
                return;
            }
            setStatus(`Status: ${loadedNote} — sent to Lamiss`);
        });
    }
    catch (error) {
        console.error('Popup error:', error);
        setStatus('Status: Failed to load transcript');
    }
});
