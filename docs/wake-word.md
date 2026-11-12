# "Hey Lamiss" wake word (Lamiss#85)

The wake word is detected on the learner's computer with
[openWakeWord](https://github.com/dscripka/openWakeWord) models, run by
`onnxruntime-web` in the offscreen page (`src/offscreen/wake-word.ts` ports
openWakeWord's Python inference). No audio leaves the computer until the
Ask Lamiss card opens.

## Status

| Phase | What | State |
|---|---|---|
| A | Integration: switch, always-on microphone while a session runs, ported pipeline, cooldown, indicator, opening the card | Done, with a development model |
| B | Train the "Hey Lamiss" model (below) | To do |
| C | Licenses, then release | To do |

## Files (never committed)

`npm run fetch:wakeword` downloads into the git-ignored `vendor/openwakeword/`,
checking SHA-256 sums:

- `melspectrogram.onnx`, `embedding_model.onnx`: openWakeWord's shared feature
  models (release v0.5.1). **Their license isn't stated.**
- `dev/hey_jarvis_v0.1.onnx`: a pre-trained "hey jarvis", **CC BY-NC-SA 4.0
  (non-commercial)**. Development builds use it while there is no
  `hey_lamiss.onnx`; staging and production builds never include it, and the
  package check refuses it.

The build copies the wake word files (and onnxruntime-web's 14 MB WebAssembly)
only when a model is available; without one, the popup hides the switch.

## Phase B: training "Hey Lamiss" in Google Colab

openWakeWord's training only runs on Linux (its Piper voice generator), so it
runs in Colab rather than on a Mac. About an hour on a free GPU.

1. Open openWakeWord's Colab notebook, linked from its README ("Training New
   Models"): https://colab.research.google.com/drive/1q1oe2zOyZp7UsB3jJiQ1IFn8z5YfjwEb
   (or `notebooks/automatic_model_training.ipynb` in the repository).
2. Set the phrase, with spellings that help the synthetic voices say "Lamiss"
   the way learners will:
   `target_phrase = ["hey lamiss", "hey la miss"]`, model name `hey_lamiss`.
3. Use at least several thousand examples (the README recommends "a minimum
   of several thousand"): e.g. `n_samples = 5000`, `n_samples_val = 1000`.
4. Run the notebook to the end and download `hey_lamiss.onnx`.
5. Put it at `vendor/openwakeword/hey_lamiss.onnx`, then `npm run build`: the
   build log says `wake word "Hey Lamiss"`, and release builds now include it.
6. Check it before release:
   - spoken "Hey Lamiss" by several people, accents and distances: detected;
   - an hour of videos with nobody speaking to Lamiss: under 1 false wake-up
     (each detection is logged in the offscreen page's console with its score);
   - adjust `threshold` in `scripts/build.js` (default 0.5) if needed.

## Phase C: before release

- **Licenses.** openWakeWord's code is Apache-2.0. Its pre-trained models are
  non-commercial "due to the inclusion of datasets with unknown or restrictive
  licensing"; a custom model is trained on the same kinds of data (AudioSet,
  ACAV100M features, FMA), and openWakeWord doesn't say what license it gets.
  The two feature models have no stated license. Settle both before a Chrome
  Web Store release that includes them.
- **Store listing.** Mention that the microphone stays open while the switch
  is on and Lamiss runs, and that detection happens on the device.
