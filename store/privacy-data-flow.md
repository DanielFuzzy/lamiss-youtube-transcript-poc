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
| **Text read aloud by Lamiss** (questions, answers, feedback) | Every spoken line | LAMISS backend → **OpenAI TTS** (production uses `LAMISS_SPEECH_PROVIDER=openai`) | Short-lived in-memory cache on the backend. |
| **Learning activity**: sessions, playback position, questions asked/answered, practice minutes, recent videos | While watching with Lamiss (position about every 30 s) | LAMISS backend | `learning_sessions`, `session_video_state`, `practice_time`, …; no expiry. |
| **Preferences**: languages, level, learning goal, daily goal, tutor settings, voice, speed, username | Popup settings | LAMISS backend | `user_preferences` and related tables. |
| **Device settings**: microphone/speaker IDs, volume, question frequency, app language | Popup / chat | **Nowhere**: `chrome.storage.local` only | In the browser profile. |

Not collected: browsing history beyond the YouTube watch page the user opens Lamiss on, page content of other
sites (the content script only runs on `www.youtube.com`), payment data, location, contacts.

## Third parties (processors)

- **Google**: sign-in (OAuth / OpenID Connect).
- **OpenAI**: transcripts (files + vector stores), question generation, answers, answer evaluation, speech to
  text (Whisper), and text-to-speech (Lamiss's voice; production uses OpenAI as the voice provider).
- **Railway** (Railway Corporation, United States): hosts the LAMISS backend and its MySQL database
  (`https://lamiss-production.up.railway.app`).

If the voice provider changes (for example back to a Kokoro server on RunPod, `LAMISS_SPEECH_PROVIDER=kokoro`), the
privacy policy must name that host before the change reaches users.

## Privacy requirements: status

1. **Privacy policy:** `site/privacy-policy.html`, published by the Pages workflow at
   https://danielfuzzy.github.io/lamiss-youtube-transcript-poc/privacy-policy.html (live once it is on `main`).
   It is not legal advice; have it reviewed if LAMISS grows beyond a personal project.
2. **Deletion:** **Profile & Account → Delete my account** calls `DELETE /api/me`. It permanently deletes the
   account, settings, sessions, conversations, answers and progress (backend TDR-0005). Requests can also go by
   e-mail.
3. **Retention:** until the user deletes the account. OpenAI responses are requested with `store=false`. Whisper
   and OpenAI's abuse-monitoring retention (up to 30 days) follow OpenAI's policy, which the privacy policy links.
4. **In-product notice:** sign-in in the popup and the chat shows what is sent where, with the policy link, on an
   "Agree and sign in with Google" button. The worker refuses any sign-in, including silent re-sign-in, until
   that notice is accepted on an extension page; the YouTube page can't accept it. Bumping
   `LAMISS_PRIVACY_NOTICE_VERSION` asks everyone again.
5. **Providers named:** the policy names Railway (hosting of the server and database) and OpenAI (AI and
   voice), as of November 15, 2026 (Lamiss#109). The in-product notice ("its server and OpenAI") is still
   accurate, so `LAMISS_PRIVACY_NOTICE_VERSION` stays the same.
