/* Fix 1.9: RNNoise real-time speech probability from the SAME inference
 * already used to denoise audio. One WASM model and one AudioWorklet node;
 * emits a lightweight VAD score roughly every 40 ms (not PCM samples).
 * RNNoise implementation: @shiguredo/rnnoise-wasm, Apache-2.0.
 */
import { Rnnoise } from '@shiguredo/rnnoise-wasm';

const FRAME_SIZE = 480; // 10 ms at 48 kHz
const QUANTUM = 128;
const RING_SIZE = 1920;
const DELAY = 640; // must match dry-path delay in rnnoise-filter.js

class SaringRnnoiseVadProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.closed = false;
    this.ready = false;
    this.module = null;
    this.state = null;
    this.ring = new Float32Array(RING_SIZE);
    this.input = 0;
    this.pos = RING_SIZE - FRAME_SIZE * 2;
    this.vadSum = 0;
    this.vadFrames = 0;
    this.port.onmessage = ({data}) => {
      if (data?.type === 'destroy') {
        this.closed = true;
        this.ready = false;
        this.dispose();
        this.module = null;
      } else if (data?.type === 'reset') {
        this.ring.fill(0);
        this.input = 0;
        this.pos = RING_SIZE - FRAME_SIZE * 2;
        this.vadSum = 0;
        this.vadFrames = 0;
        if (this.module) {
          this.dispose();
          try { this.state = this.module.createDenoiseState(); }
          catch (error) { this.fail(error); }
        }
      }
    };
    const binary = options?.processorOptions?.wasmBinary;
    if (sampleRate !== 48000 || !(binary instanceof ArrayBuffer)) {
      this.fail(Error('RNNoise VAD membutuhkan WASM valid dan 48 kHz.'));
      return;
    }
    // The published upstream package requires the loadBinary compatibility
    // patch, applied by scripts/install-rnnoise.sh at build time.
    Promise.resolve().then(() => Rnnoise.loadBinary(binary)).then(module => {
      if (this.closed) return;
      if (module.frameSize !== FRAME_SIZE) throw Error('RNNoise frame size bukan 480.');
      this.module = module;
      this.state = module.createDenoiseState();
      this.ready = true;
      this.port.postMessage({type:'ready'});
    }).catch(error => this.fail(error));
  }
  fail(error) {
    if (this.closed) return;
    this.ready = false;
    this.port.postMessage({type:'error',message:error?.message || String(error)});
  }
  dispose() {
    if (this.state) {
      try {this.state.destroy();} catch (_) {}
      this.state = null;
    }
  }
  process(inputs, outputs) {
    if (this.closed) return false;
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    if (!this.ready || !this.state) {
      output.fill(0);
      return true;
    }
    // Web Audio normally delivers exactly 128 samples. Keep the same
    // buffering/latency contract as the upstream mono RNNoise worklet.
    if (output.length !== QUANTUM) {
      output.fill(0);
      this.fail(Error('RNNoise quantum harus 128 sampel.'));
      return true;
    }
    if (input) this.ring.set(input, this.input);
    else this.ring.fill(0, this.input, this.input + QUANTUM);
    this.input = (this.input + QUANTUM) % RING_SIZE;
    if (this.input === 128 || this.input === 512 || this.input === 1024 || this.input === 1536) {
      this.pos = (this.pos + FRAME_SIZE) % RING_SIZE;
      const frame = this.ring.subarray(this.pos, this.pos + FRAME_SIZE);
      try {
        // RNNoise API expects 16-bit PCM magnitude in Float32Array.
        for (let i=0; i<FRAME_SIZE; i++) frame[i] *= 32767;
        const vad = this.state.processFrame(frame);
        for (let i=0; i<FRAME_SIZE; i++) frame[i] /= 32767;
        if (Number.isFinite(vad)) {
          this.vadSum += Math.min(1,Math.max(0,vad));
          if (++this.vadFrames >= 4) {
            this.port.postMessage({type:'vad',value:this.vadSum/this.vadFrames});
            this.vadSum = 0;
            this.vadFrames = 0;
          }
        }
      } catch (error) {
        this.fail(error);
        output.fill(0);
        return true;
      }
    }
    const start = (this.input + RING_SIZE - DELAY) % RING_SIZE;
    output.set(this.ring.subarray(start, start + QUANTUM));
    return true;
  }
}
registerProcessor('saring-rnnoise-vad', SaringRnnoiseVadProcessor);
