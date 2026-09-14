# Lamiss YouTube Transcript POC — Phase 1 Explanation

This repository currently contains the first implementation phase of a Chrome Extension proof of concept for Lamiss.

## Purpose

The goal of this POC is to test whether a Chrome Extension can read YouTube caption data already loaded by the browser, transform that caption structure into a Lamiss transcript model, and later send that transcript to a Lamiss backend API.

This repository intentionally stays browser-side only. It does not implement any Lamiss backend.

## Current Phase

This is Phase 1 only:

- Create the minimal Manifest V3 Chrome Extension.
- Use TypeScript.
- Provide a minimal popup page.
- Provide a minimal content script.

The implementation stops here and does not continue into caption access or transcript mapping.

## Files Created

### manifest.json

The Chrome Extension manifest file.

It declares:

- manifest version 3
- extension name and version
- minimal permissions: `activeTab` and `scripting`
- host permission for YouTube watch pages
- the popup page
- a content script that runs on `https://www.youtube.com/watch*`

### package.json

Defines the package metadata and a minimal build command:

```sh
npm run build
```

The project uses:

- TypeScript
- Chrome type definitions via `@types/chrome`

### tsconfig.json

Defines the TypeScript compiler settings used to compile the extension source into JavaScript.

### src/popup/popup.html

The popup UI markup.

It includes:

- a page heading, `LAMISS`
- a language selector with English and Spanish options
- a `Load Transcript` button
- a status region showing the popup’s human-readable message

### src/popup/popup.ts

Responsible for popup interaction.

It:

- reads the selected language
- queries the active Chrome tab
- verifies that the active page is a YouTube watch page
- sends a message to the content script using `chrome.tabs.sendMessage`
- handles success or failure responses from the content script
- updates the popup status text

### src/content/youtube.ts

Responsible for the YouTube content-script side of the POC.

It:

- listens for messages from the popup
- verifies the message is a `LOAD_TRANSCRIPT` message
- checks the current browser URL
- extracts the YouTube video ID from `watch?v=` URLs
- logs the detected `videoId` and the requested `language`
- sends a structured response back to the popup

## How It Works

The user opens the extension popup, selects a language, and presses the button.

Then:

1. The popup asks Chrome which tab is active.
2. The popup checks the active tab URL to decide if it is a YouTube watch page.
3. The popup sends a `LOAD_TRANSCRIPT` message to the content script.
4. The content script receives the message and validates the current page.
5. The content script extracts the video ID and returns a simple success/failure response.

This is only the beginning of the expected architecture. It does not yet retrieve captions, parse them, map them, or send them to a backend.

## Build

To build:

```sh
npm install
npm run build
```

## Loading the Extension

In Chrome:

1. Open `chrome://extensions`.
2. Turn on Developer Mode.
3. Click `Load unpacked`.
4. Select this repository folder.

## Testing

Open the test video:

https://www.youtube.com/watch?v=LeRylkDym54

Then:

1. Open the Lamiss extension popup.
2. Select a language.
3. Click `Load Transcript`.
4. Check the popup status box.
5. Check the page console for the content script’s diagnostic log lines.

Expected output in the page console:

- `Lamiss POC: YouTube content script loaded.`
- `Lamiss POC: videoId=LeRylkDym54`
- `Lamiss POC: language=<selected language>`

## Expected Result

The extension should be loadable from Chrome and should successfully show the popup UI on a YouTube watch page. The content script should be able to validate the page and extract the video ID from the URL.

## Important Limitations

This Phase 1 implementation is intentionally limited:

- No real captions are fetched.
- No YouTube caption parser is implemented.
- No Lamiss transcript model is implemented.
- No Lamiss backend API abstraction is implemented.
- No automatic transcript loading or synchronization is implemented.

## Next Requested Instruction

The exact next instruction to continue the project is:

Continue with Phase 2: active tab + video ID.

This is the point where the extension should prove it can correctly identify the active YouTube tab and reliably read the `v=` query parameter from the video URL.
