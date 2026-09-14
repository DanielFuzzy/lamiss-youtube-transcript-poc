"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractYouTubeVideoId = exports.parseYouTubeUrl = void 0;
function parseYouTubeUrl(url) {
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
exports.parseYouTubeUrl = parseYouTubeUrl;
function extractYouTubeVideoId(url) {
    const result = parseYouTubeUrl(url);
    return result.success && result.videoId ? result.videoId : null;
}
exports.extractYouTubeVideoId = extractYouTubeVideoId;
