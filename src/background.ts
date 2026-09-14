type DiscoverTracksMessage = {
  type: 'DISCOVER_CAPTION_TRACKS';
  tabId: number;
  language: string;
};

type FetchCaptionResourceMessage = {
  type: 'FETCH_CAPTION_RESOURCE_MAIN_WORLD';
  tabId: number;
  captionUrl: string;
};

type FetchCaptionResourceMainWorldResult = {
  ok: boolean;
  status: number;
  contentType: string;
  text: string;
};

async function fetchCaptionResourceMainWorld(captionUrl: string): Promise<FetchCaptionResourceMainWorldResult> {
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

function discoverCaptionTracksMainWorld(): {
  success: boolean;
  error?: string;
  diagnostics?: unknown;
  tracks?: Array<{ languageCode?: string; name?: { simpleText?: string; runs?: Array<{ text?: string }> }; baseUrl?: string }>;
} {
  const globalWindow = window as typeof window & {
    ytInitialPlayerResponse?: {
      captions?: {
        playerCaptionsTracklistRenderer?: {
          captionTracks?: CaptionTrack[];
        };
      };
    };
    ytInitialData?: unknown;
    ytInitialPlayerConfig?: unknown;
  };

  const playerResponse = globalWindow.ytInitialPlayerResponse;
  const playerResponseKeys = playerResponse ? Object.keys(playerResponse) : [];
  const captions = playerResponse?.captions;
  const captionsKeys = captions ? Object.keys(captions) : [];
  const renderer = captions?.playerCaptionsTracklistRenderer;
  const rendererKeys = renderer ? Object.keys(renderer) : [];
  const tracks = renderer?.captionTracks;
  const ytInitialData = globalWindow.ytInitialData;
  const ytInitialDataKeys = ytInitialData ? Object.keys(ytInitialData as Record<string, unknown>) : [];
  const ytInitialPlayerConfig = globalWindow.ytInitialPlayerConfig;
  const ytInitialPlayerConfigKeys = ytInitialPlayerConfig ? Object.keys(ytInitialPlayerConfig as Record<string, unknown>) : [];

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

function isDiscoverTracksMessage(message: unknown): message is DiscoverTracksMessage {
  if (typeof message !== 'object' || message === null || !('type' in message) || !('tabId' in message) || !('language' in message)) {
    return false;
  }

  const typed = message as { type?: string; tabId?: unknown; language?: unknown };
  if (typed.type !== 'DISCOVER_CAPTION_TRACKS') {
    return false;
  }

  if (!Number.isInteger(typed.tabId) || typeof typed.tabId !== 'number' || typed.tabId < 0) {
    return false;
  }

  return typeof typed.language === 'string' && typed.language.trim().length > 0;
}

function isFetchCaptionResourceMessage(message: unknown): message is FetchCaptionResourceMessage {
  if (typeof message !== 'object' || message === null || !('type' in message) || !('tabId' in message) || !('captionUrl' in message)) {
    return false;
  }

  const typed = message as { type?: string; tabId?: unknown; captionUrl?: unknown };
  if (typed.type !== 'FETCH_CAPTION_RESOURCE_MAIN_WORLD') {
    return false;
  }

  if (!Number.isInteger(typed.tabId) || typeof typed.tabId !== 'number' || typed.tabId < 0) {
    return false;
  }

  return typeof typed.captionUrl === 'string' && typed.captionUrl.trim().length > 0;
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
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
        world: 'MAIN' as chrome.scripting.ExecutionWorld,
        func: fetchCaptionResourceMainWorld,
        args: [captionUrl]
      });

      const result = results[0]?.result as FetchCaptionResourceMainWorldResult | undefined;
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
    } catch (error) {
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

chrome.runtime.onMessage.addListener((message: unknown, _sender, _sendResponse) => {
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
      let lastResult: { success?: boolean; error?: string; tracks?: Array<{ languageCode?: string; name?: { simpleText?: string; runs?: Array<{ text?: string }> }; baseUrl?: string }>; diagnostics?: unknown } | undefined;

      while (Date.now() - startedAt < 5000) {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN' as chrome.scripting.ExecutionWorld,
          func: discoverCaptionTracksMainWorld
        });

        const result = results[0]?.result as { success?: boolean; error?: string; tracks?: Array<{ languageCode?: string; name?: { simpleText?: string; runs?: Array<{ text?: string }> }; baseUrl?: string }>; diagnostics?: unknown } | undefined;
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
    } catch (error) {
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
