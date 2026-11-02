# Chrome Web Store listing: LAMISS

Copy for the Developer Dashboard (Store listing, Privacy and Distribution tabs). Fields marked **TODO** need a
decision or an account; nothing here has been submitted yet.

## Store listing

- **Name:** LAMISS (the manifest's `name`).
- **Summary (≤132 characters, the manifest `description`):**
  Practice a language while you watch YouTube: Lamiss asks you questions about the video and answers yours, by voice or text.
- **Category:** Education. (The dashboard has no language-learning subcategory.)
- **Language:** English (listing). The extension itself is available in English, Spanish, French, German and
  Portuguese, so localized listings can follow.
- **Detailed description:**

  > LAMISS is an AI language tutor that learns the YouTube video you are watching and practices with you while you watch.
  >
  > • Questions about the video: at the moments you choose, Lamiss pauses (or lowers the volume), asks a short comprehension question out loud, listens to your spoken or typed answer, and gives you feedback.
  > • Ask anything: open the chat next to the video and ask about what was just said, by voice or text.
  > • Your tutor, your way: choose the tutor's language (it can differ from the video's), how kind or strict it is, how long its answers are, how often and how hard it asks, its voice and speed.
  > • The app in your language: English, Español, Français, Deutsch or Português.
  > • Keep going: recent videos with where you stopped and how many questions you answered, plus an optional daily goal.
  >
  > LAMISS works on YouTube videos that have captions. It needs a Google account to sign in. Your questions, spoken answers and the video's captions are processed by LAMISS's server and by OpenAI to generate questions, answers, feedback and speech; see the privacy policy for details.

- **Icon:** `src/icons/icon-128.png` (128×128, the logo on a white rounded square with transparent padding).
- **Screenshots (1280×800):** `store/assets/screenshot-*.jpg`, made by `node scripts/store-assets.js`. Replace or
  add a real screenshot of the question card on a YouTube video before going public: the generated ones only show the popup.
- **Small promo tile (440×280):** `store/assets/promo-small-440x280.jpg`.
- **Marquee (1400×560):** optional, not made.
- **Official URL / homepage:** https://danielfuzzy.github.io/lamiss-youtube-transcript-poc/
- **Support URL:** https://danielfuzzy.github.io/lamiss-youtube-transcript-poc/ (`site/index.html`: help and
  contact).

## Privacy tab

- **Single purpose:** "Help users practice a foreign language with the YouTube videos they watch, through an AI
  tutor that asks and answers questions about the video."
- **Permission justifications** (what to paste for each):

  | Permission | Justification |
  |---|---|
  | `identity` | Sign in with Google through `chrome.identity.launchWebAuthFlow`, so the user's settings and progress are kept with their account. |
  | `storage` | Keeps the sign-in session (session storage) and on-device settings: microphone and speaker choice, volume, question frequency and the app language. |
  | `scripting` | Reads the YouTube player's caption track list and current playback position on the YouTube tab the user starts Lamiss on. |
  | `webRequest` | Observes (does not block or modify) YouTube's own caption requests on youtube.com, to fetch the same captions Lamiss needs for the video. |
  | `offscreen` | Records the user's spoken answers and plays Lamiss's voice from an offscreen document, which Manifest V3 requires for audio. |
  | Host `https://www.youtube.com/*` | The in-page Lamiss button, question card and chat run on YouTube watch pages. |
  | Host `<backend>/*` | The LAMISS server the extension talks to (its sign-in, tutor, speech and progress API). |

- **Remote code:** No. All code is in the package; the server only returns data (JSON, audio).
- **Data usage (check these boxes, per `store/privacy-data-flow.md`):**
  - Personally identifiable information: **yes** (name, email address).
  - Authentication information: **yes** (Google sign-in, session token).
  - Personal communications: **yes** (questions to the tutor and answers, typed or spoken).
  - Website content: **yes** (captions and title of the YouTube video in use).
  - User activity: **yes** (playback position on videos used with Lamiss, questions answered, practice time).
  - Health, financial and payment info, location, web history: **no**.
- **Certifications** (tick only if true when submitting; they currently are, but re-check):
  data is not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not
  used or transferred to determine creditworthiness or for lending.
- **Privacy policy URL:** https://danielfuzzy.github.io/lamiss-youtube-transcript-poc/privacy-policy.html
  (`site/privacy-policy.html`, published by `.github/workflows/pages.yml` once it is on `main`).

## Distribution tab

- **Visibility for the first release: Unlisted.** Only people with the link can install it; good for a beta.
  Switch to **Public** once the beta is done (same item, no new upload needed).
- **Regions:** all, unless the privacy review restricts them.
- **Pricing:** free.
