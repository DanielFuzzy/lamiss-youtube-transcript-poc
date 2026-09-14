export type YouTubeUrlParseResult = {
  success: boolean;
  videoId?: string;
  error?: string;
};

export function parseYouTubeUrl(url: string): YouTubeUrlParseResult {
  if (!url) {
    return { success: false, error: 'Active tab has no URL' };
  }

  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
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

export function extractYouTubeVideoId(url: string): string | null {
  const result = parseYouTubeUrl(url);
  return result.success && result.videoId ? result.videoId : null;
}
