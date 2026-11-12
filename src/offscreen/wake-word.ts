// "Hey Lamiss" detection on the device (Lamiss#85): openWakeWord's inference
// ported from its Python (openwakeword/utils.py and model.py, Apache-2.0) to
// onnxruntime-web. Audio never leaves the computer.
//
// Three ONNX models, fed 16 kHz audio as int16-valued floats:
// 1. melspectrogram.onnx: each 80 ms chunk (1280 samples, plus 480 samples of
//    context) gives 8 frames of 32 mel bins, transformed as x / 10 + 2;
// 2. embedding_model.onnx: the last 76 mel frames give one 96-value embedding
//    per chunk;
// 3. the wake word model: the last 16 embeddings give a score from 0 to 1.
// Like openWakeWord, the embeddings start from 4 s of random noise and the
// first 5 scores are 0 while the model warms up.

const WAKE_SAMPLE_RATE = 16_000;
const WAKE_CHUNK_SAMPLES = 1280;
const WAKE_MEL_CONTEXT_SAMPLES = 160 * 3;
const WAKE_MEL_BINS = 32;
const WAKE_MEL_MAX_FRAMES = 970;
const WAKE_EMBEDDING_WINDOW = 76;
const WAKE_EMBEDDING_STEP = 8;
const WAKE_EMBEDDING_DIM = 96;
const WAKE_MAX_EMBEDDINGS = 120;
const WAKE_INPUT_EMBEDDINGS = 16;
const WAKE_WARMUP_SCORES = 5;
const WAKE_NOISE_SECONDS = 4;

type WakeTensor = { data: ArrayLike<number> };
type WakeSession = {
  readonly inputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, WakeTensor>>;
};
// The parts of onnxruntime-web used here (the global `ort` in the offscreen page).
type WakeOrt = {
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown;
  InferenceSession: { create(model: Uint8Array): Promise<WakeSession> };
};
type WakeModels = { melspectrogram: Uint8Array; embedding: Uint8Array; wakeWord: Uint8Array };

class WakeWordPipeline {
  private context = new Float32Array(0);
  private remainder = new Float32Array(0);
  private mel: Float32Array[] = Array.from({ length: WAKE_EMBEDDING_WINDOW }, () => new Float32Array(WAKE_MEL_BINS).fill(1));
  private embeddings: Float32Array[] = [];
  private scores = 0;

  private constructor(
    private readonly ort: WakeOrt,
    private readonly melSession: WakeSession,
    private readonly embeddingSession: WakeSession,
    private readonly wakeSession: WakeSession
  ) {}

  static async create(ort: WakeOrt, models: WakeModels, random: () => number = Math.random): Promise<WakeWordPipeline> {
    const [mel, embedding, wake] = await Promise.all([
      ort.InferenceSession.create(models.melspectrogram),
      ort.InferenceSession.create(models.embedding),
      ort.InferenceSession.create(models.wakeWord)
    ]);
    const pipeline = new WakeWordPipeline(ort, mel, embedding, wake);
    await pipeline.warmUp(random);
    return pipeline;
  }

  // Scores the audio (16 kHz, int16-valued floats); undefined until a whole
  // 80 ms chunk is in, otherwise the highest score of the chunks completed.
  async process(samples: Float32Array): Promise<number | undefined> {
    const audio = new Float32Array(this.remainder.length + samples.length);
    audio.set(this.remainder);
    audio.set(samples, this.remainder.length);
    let best: number | undefined;
    let offset = 0;
    for (; offset + WAKE_CHUNK_SAMPLES <= audio.length; offset += WAKE_CHUNK_SAMPLES) {
      const score = await this.processChunk(audio.subarray(offset, offset + WAKE_CHUNK_SAMPLES));
      best = best === undefined ? score : Math.max(best, score);
    }
    this.remainder = audio.slice(offset);
    return best;
  }

  private async processChunk(chunk: Float32Array): Promise<number> {
    const input = new Float32Array(this.context.length + chunk.length);
    input.set(this.context);
    input.set(chunk, this.context.length);
    this.context = input.slice(Math.max(0, input.length - WAKE_MEL_CONTEXT_SAMPLES));

    this.mel.push(...(await this.melspectrogram(input)));
    this.mel.splice(0, Math.max(0, this.mel.length - WAKE_MEL_MAX_FRAMES));
    this.embeddings.push(await this.embed(this.mel.slice(-WAKE_EMBEDDING_WINDOW)));
    this.embeddings.splice(0, Math.max(0, this.embeddings.length - WAKE_MAX_EMBEDDINGS));

    const recent = this.embeddings.slice(-WAKE_INPUT_EMBEDDINGS);
    const features = new Float32Array(recent.length * WAKE_EMBEDDING_DIM);
    recent.forEach((embedding, i) => features.set(embedding, i * WAKE_EMBEDDING_DIM));
    const output = await this.wakeSession.run({
      [this.wakeSession.inputNames[0]]: new this.ort.Tensor('float32', features, [1, recent.length, WAKE_EMBEDDING_DIM])
    });
    const score = Number(Object.values(output)[0].data[0]);
    this.scores += 1;
    return this.scores <= WAKE_WARMUP_SCORES ? 0 : score;
  }

  private async melspectrogram(samples: Float32Array): Promise<Float32Array[]> {
    const output = await this.melSession.run({ input: new this.ort.Tensor('float32', samples, [1, samples.length]) });
    const data = Object.values(output)[0].data;
    const frames: Float32Array[] = [];
    for (let start = 0; start + WAKE_MEL_BINS <= data.length; start += WAKE_MEL_BINS) {
      const frame = new Float32Array(WAKE_MEL_BINS);
      for (let bin = 0; bin < WAKE_MEL_BINS; bin += 1) {
        frame[bin] = Number(data[start + bin]) / 10 + 2;
      }
      frames.push(frame);
    }
    return frames;
  }

  private async embed(window: Float32Array[]): Promise<Float32Array> {
    const input = new Float32Array(WAKE_EMBEDDING_WINDOW * WAKE_MEL_BINS);
    window.forEach((frame, i) => input.set(frame, i * WAKE_MEL_BINS));
    const output = await this.embeddingSession.run({
      input_1: new this.ort.Tensor('float32', input, [1, WAKE_EMBEDDING_WINDOW, WAKE_MEL_BINS, 1])
    });
    return Float32Array.from(Object.values(output)[0].data, Number);
  }

  // The embeddings of 4 s of random noise in [-1000, 1000), as openWakeWord starts.
  private async warmUp(random: () => number): Promise<void> {
    const noise = new Float32Array(WAKE_SAMPLE_RATE * WAKE_NOISE_SECONDS);
    for (let i = 0; i < noise.length; i += 1) {
      noise[i] = Math.floor(random() * 2000) - 1000;
    }
    const frames = await this.melspectrogram(noise);
    for (let start = 0; start + WAKE_EMBEDDING_WINDOW <= frames.length; start += WAKE_EMBEDDING_STEP) {
      this.embeddings.push(await this.embed(frames.slice(start, start + WAKE_EMBEDDING_WINDOW)));
    }
  }
}
