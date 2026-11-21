/*
 * Gerbang suara untuk Saring Suara: meredam audio saat tidak ada orang bicara,
 * sehingga musik di jeda dialog hilang.
 *
 *   const gate = await SpeechGate.create(audioCtx);
 *   hasilRnnoise.connect(gate.node);
 *   gate.node.connect(audioCtx.destination);
 *   SpeechGate.mountControls(document.querySelector('#kontrol-gate'), gate);
 *
 * Kalau wrapper RNNoise mengembalikan probabilitas bicara (VAD) per frame,
 * kirim dengan gate.setVad(nilai 0..1). Tanpa itu, gerbang memakai detektor
 * energi pita suara dengan noise floor adaptif.
 */
(function (global) {
  'use strict';

  const DEFAULTS = {
    enabled: false,
    thresholdDb: 8,
    depthDb: -28,
    attackMs: 3,
    holdMs: 200,
    releaseMs: 150,
    lookaheadMs: 10,
    vadThreshold: 0.5,
  };

  const workletURL = new URL('./speech-gate-worklet.js', document.currentScript?.src || document.baseURI).href;

  const loaded = new WeakSet();

  async function create(ctx, params) {
    try {
      if (!loaded.has(ctx)) {
        await ctx.audioWorklet.addModule(workletURL);
        loaded.add(ctx);
      }
    } catch (err) {
      console.warn('SpeechGate: AudioWorklet gagal dimuat, gerbang dilewati.', err);
      return { supported: false, node: ctx.createGain(), params: {}, onMeter: null, setParams() {}, setVad() {} };
    }

    let node;
    try {
      node = new AudioWorkletNode(ctx, 'speech-gate', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit'
      });
    } catch (err) {
      console.warn('SpeechGate: gagal membuat AudioWorkletNode.', err);
      return { supported: false, node: ctx.createGain(), params: {}, onMeter: null, setParams() {}, setVad() {} };
    }

    const gate = {
      supported: true,
      node: node,
      params: Object.assign({}, DEFAULTS, params),
      onMeter: null,
      setParams(p) {
        Object.assign(gate.params, p);
        node.port.postMessage({ type: 'params', params: gate.params });
      },
      setVad(value) {
        if (Number.isFinite(value)) node.port.postMessage({ type: 'vad', value: Math.max(0, Math.min(1, value)) });
      },
    };
    node.port.onmessage = (e) => {
      if (gate.onMeter) gate.onMeter(e.data);
    };
    node.port.postMessage({ type: 'params', params: gate.params });
    return gate;
  }

  function mountControls(container, gate) {
    const box = document.createElement('div');
    box.style.cssText =
      'display:grid;gap:10px;padding:12px;border:1px solid #cdd6cf;border-radius:12px;background:#edf2ed';

    if (!gate.supported) {
      box.textContent = 'Gerbang suara tidak didukung di browser ini.';
      container.appendChild(box);
      return box;
    }

    const toggleLabel = document.createElement('label');
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = gate.params.enabled;
    toggle.addEventListener('change', () => gate.setParams({ enabled: toggle.checked }));
    toggleLabel.append(toggle, ' Gerbang suara (redam musik saat tidak ada dialog)');
    box.appendChild(toggleLabel);

    const caution = document.createElement('small');
    caution.textContent = 'Deteksi energi adaptif, bukan VAD asli RNNoise. Musik yang naik-turun bisa dianggap dialog. Matikan gate bila kata terpotong.';
    box.appendChild(caution);

    const status = document.createElement('div');
    status.style.cssText = 'font-size:13px;opacity:.75';
    status.textContent = 'Gerbang: menunggu audio';

    function row(text, key, min, max, step, unit) {
      const wrap = document.createElement('label');
      wrap.style.cssText = 'display:grid;gap:4px';
      const title = document.createElement('span');
      const input = document.createElement('input');
      input.type = 'range';
      input.min = min;
      input.max = max;
      input.step = step;
      input.value = gate.params[key];
      const show = () => (title.textContent = text + ': ' + input.value + ' ' + unit);
      input.addEventListener('input', () => {
        show();
        gate.setParams({ [key]: Number(input.value) });
      });
      show();
      wrap.append(title, input);
      box.appendChild(wrap);
    }

    row('Ambang bicara', 'thresholdDb', 3, 20, 1, 'dB di atas noise floor');
    row('Peredaman saat diam', 'depthDb', -60, -6, 1, 'dB');
    row('Tahan setelah bicara', 'holdMs', 0, 500, 10, 'ms');
    row('Waktu menutup', 'releaseMs', 20, 500, 10, 'ms');

    box.appendChild(status);
    gate.onMeter = (m) => {
      status.textContent =
        'Gerbang: ' + (m.open ? 'terbuka' : 'tertutup') + ' · ' + m.gainDb.toFixed(1) + ' dB';
    };
    container.appendChild(box);
    return box;
  }

  global.SpeechGate = { create: create, mountControls: mountControls, DEFAULTS: DEFAULTS };
})(window);
