/* Saring Suara Fix 1.6. Optional GTCRN real-time speech denoiser.
 * Explicitly opt-in, starts with 25% wet signal to protect speech.
 * If WASM/AudioWorklet fails, the existing DSP route remains available.
 */
'use strict';
(() => {
  const WORKLET_URL = './vendor-gtcrn/gtcrn-worklet.js';
  const WASM_URL = './vendor-gtcrn/gtcrn.wasm';
  const INSTALL_HINT = 'Aset GTCRN belum tersedia. Jalankan workflow Deploy Saring Suara + GTCRN di GitHub Actions.';

  function create({context, upstream, downstream, onStatus, onFailure}) {
    let wanted = false, destroyed = false, node = null, active = false;
    let pending = null, aborter = null, desiredMix = 25;
    let token = 0;
    const status = message => { if (!destroyed) onStatus?.(message); };
    function dry() {
      if (destroyed) return;
      try { upstream.disconnect(); } catch (_) {}
      try { node?.disconnect(); } catch (_) {}
      upstream.connect(downstream);
      active = false;
    }
    function wet() {
      if (destroyed || !node) return;
      try { upstream.disconnect(); } catch (_) {}
      try { node.disconnect(); } catch (_) {}
      upstream.connect(node);
      node.connect(downstream);
      node.port.postMessage({type:'mix',value:desiredMix/100});
      active = true;
    }
    function release() {
      if (node) {
        try { node.port.postMessage({type:'dispose'}); } catch (_) {}
        node.port.onmessage = null;
        node.onprocessorerror = null;
        try { node.disconnect(); } catch (_) {}
        node = null;
      }
    }
    function errorOut(error) {
      if (destroyed) return;
      wanted = false;
      dry();
      release();
      status('GTCRN gagal. Suara kembali ke filter stereo. ' + (error?.message || String(error)));
      onFailure?.(error);
    }
    async function start(current) {
      const controller = new AbortController();
      aborter = controller;
      try {
        if (context.sampleRate !== 48000) throw Error('GTCRN memerlukan 48 kHz, browser memakai '+context.sampleRate+' Hz.');
        if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') throw Error('AudioWorklet tidak didukung browser.');
        if (typeof WebAssembly === 'undefined') throw Error('WebAssembly tidak tersedia.');
        status('Memeriksa model GTCRN lokal…');
        const response = await fetch(WASM_URL, {signal: controller.signal});
        if (!response.ok) throw Error(response.status===404? INSTALL_HINT : 'Gagal mengambil model GTCRN (HTTP '+response.status+').');
        const binary = await response.arrayBuffer();
        if (binary.byteLength < 100000) throw Error('File model GTCRN tampak tidak lengkap.');
        if (!wanted || destroyed || token !== current) return;
        status('Memuat mesin suara GTCRN…');
        await context.audioWorklet.addModule(WORKLET_URL);
        if (!wanted || destroyed || token !== current) return;
        const next = new AudioWorkletNode(context, 'saring-gtcrn', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
          channelCount: 1, channelCountMode: 'explicit',
          processorOptions: {wasmBinary: binary}
        });
        node = next;
        next.onprocessorerror = () => errorOut(Error('Pemrosesan AudioWorklet terhenti.'));
        await new Promise((resolve,reject)=>{
          const timeout = setTimeout(()=>reject(Error('Inisialisasi GTCRN terlalu lama atau tidak merespons.')),25000);
          next.port.onmessage = ({data})=>{
            if (data?.type==='ready') {clearTimeout(timeout);resolve();}
            else if (data?.type==='error') {clearTimeout(timeout);reject(Error(data.message||'GTCRN gagal.'));}
          };
        });
        if (!wanted || destroyed || token !== current) return;
        wet();
        status('GTCRN aktif. Campuran '+desiredMix+'%; AI menjernihkan dialog, bukan menjamin musik hilang.');
      } catch (error) {
        if (!destroyed && wanted && token===current) errorOut(error);
      } finally {
        if (aborter === controller) aborter = null;
        if (token === current) pending = null;
      }
    }
    function enable(value) {
      if (destroyed) return;
      wanted = Boolean(value);
      token++;
      if (!wanted) {
        aborter?.abort();
        dry();release();
        status('GTCRN mati. Suara memakai filter stereo/musik tengah.');
        return;
      }
      if (node && active) {wet(); return;}
      pending = start(token);
    }
    function setLevel(value) {
      desiredMix = Math.round(Math.max(0,Math.min(100,Number(value)||0)));
      try {node?.port.postMessage({type:'mix',value:desiredMix/100});} catch (_) {}
    }
    function reset() {try {node?.port.postMessage({type:'reset'});} catch (_) {}}
    function destroy() {
      if (destroyed) return;
      wanted = false;token++;
      aborter?.abort();
      try {upstream.disconnect();}catch(_){}
      release();
      destroyed = true;
    }
    return {enable,setLevel,reset,destroy,get active(){return active;}};
  }
  window.SaringAI = Object.freeze({create});
})();
