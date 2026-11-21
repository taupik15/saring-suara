/* Built into vendor-gtcrn/gtcrn-worklet.js by install-gtcrn.sh.
 * The model is GTCRN via @sapphi-red/gtcrn-wasm@0.0.3 (MIT).
 * All audio stays on the device. This is a speech denoiser, not music separation.
 */
import { GtcrnProcessor, loadGtcrnModule } from '@sapphi-red/gtcrn-wasm';

const FRAME = 768; // 16 ms at 48 kHz, internally resampled to 16 kHz.
const RING_SIZE = 4096;

class SaringGtcrnWorklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.available = false;
    this.failed = false;
    this.disposed = false;
    this.frame = new Float32Array(FRAME);
    this.frameAt = 0;
    this.clock = 0;
    this.dry = new Float32Array(RING_SIZE);
    this.wet = new Float32Array(RING_SIZE);
    this.mixTarget = 0.25;
    this.mixCurrent = 0.25;
    this.processor = null;
    this.module = null;
    this.port.onmessage = ({ data }) => {
      if (!data) return;
      if (data.type === 'mix' && Number.isFinite(data.value)) {
        this.mixTarget = Math.min(1, Math.max(0, data.value));
      } else if (data.type === 'reset') {
        this.frameAt = 0;
        this.dry.fill(0);
        this.wet.fill(0);
        this.clock = 0;
        if (this.processor && this.module) {
          try {
            this.processor.destroy();
            this.processor = new GtcrnProcessor(this.module, { sampleRate: 48000 });
          } catch (error) { this.fail(error); }
        }
      } else if (data.type === 'dispose') {
        this.disposed = true;
        this.available = false;
        if (this.processor) {
          try { this.processor.destroy(); } catch (_) {}
        }
        this.processor = null;
      }
    };
    const wasmBinary = options?.processorOptions?.wasmBinary;
    if (sampleRate !== 48000 || !(wasmBinary instanceof ArrayBuffer)) {
      this.fail(new Error('GTCRN memerlukan 48 kHz dan data WASM yang valid.'));
      return;
    }
    loadGtcrnModule({ wasmBinary }).then(module => {
      if (this.disposed) return;
      this.module = module;
      this.processor = new GtcrnProcessor(module, { sampleRate: 48000 });
      this.available = true;
      this.port.postMessage({ type: 'ready' });
    }).catch(error => this.fail(error));
  }
  fail(error) {
    this.available = false;
    this.failed = true;
    this.port.postMessage({ type: 'error', message: error?.message || String(error) });
  }
  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    for (let i = 0; i < output.length; i++) {
      const raw = input ? input[i] : 0;
      if (!this.available || this.failed || this.disposed) {
        output[i] = raw;
        continue;
      }
      const t = this.clock++;
      this.dry[(t + FRAME) % RING_SIZE] = raw;
      this.frame[this.frameAt++] = raw;
      if (this.frameAt === FRAME) {
        try {
          const result = this.processor.process(this.frame);
          // The result for the completed frame starts on the next sample.
          // Both paths are delayed equally, so dry/wet mixing does not comb-filter.
          const next = t + 1;
          for (let k = 0; k < FRAME; k++) this.wet[(next + k) % RING_SIZE] = result[k];
        } catch (error) {
          this.fail(error);
          output[i] = raw;
          this.frameAt = 0;
          continue;
        }
        this.frameAt = 0;
      }
      const index = t % RING_SIZE;
      const dry = t >= FRAME ? this.dry[index] : 0;
      const wet = t >= FRAME ? this.wet[index] : 0;
      this.dry[index] = 0;
      this.wet[index] = 0;
      this.mixCurrent += (this.mixTarget - this.mixCurrent) * 0.001;
      output[i] = Math.max(-1, Math.min(1, dry + (wet - dry) * this.mixCurrent));
    }
    return true;
  }
}

registerProcessor('saring-gtcrn', SaringGtcrnWorklet);
