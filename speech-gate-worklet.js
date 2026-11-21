/* Adapted from user-supplied speech-gate.js. Same-origin AudioWorklet for iPhone Safari. */
'use strict';
class SpeechGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.p = Object.assign({}, {"enabled": false, "thresholdDb": 8, "depthDb": -28, "attackMs": 3, "holdMs": 200, "releaseMs": 150, "lookaheadMs": 10, "vadThreshold": 0.5});
    this.vad = 0;
    this.vadTime = -1;
    this.lpFast = 0;
    this.lpSlow = 0;
    this.es = 0;
    this.floor = Infinity;
    this.warmup = Math.round(1.5 * sampleRate);
    this.gain = 1;
    this.holdLeft = 0;
    this.bufs = [];
    this.w = 0;
    this.L = -1;
    this.tick = 0;
    this.gains = new Float32Array(128);
    this.derive();
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'params') {
        Object.assign(this.p, m.params);
        this.derive();
      } else if (m.type === 'reset') {
        this.lpFast = this.lpSlow = this.es = 0;
        this.floor = Infinity;
        this.warmup = Math.round(1.5 * sampleRate);
        this.holdLeft = 0;
        this.gain = 1;
        this.bufs = [];
        this.w = 0;
      } else if (m.type === 'vad') {
        this.vad = m.value;
        this.vadTime = currentTime;
      }
    };
  }

  derive() {
    const p = this.p;
    const q = 128 / sampleRate;
    this.depth = Math.pow(10, p.depthDb / 20);
    this.thr = Math.pow(10, p.thresholdDb / 10);
    this.holdSamples = Math.round(p.holdMs * sampleRate / 1000);
    this.ca = 1 - Math.exp(-1 / Math.max(1, p.attackMs * sampleRate / 1000));
    this.cr = 1 - Math.exp(-1 / Math.max(1, p.releaseMs * sampleRate / 1000));
    this.aFast = Math.exp(-2 * Math.PI * 4000 / sampleRate);
    this.aSlow = Math.exp(-2 * Math.PI * 150 / sampleRate);
    this.kE = 1 - Math.exp(-q / 0.02);
    this.kDown = 1 - Math.exp(-q / 0.2);
    this.kUp = 1 - Math.exp(-q / 3);
    this.kUpOpen = 1 - Math.exp(-q / 20);
    const L = Math.round(p.lookaheadMs * sampleRate / 1000);
    if (L !== this.L) {
      this.L = L;
      this.bufs = [];
      this.w = 0;
    }
  }

  process(inputs, outputs) {
    const inp = inputs[0];
    const out = outputs[0];
    if (!inp || !inp.length) return true;
    const n = inp[0].length;
    const chs = inp.length;

    if (!this.p.enabled) {
      for (let c = 0; c < out.length; c++) out[c].set(inp[Math.min(c, chs - 1)]);
      return true;
    }

    let sum = 0;
    for (let i = 0; i < n; i++) {
      let x = 0;
      for (let c = 0; c < chs; c++) x += inp[c][i];
      x /= chs;
      this.lpFast = this.aFast * this.lpFast + (1 - this.aFast) * x;
      this.lpSlow = this.aSlow * this.lpSlow + (1 - this.aSlow) * x;
      const b = this.lpFast - this.lpSlow;
      sum += b * b;
    }
    this.es += (sum / n - this.es) * this.kE;
    const es = this.es;

    const vadFresh = currentTime - this.vadTime < 0.1;
    let speech = vadFresh
      ? this.vad > this.p.vadThreshold
      : es > 1e-7 && es > this.floor * this.thr;

    // Selama warmup gerbang terbuka dan floor mengikuti nilai terendah.
    if (this.warmup > 0) {
      this.warmup -= n;
      if (es > 1e-8) {
        this.floor = Number.isFinite(this.floor) ? this.floor + 0.03 * (es - this.floor) : es;
      }
      speech = true;
    } else if (!Number.isFinite(this.floor)) {
      this.floor = Math.max(1e-8, es);
      speech = true;
    } else if (es < this.floor) {
      this.floor += (es - this.floor) * this.kDown;
    } else {
      const k = speech || this.holdLeft > 0 ? this.kUpOpen : this.kUp;
      this.floor += (es - this.floor) * k;
    }

    if (speech) this.holdLeft = this.holdSamples;
    else if (this.holdLeft > 0) this.holdLeft -= n;
    const open = speech || this.holdLeft > 0;
    const target = open ? 1 : this.depth;

    const g = this.gains.length >= n ? this.gains : (this.gains = new Float32Array(n));
    let gain = this.gain;
    for (let i = 0; i < n; i++) {
      gain += (target - gain) * (target > gain ? this.ca : this.cr);
      g[i] = gain;
    }
    this.gain = gain;

    // Audio ditunda sebesar lookahead agar gerbang sudah terbuka saat kata dimulai.
    const size = this.L + 1;
    for (let c = 0; c < out.length; c++) {
      const src = inp[Math.min(c, chs - 1)];
      if (!this.bufs[c]) this.bufs[c] = new Float32Array(size);
      const buf = this.bufs[c];
      let w = this.w;
      for (let i = 0; i < n; i++) {
        buf[w] = src[i];
        w = (w + 1) % size;
        out[c][i] = buf[w] * g[i];
      }
    }
    this.w = (this.w + n) % size;

    if (++this.tick % 20 === 0) {
      this.port.postMessage({
        open: open,
        gainDb: 20 * Math.log10(Math.max(gain, 1e-5)),
        ratioDb: 10 * Math.log10(Math.max(es, 1e-10) / Math.max(this.floor, 1e-10)),
      });
    }
    return true;
  }
}
registerProcessor('speech-gate', SpeechGate);
