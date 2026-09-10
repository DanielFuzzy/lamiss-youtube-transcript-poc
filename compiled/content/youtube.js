"use strict";
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isLoadTranscriptMessage(message)) {
        return;
    }
    try {
        const videoId = extractYouTubeVideoId(window.location.href);
        if (!videoId) {
            sendResponse({ ok: false, message: 'Could not determine YouTube video ID' });
            return;
        }
        if (!window.location.href.includes('youtube.com/watch')) {
            sendResponse({ ok: false, message: 'Active tab is not a YouTube watch page' });
            return;
        }
        console.log('Lamiss POC: YouTube content script loaded.');
        console.log('Lamiss POC: videoId=', videoId, 'language=', message.language);
        sendResponse({ ok: true, message: 'Transcript requested for YouTube video' });
    }
    catch (error) {
        console.error('Lamiss POC: content script error:', error);
        sendResponse({ ok: false, message: 'Unable to process YouTube page' });
    }
});
function isLoadTranscriptMessage(message) {
    return typeof message === 'object'
        && message !== null
        && 'type' in message
        && message.type === 'LOAD_TRANSCRIPT';
}
function extractYouTubeVideoId(url) {
    try {
        const parsed = new URL(url);
        if (parsed.hostname !== 'www.youtube.com' && parsed.hostname !== 'youtube.com') {
            return null;
        }
        if (parsed.pathname === '/watch') {
            return parsed.searchParams.get('v');
        }
        return null;
    }
    catch {
        return null;
    }
}
