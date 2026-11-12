// Audio worklet of the offscreen page (Lamiss#85): sends the microphone's
// samples, 1280 at a time (80 ms at 16 kHz), to the "Hey Lamiss" detector.
// A plain script: audio worklets load it as a module of their own.
class LamissWakeCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(1280);
    this.filled = 0;
  }

  process(inputs) {
    const samples = inputs[0] && inputs[0][0];
    if (samples) {
      for (let i = 0; i < samples.length; i += 1) {
        this.buffer[this.filled] = samples[i];
        this.filled += 1;
        if (this.filled === this.buffer.length) {
          this.port.postMessage(this.buffer.slice());
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('lamiss-wake-capture', LamissWakeCapture);
