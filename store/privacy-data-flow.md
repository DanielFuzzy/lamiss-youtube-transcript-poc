# LAMISS: what data the extension handles, and where it goes

Written from the code as of the release-pipeline branch (extension + `DanielFuzzy/Lamiss` backend).
It describes what the software does, not legal advice. **Review it with whoever is responsible for the
privacy policy before publishing**, and keep it up to date when a feature changes.

## Data inventory

| Data | Collected when | Sent to | Stored where, and for how long |
|---|---|---|---|
| **Google account identity**: Google subject ID, email, name, profile picture URL | Sign-in (`chrome.identity` + Google ID token) | LAMISS backend (verifies the token with Google) | Backend `users` table, no expiry. The extension keeps only the LAMISS session token, id, email and username in `chrome.storage.session` (cleared when the browser closes). |
| **LAMISS session token** | After sign-in | LAMISS backend, as `Authorization: Bearer` | Backend `auth_sessions` (expires); browser session storage. Never sent to anything else. |
| **Video identity**: YouTube video ID, title, duration | "Start using Lamiss" / Start Learning on a video | LAMISS backend | Backend `videos`, shared by all users, no expiry. |
| **Video captions (transcript)** | Same moment, read from YouTube in the page | LAMISS backend → **OpenAI** (uploaded as a file and vector store so the tutor can answer about the video) | Backend `transcripts`, `transcript_segments`, no expiry; an OpenAI file and vector store per video, kept until deleted at OpenAI. Public content, not personal data, but sent to a third party. |
| **Typed questions to the tutor** and the tutor's answers | Chat panel | LAMISS backend → **OpenAI** (answer generation) | Backend `session_events` (JSON), no expiry. |
| **Spoken questions and answers (microphone audio)** | Only while the user holds the mic or answers a question by voice | LAMISS backend → **OpenAI Whisper** (speech to text) | The audio is **not stored** by the backend (only a reference ID and the transcribed text). OpenAI processes it under its API data policy. |
| **Answers to Lamiss's questions** and the AI feedback | Answering in the question card | LAMISS backend → **OpenAI** (evaluation) | Backend `session_events`, `transcribe`, `question_responses`, no expiry. |
| **Text read aloud by Lamiss** (questions, answers, feedback) | Every spoken line | LAMISS backend → **Kokoro TTS** server (configured by the operator, e.g. on RunPod) or **OpenAI TTS** | Short-lived in-memory cache on the backend. |
| **Learning activity**: sessions, playback position, questions asked/answered, practice minutes, recent videos | While watching with Lamiss (position about every 30 s) | LAMISS backend | `learning_sessions`, `session_video_state`, `practice_time`, …; no expiry. |
| **Preferences**: languages, level, learning goal, daily goal, tutor settings, voice, speed, username | Popup settings | LAMISS backend | `user_preferences` and related tables. |
| **Device settings**: microphone/speaker IDs, volume, question frequency, app language | Popup / chat | **Nowhere**: `chrome.storage.local` only | In the browser profile. |

Not collected: browsing history beyond the YouTube watch page the user opens Lamiss on, page content of other
sites (the content script only runs on `www.youtube.com`), payment data, location, contacts.

## Third parties (processors)

- **Google**: sign-in (OAuth / OpenID Connect).
- **OpenAI**: transcripts (files + vector stores), question generation, answers, answer evaluation, speech to
  text (Whisper), and text-to-speech when OpenAI is the voice provider.
- **Kokoro TTS host**: the text Lamiss speaks. Wherever the operator runs it (a RunPod GPU pod in the current
  setup).
- **Backend hosting provider**: wherever the LAMISS backend and its MySQL database run (not decided yet).

## Gaps before a public listing (must be resolved, not worked around)

1. **There is no privacy policy page.** The Chrome Web Store requires a privacy policy URL for an extension that
   handles personal or sensitive user data (this one handles authentication info, personal communications
   and audio). A draft is in `store/privacy-policy-draft.md`; it needs an owner, legal review and a public URL.
2. **No way to delete an account or its data.** The backend has no delete endpoint. Users can only stop using it.
   Either add deletion (or a documented request process) or the policy must say how deletion requests are
   handled. Many jurisdictions (e.g. GDPR) require it.
3. **No retention limits.** Everything above is kept indefinitely, OpenAI files and vector stores included. Decide
   on retention, or disclose that there is none.
4. **No in-product notice before audio and conversations are sent to OpenAI.** The Chrome Web Store's User Data
   policy asks for prominent disclosure when data is used in a way users might not expect. A one-time notice
   at sign-in (what is sent, to whom) linking to the policy is recommended.
5. **Backend location and operator identity** (the "who we are" of the policy) are not decided yet.
