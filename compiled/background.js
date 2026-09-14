"use strict";
async function fetchCaptionResourceMainWorld(captionUrl) {
    const response = await fetch(captionUrl, {
        credentials: 'include'
    });
    const text = await response.text();
    return {
        ok: response.ok,
        status: response.status,
        contentType: response.headers.get('content-type') ?? 'unknown',
        text
    };
}
function discoverCaptionTracksMainWorld() {
    const globalWindow = window;
    const playerResponse = globalWindow.ytInitialPlayerResponse;
    const playerResponseKeys = playerResponse ? Object.keys(playerResponse) : [];
    const captions = playerResponse?.captions;
    const captionsKeys = captions ? Object.keys(captions) : [];
    const renderer = captions?.playerCaptionsTracklistRenderer;
    const rendererKeys = renderer ? Object.keys(renderer) : [];
    const tracks = renderer?.captionTracks;
    const ytInitialData = globalWindow.ytInitialData;
    const ytInitialDataKeys = ytInitialData ? Object.keys(ytInitialData) : [];
    const ytInitialPlayerConfig = globalWindow.ytInitialPlayerConfig;
    const ytInitialPlayerConfigKeys = ytInitialPlayerConfig ? Object.keys(ytInitialPlayerConfig) : [];
    const diagnostics = {
        playerResponseExists: Boolean(playerResponse),
        playerResponseType: playerResponse ? typeof playerResponse : 'undefined',
        playerResponseKeys,
        captionsExists: Boolean(captions),
        captionsType: captions ? typeof captions : 'undefined',
        captionsKeys,
        rendererExists: Boolean(renderer),
        rendererKeys,
        captionTracksExists: Boolean(tracks),
        captionTracksIsArray: Array.isArray(tracks),
        captionTracksCount: Array.isArray(tracks) ? tracks.length : 0,
        ytInitialDataExists: Boolean(ytInitialData),
        ytInitialDataKeys,
        ytInitialPlayerConfigExists: Boolean(ytInitialPlayerConfig),
        ytInitialPlayerConfigKeys,
        alternativeCaptionMetadataPath: Boolean(globalWindow.ytInitialData || globalWindow.ytInitialPlayerConfig || globalWindow.ytInitialPlayerResponse)
    };
    if (!tracks || !Array.isArray(tracks)) {
        return {
            success: false,
            error: 'YouTube caption tracks are not available',
            diagnostics
        };
    }
    return {
        success: true,
        tracks: tracks.map(track => ({
            languageCode: track.languageCode,
            name: track.name,
            baseUrl: track.baseUrl
        })),
        diagnostics
    };
}
function isDiscoverTracksMessage(message) {
    if (typeof message !== 'object' || message === null || !('type' in message) || !('tabId' in message) || !('language' in message)) {
        return false;
    }
    const typed = message;
    if (typed.type !== 'DISCOVER_CAPTION_TRACKS') {
        return false;
    }
    if (!Number.isInteger(typed.tabId) || typeof typed.tabId !== 'number' || typed.tabId < 0) {
        return false;
    }
    return typeof typed.language === 'string' && typed.language.trim().length > 0;
}
function isFetchCaptionResourceMessage(message) {
    if (typeof message !== 'object' || message === null || !('type' in message) || !('tabId' in message) || !('captionUrl' in message)) {
        return false;
    }
    const typed = message;
    if (typed.type !== 'FETCH_CAPTION_RESOURCE_MAIN_WORLD') {
        return false;
    }
    if (!Number.isInteger(typed.tabId) || typeof typed.tabId !== 'number' || typed.tabId < 0) {
        return false;
    }
    return typeof typed.captionUrl === 'string' && typed.captionUrl.trim().length > 0;
}
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isFetchCaptionResourceMessage(message)) {
        return false;
    }
    const tabId = message.tabId;
    const captionUrl = message.captionUrl;
    const apiAvailable = Boolean(chrome.scripting && typeof chrome.scripting.executeScript === 'function');
    if (!apiAvailable) {
        sendResponse({
            success: false,
            error: 'chrome.scripting API is unavailable in this context'
        });
        return true;
    }
    (async () => {
        try {
            console.log('Lamiss POC: caption fetch executing in MAIN world = true');
            const results = await chrome.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                func: fetchCaptionResourceMainWorld,
                args: [captionUrl]
            });
            const result = results[0]?.result;
            if (!result) {
                sendResponse({
                    success: false,
                    error: 'Unable to fetch caption resource in MAIN world'
                });
                return;
            }
            console.log('Lamiss POC: MAIN caption HTTP request completed = true');
            console.log('Lamiss POC: MAIN caption HTTP status =', result.status);
            console.log('Lamiss POC: MAIN caption response ok =', result.ok ? 'true' : 'false');
            console.log('Lamiss POC: MAIN caption response content-type =', result.contentType);
            console.log('Lamiss POC: MAIN caption response text length =', result.text.length);
            sendResponse({
                success: true,
                ok: result.ok,
                status: result.status,
                contentType: result.contentType,
                text: result.text
            });
        }
        catch (error) {
            console.log('Lamiss POC: MAIN caption HTTP request completed = false');
            console.log('Lamiss POC: MAIN caption fetch error =', error instanceof Error ? error.message : String(error));
            sendResponse({
                success: false,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    })();
    return true;
});
chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
    if (!isDiscoverTracksMessage(message)) {
        console.log('Lamiss POC: malformed DISCOVER_CAPTION_TRACKS message received');
        return false;
    }
    const tabId = message.tabId;
    const requestedLanguage = message.language.trim().toLowerCase();
    const apiAvailable = Boolean(chrome.scripting && typeof chrome.scripting.executeScript === 'function');
    console.log('Lamiss POC: chrome.scripting available =', apiAvailable ? 'true' : 'false');
    if (!apiAvailable) {
        console.log('Lamiss POC: chrome.scripting API is unavailable');
        chrome.tabs.sendMessage(tabId, {
            type: 'CAPTION_DISCOVERY_RESULT',
            result: {
                success: false,
                error: 'chrome.scripting API is unavailable in this context'
            }
        });
        return false;
    }
    console.log('Lamiss POC: executing caption discovery in MAIN world');
    (async () => {
        try {
            const startedAt = Date.now();
            let lastResult;
            while (Date.now() - startedAt < 5000) {
                const results = await chrome.scripting.executeScript({
                    target: { tabId },
                    world: 'MAIN',
                    func: discoverCaptionTracksMainWorld
                });
                const result = results[0]?.result;
                if (result?.success) {
                    const trackList = Array.isArray(result.tracks) ? result.tracks : [];
                    const selected = trackList.find(track => track.languageCode?.toLowerCase() === requestedLanguage);
                    if (selected || trackList.length > 0) {
                        lastResult = result;
                        break;
                    }
                }
                if (result?.success === false && result.error === 'Requested caption language is not available') {
                    lastResult = result;
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 250));
            }
            console.log('Lamiss POC: MAIN world execution completed');
            chrome.tabs.sendMessage(tabId, {
                type: 'CAPTION_DISCOVERY_RESULT',
                result: lastResult ?? {
                    success: false,
                    error: 'YouTube caption tracks are not available'
                }
            });
        }
        catch (error) {
            console.log('Lamiss POC: caption tracks discovered = false');
            console.log('Lamiss POC: diagnostic error =', error instanceof Error ? error.message : String(error));
            chrome.tabs.sendMessage(tabId, {
                type: 'CAPTION_DISCOVERY_RESULT',
                result: {
                    success: false,
                    error: error instanceof Error ? error.message : String(error)
                }
            });
        }
    })();
    return true;
});
