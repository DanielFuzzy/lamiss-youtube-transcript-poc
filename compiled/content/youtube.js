"use strict";
let pendingSendResponse = null;
let pendingRequestedLanguage = 'en';
let pendingVideoId;
let pendingTabId = -1;
function fetchCaptionResourceInMainWorld(tabId, captionUrl) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({
            type: 'FETCH_CAPTION_RESOURCE_MAIN_WORLD',
            tabId,
            captionUrl
        }, (response) => {
            if (chrome.runtime.lastError) {
                resolve({ success: false, error: chrome.runtime.lastError.message });
                return;
            }
            resolve(response);
        });
    });
}
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isLoadTranscriptMessage(message)) {
        return false;
    }
    (async () => {
        try {
            console.log('Lamiss POC: LOAD_TRANSCRIPT message received = true');
            if (!Number.isInteger(message.tabId)) {
                console.log('Lamiss POC: active tab ID received = false');
                sendResponse({ success: false, error: 'Active tab ID is unavailable' });
                return;
            }
            const tabId = message.tabId;
            console.log('Lamiss POC: active tab ID received = true');
            const parsed = parseYouTubeWatchUrl(window.location.href);
            if (!parsed.success) {
                console.log('Lamiss POC: videoId = unavailable');
                sendResponse({ success: false, error: parsed.error ?? 'Unable to parse YouTube page' });
                return;
            }
            pendingRequestedLanguage = (message.language ?? 'en').toLowerCase();
            pendingVideoId = parsed.videoId;
            pendingSendResponse = sendResponse;
            pendingTabId = message.tabId;
            console.log('Lamiss POC: videoId =', parsed.videoId);
            console.log('Lamiss POC: requested language =', pendingRequestedLanguage);
            console.log('Lamiss POC: page player response discovered = true');
            chrome.runtime.sendMessage({
                type: 'DISCOVER_CAPTION_TRACKS',
                tabId,
                language: pendingRequestedLanguage,
                videoId: parsed.videoId
            });
            console.log('Lamiss POC: caption request started');
        }
        catch (error) {
            console.error('Lamiss POC: content script error:', error);
            if (pendingSendResponse) {
                pendingSendResponse({ success: false, error: 'Unable to process YouTube page' });
            }
        }
    })();
    return true;
});
chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
    if (!isCaptionDiscoveryResultMessage(message)) {
        return false;
    }
    const result = message.result;
    if (!result?.success) {
        console.log('Lamiss POC: caption tracks discovered = false');
        console.log('Lamiss POC: diagnostic error =', result?.error ?? 'No captions available');
        if (pendingSendResponse) {
            pendingSendResponse({ success: false, error: result?.error ?? 'No captions available' });
        }
        return true;
    }
    const captionTracks = Array.isArray(result.tracks) ? result.tracks : [];
    console.log('Lamiss POC: caption tracks discovered = true');
    console.log('Lamiss POC: caption tracks count =', captionTracks.length);
    const { track: selectedTrack, matchType } = selectCaptionTrack(captionTracks, pendingRequestedLanguage);
    if (!selectedTrack) {
        const available = captionTracks.map(track => track.languageCode ?? 'unknown').join(', ');
        console.log('Lamiss POC: requested language =', pendingRequestedLanguage);
        console.log('Lamiss POC: matching track discovered = false');
        console.log('Lamiss POC: available languages =', available);
        if (pendingSendResponse) {
            pendingSendResponse({ success: false, error: 'No caption tracks are available for this video' });
        }
        return true;
    }
    console.log('Lamiss POC: matching track discovered = true');
    console.log('Lamiss POC: match type =', matchType);
    if (!selectedTrack.baseUrl) {
        console.log('Lamiss POC: caption baseUrl obtained = false');
        if (pendingSendResponse) {
            pendingSendResponse({ success: false, error: 'Caption track URL is missing' });
        }
        return true;
    }
    console.log('Lamiss POC: caption baseUrl obtained = true');
    console.log('Lamiss POC: caption baseUrl query params redacted = true');
    console.log('Lamiss POC: caption resource URL redacted =', redactCaptionUrl(selectedTrack.baseUrl));
    const captionUrl = new URL(selectedTrack.baseUrl);
    captionUrl.searchParams.set('fmt', 'json3');
    if (matchType === 'translated') {
        captionUrl.searchParams.set('tlang', pendingRequestedLanguage);
        console.log('Lamiss POC: tlang translation requested =', pendingRequestedLanguage);
    }
    console.log('Lamiss POC: fmt=json3 requested = true');
    console.log('Lamiss POC: caption request started');
    (async () => {
        try {
            console.log('Lamiss POC: caption fetch executing in MAIN world = true');
            const mainWorldResponse = await fetchCaptionResourceInMainWorld(pendingTabId, captionUrl.toString());
            if (!mainWorldResponse.success) {
                console.log('Lamiss POC: MAIN caption HTTP request completed = false');
                console.log('Lamiss POC: MAIN caption fetch error =', mainWorldResponse.error ?? 'Unable to fetch caption resource in MAIN world');
                if (pendingSendResponse) {
                    pendingSendResponse({ success: false, error: mainWorldResponse.error ?? 'Unable to fetch caption resource in MAIN world' });
                }
                return;
            }
            if (!mainWorldResponse.ok) {
                console.log('Lamiss POC: MAIN caption HTTP request completed = true');
                console.log('Lamiss POC: MAIN caption HTTP status =', mainWorldResponse.status);
                console.log('Lamiss POC: MAIN caption response ok = false');
                console.log('Lamiss POC: MAIN caption response content-type =', mainWorldResponse.contentType ?? 'unknown');
                if (pendingSendResponse) {
                    pendingSendResponse({ success: false, error: `Caption request failed with HTTP ${mainWorldResponse.status}` });
                }
                return;
            }
            console.log('Lamiss POC: MAIN caption HTTP request completed = true');
            console.log('Lamiss POC: MAIN caption HTTP status =', mainWorldResponse.status);
            console.log('Lamiss POC: MAIN caption response ok = true');
            console.log('Lamiss POC: MAIN caption response content-type =', mainWorldResponse.contentType ?? 'unknown');
            console.log('Lamiss POC: MAIN caption response text length =', mainWorldResponse.text?.length ?? 0);
            try {
                const data = JSON.parse(mainWorldResponse.text ?? '');
                console.log('Lamiss POC: MAIN caption JSON parse succeeded = true');
                console.log('Lamiss POC: MAIN caption events exists =', Array.isArray(data?.events) ? 'true' : 'false');
                console.log('Lamiss POC: MAIN caption events count =', Array.isArray(data?.events) ? data.events.length : 0);
                if (!isValidCaptionResponse(data)) {
                    console.log('Lamiss POC: MAIN caption events exists = false');
                    if (pendingSendResponse) {
                        pendingSendResponse({ success: false, error: 'Caption response is malformed' });
                    }
                    return;
                }
                const events = data.events;
                const eventsWithSegments = events.filter(event => Array.isArray(event.segs) && event.segs.length > 0);
                const segmentsWithText = eventsWithSegments
                    .flatMap(event => event.segs ?? [])
                    .filter((seg) => typeof seg.utf8 === 'string' && seg.utf8.trim().length > 0);
                console.log('Lamiss POC: events containing segments =', eventsWithSegments.length);
                console.log('Lamiss POC: segments containing text =', segmentsWithText.length);
                if (pendingSendResponse) {
                    pendingSendResponse({
                        success: true,
                        videoId: pendingVideoId,
                        language: pendingRequestedLanguage,
                        translated: matchType === 'translated',
                        rawCaptionResponse: data
                    });
                }
            }
            catch (jsonError) {
                console.log('Lamiss POC: MAIN caption JSON parse succeeded = false');
                console.log('Lamiss POC: MAIN caption JSON parse error =', jsonError instanceof Error ? jsonError.message : String(jsonError));
                if (pendingSendResponse) {
                    pendingSendResponse({ success: false, error: 'Unable to parse caption resource JSON' });
                }
            }
        }
        catch (error) {
            console.log('Lamiss POC: caption HTTP request completed = false');
            console.log('Lamiss POC: caption HTTP fetch error =', error instanceof Error ? error.message : String(error));
            if (pendingSendResponse) {
                pendingSendResponse({ success: false, error: 'Unable to fetch caption resource' });
            }
        }
    })();
    return true;
});
function isCaptionDiscoveryResultMessage(message) {
    return typeof message === 'object'
        && message !== null
        && 'type' in message
        && message.type === 'CAPTION_DISCOVERY_RESULT';
}
function isLoadTranscriptMessage(message) {
    return typeof message === 'object'
        && message !== null
        && 'type' in message
        && message.type === 'LOAD_TRANSCRIPT';
}
function parseYouTubeWatchUrl(url) {
    if (!url) {
        return { success: false, error: 'Active tab has no URL' };
    }
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return { success: false, error: 'Active tab has an invalid URL' };
    }
    if (parsed.hostname !== 'www.youtube.com' && parsed.hostname !== 'youtube.com') {
        return { success: false, error: 'Active tab is not YouTube' };
    }
    if (parsed.pathname !== '/watch') {
        return { success: false, error: 'YouTube page is not a watch page' };
    }
    const videoId = parsed.searchParams.get('v');
    if (!videoId || videoId.trim().length === 0) {
        return { success: false, error: 'YouTube watch page has no video ID' };
    }
    return { success: true, videoId };
}
function primaryLanguageSubtag(languageCode) {
    return languageCode.split('-')[0].toLowerCase();
}
function selectCaptionTrack(tracks, requestedLanguage) {
    if (tracks.length === 0) {
        return { track: undefined, matchType: 'none' };
    }
    const exact = tracks.find(track => track.languageCode?.toLowerCase() === requestedLanguage);
    if (exact) {
        return { track: exact, matchType: 'exact' };
    }
    // YouTube commonly exposes region-tagged codes (es-419, en-US, ...) that
    // don't equal a plain "es"/"en" request exactly. Match on the primary
    // subtag before giving up.
    const requestedPrimary = primaryLanguageSubtag(requestedLanguage);
    const prefixMatch = tracks.find(track => track.languageCode && primaryLanguageSubtag(track.languageCode) === requestedPrimary);
    if (prefixMatch) {
        return { track: prefixMatch, matchType: 'prefix' };
    }
    // No track exists in the requested language at all (common for videos
    // with only a source-language auto-generated track). YouTube can still
    // serve a machine-translated version of any existing track via `tlang`,
    // so fall back to one instead of failing outright. Prefer a manually
    // authored track over an ASR one as the translation source when both exist.
    const translationSource = tracks.find(track => track.kind !== 'asr') ?? tracks[0];
    return { track: translationSource, matchType: 'translated' };
}
function isValidCaptionResponse(response) {
    return !!response
        && typeof response === 'object'
        && 'events' in response
        && Array.isArray(response.events);
}
function redactCaptionUrl(url) {
    try {
        const parsed = new URL(url);
        const redacted = new URL(parsed.toString());
        redacted.search = '';
        return `${redacted.origin}${redacted.pathname} [query params redacted]`;
    }
    catch {
        return '[redacted caption URL]';
    }
}
