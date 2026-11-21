/*
 * Saring Suara Fix 1.2 — low-memory adaptive center-voice enhancement.
 * No pretrained model and no FFmpeg. This attenuates stereo side information;
 * stationary centered music can be reduced using temporal spectral subtraction,
 * but overlapping centered voice/music cannot be cleanly separated without AI.
 * MIT-style project local implementation; no third-party code included.
 */
'use strict';

const FFT_SIZE = 1024;
const HOP = 256;
const RING = 8192;

class CenterVoiceProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = new Float32Array(FFT_SIZE);
    this.right = new Float32Array(FFT_SIZE);
    this.midRe = new Float32Array(FFT_SIZE);
    this.midIm = new Float32Array(FFT_SIZE);
    this.sideRe = new Float32Array(FFT_SIZE);
    this.sideIm = new Float32Array(FFT_SIZE);
    this.window = new Float32Array(FFT_SIZE);
    this.windowedOut = new Float32Array(RING);
    this.normalization = new Float32Array(RING);
    this.delayedDry = new Float32Array(RING);
    this.gainHistory = new Float32Array(FFT_SIZE / 2 + 1).fill(1);
    // Lightweight adaptive music-bed estimate for CENTERED sound only.
    // One value per FFT bin; bounded constant memory independent of video duration.
    this.bedEstimate = new Float32Array(FFT_SIZE / 2 + 1);
    this.centerGainHistory = new Float32Array(FFT_SIZE / 2 + 1).fill(1);
    this.centerFrames = 0;
    this.centerStrength = 0.35;
    this.bitReversal = new Uint16Array(FFT_SIZE);
    this.stageCos = [];
    this.stageSin = [];
    for (let i = 0; i < FFT_SIZE; i++) {
      let x = i, rev = 0;
      for (let j = 0; j < 10; j++) { rev = (rev << 1) | (x & 1); x >>= 1; }
      this.bitReversal[i] = rev;
      this.window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / FFT_SIZE);
    }
    for (let step = 2; step <= FFT_SIZE; step <<= 1) {
      this.stageCos.push(Math.cos(2 * Math.PI / step));
      this.stageSin.push(Math.sin(2 * Math.PI / step));
    }
    this.position = 0;
    this.samples = 0;
    this.strength = 0.85;
    this.bypass = false;
    this.wetMix = 1;
    this.monoWarned = false;
    this.port.onmessage = ({data}) => {
      if (!data || typeof data !== 'object') return;
      if (data.type === 'strength' && Number.isFinite(data.value))
        this.strength = Math.min(1, Math.max(0, data.value));
      else if (data.type === 'centerStrength' && Number.isFinite(data.value))
        this.centerStrength = Math.min(1, Math.max(0, data.value));
      else if (data.type === 'resetEstimator') {
        this.bedEstimate.fill(0);
        this.centerGainHistory.fill(1);
        this.centerFrames = 0;
      }
      else if (data.type === 'bypass') this.bypass = !!data.value;
    };
  }

  fft(real, imag, inverse) {
    const n = FFT_SIZE;
    for (let i = 0; i < n; i++) {
      const j = this.bitReversal[i];
      if (j > i) {
        let tmp = real[i]; real[i] = real[j]; real[j] = tmp;
        tmp = imag[i]; imag[i] = imag[j]; imag[j] = tmp;
      }
    }
    for (let size = 2, level = 0; size <= n; size <<= 1, level++) {
      const half = size >> 1;
      const wCos = this.stageCos[level];
      const wSin = (inverse ? 1 : -1) * this.stageSin[level];
      for (let block = 0; block < n; block += size) {
        let cos = 1, sin = 0;
        for (let j = 0; j < half; j++) {
          const even = block + j;
          const odd = even + half;
          const vr = real[odd] * cos - imag[odd] * sin;
          const vi = real[odd] * sin + imag[odd] * cos;
          const er = real[even], ei = imag[even];
          real[even] = er + vr; imag[even] = ei + vi;
          real[odd] = er - vr; imag[odd] = ei - vi;
          const nextCos = cos * wCos - sin * wSin;
          sin = sin * wCos + cos * wSin;
          cos = nextCos;
        }
      }
    }
    if (inverse) {
      const scale = 1 / n;
      for (let i = 0; i < n; i++) {real[i] *= scale; imag[i] *= scale;}
    }
  }

  separate(endSample) {
    const N = FFT_SIZE;
    const startIndex = this.position;
    for (let i = 0; i < N; i++) {
      const index = (startIndex + i) & (N - 1);
      const L = this.left[index], R = this.right[index];
      const w = this.window[i];
      this.midRe[i] = 0.5 * (L + R) * w;
      this.sideRe[i] = 0.5 * (L - R) * w;
      this.midIm[i] = this.sideIm[i] = 0;
    }
    this.fft(this.midRe, this.midIm, false);
    this.fft(this.sideRe, this.sideIm, false);
    // Music spread to L/R produces high side energy. Keep the frequencies
    // concentrated in the center, where a centered speaking voice often lives.
    // This is a DSP heuristic: NOT an AI source separator.
    const s = this.strength;
    const weight = 0.15 + 42 * s * s;
    const floor = 0.025 + 0.175 * (1 - s);
    this.centerFrames++;
    // Gentle ramp prevents sudden artifacts before the background estimate settles.
    const warmup = Math.min(1, Math.max(0, (this.centerFrames - 12) / 90));
    const centerDepth = this.centerStrength * 0.91 * warmup;
    for (let k = 0; k <= N / 2; k++) {
      const mr = this.midRe[k], mi = this.midIm[k];
      const sr = this.sideRe[k], si = this.sideIm[k];
      const midPower = mr * mr + mi * mi;
      const sidePower = sr * sr + si * si;
      const dominance = midPower / (midPower + weight * sidePower + 1e-9);
      const target = floor + (1 - floor) * dominance;
      const previous = this.gainHistory[k];
      // Smooth across frames so hard speech/music transitions do not click.
      const stereoGain = previous + 0.32 * (target - previous);
      this.gainHistory[k] = stereoGain;

      // MUSIC IN THE CENTER: a slowly varying spectral bed is likely to be
      // sustained background content. New spectral components (often speech)
      // are less attenuated. This is an estimate, not true source separation.
      const amplitude = Math.sqrt(midPower);
      const oldBed = this.bedEstimate[k];
      const bed = this.centerFrames === 1 ? amplitude
        : oldBed + (amplitude < oldBed ? 0.16 : 0.008) * (amplitude - oldBed);
      this.bedEstimate[k] = bed;
      const stationaryFraction = Math.min(1, bed / (amplitude + 1e-8));
      // Adaptive per-bin attenuation, with finite floor to keep dialogue audible.
      const centerTarget = 1 - centerDepth * stationaryFraction;
      const oldCenterGain = this.centerGainHistory[k];
      const centerGain = oldCenterGain + (centerTarget < oldCenterGain ? 0.18 : 0.35) *
        (centerTarget - oldCenterGain);
      this.centerGainHistory[k] = centerGain;
      const gain = stereoGain * centerGain;
      this.midRe[k] *= gain; this.midIm[k] *= gain;
      if (k > 0 && k < N / 2) {
        this.midRe[N - k] *= gain;
        this.midIm[N - k] *= gain;
      }
    }
    this.fft(this.midRe, this.midIm, true);
    const base = endSample + 1;
    for (let i = 0; i < N; i++) {
      const at = (base + i) & (RING - 1);
      const w = this.window[i];
      this.windowedOut[at] += this.midRe[i] * w;
      this.normalization[at] += w * w;
    }
  }

  process(inputs, outputs) {
    const channels = inputs[0];
    const output = outputs[0];
    if (!output || !output.length) return true;
    const left = channels && channels[0];
    const right = channels && channels[1];
    if (left && !right && !this.monoWarned) {
      this.monoWarned = true;
      this.port.postMessage({type: 'mono'});
    }
    const frames = output[0].length;
    for (let i = 0; i < frames; i++) {
      const t = this.samples;
      const ringIdx = this.position;
      const a = left ? left[i] : 0;
      const b = right ? right[i] : a;
      const center = 0.5 * (a + b);
      this.left[ringIdx] = a;
      this.right[ringIdx] = b;
      this.delayedDry[(t + FFT_SIZE) & (RING - 1)] = center;
      this.position = (ringIdx + 1) & (FFT_SIZE - 1);
      this.samples++;
      if (this.samples >= FFT_SIZE && this.samples % HOP === 0) this.separate(t);
      const outputIndex = t & (RING - 1);
      const denom = this.normalization[outputIndex];
      const filtered = denom > 1e-8 ? this.windowedOut[outputIndex] / denom : 0;
      const dry = this.delayedDry[outputIndex];
      this.windowedOut[outputIndex] = 0;
      this.normalization[outputIndex] = 0;
      this.delayedDry[outputIndex] = 0;
      const target = this.bypass ? 0 : 1;
      this.wetMix += (target - this.wetMix) * (1 / 512);
      const signal = (1 - this.wetMix) * dry + this.wetMix * filtered;
      const clipped = Math.max(-1, Math.min(1, signal));
      for (const ch of output) ch[i] = clipped;
    }
    return true;
  }
}
registerProcessor('saring-center-voice', CenterVoiceProcessor);
