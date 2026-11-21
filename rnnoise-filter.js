/* Fix 1.7: RNNoise in the live video audio graph. No FFmpeg or full-file decode.
 * Runtime is self-hosted from vendor-rnnoise/ by GitHub Pages.
 * Source audio/video stays local; only WASM/JS assets are loaded.
 * RNNoise reduces noise, not guaranteed music separation.
 */
'use strict';
(() => {
  const ROOT = './vendor-rnnoise/';
  const WASM = ROOT + 'rnnoise.wasm';
  const WORKLET = ROOT + 'rnnoise-worklet.js';
  const MAIN = ROOT + 'rnnoise-main.js';
  const DELAY_SAMPLES = 640; // library's mono AudioWorklet delay: 640 samples at 48kHz
  function create({context, upstream, downstream, onStatus, onFailure}) {
    let node=null, delay=null, dryGain=null, wetGain=null, hub=null;
    let destroyed=false, wanted=false, connected=false, aborter=null;
    let generation=0, mix=0.25, pending=null, workletAdded=null;
    const tell = msg => {if (!destroyed) onStatus?.(msg);};
    function release() {
      if(node) {try{node.destroy();}catch(_){} try{node.disconnect();}catch(_){} node.onprocessorerror=null;node=null;}
      for(const n of [delay,dryGain,wetGain,hub]) {try{n?.disconnect();}catch(_){} }
      delay=dryGain=wetGain=hub=null;
    }
    function dry() {
      if(destroyed)return;
      try{upstream.disconnect();}catch(_){}
      release();
      upstream.connect(downstream);
      connected=false;
    }
    function setMix(v) {
      mix=Math.max(0,Math.min(1,Number(v)||0));
      if (wetGain && dryGain) {
        const t=context.currentTime;
        // Fast, click-free fade between latency-matched dry and RNNoise paths.
        wetGain.gain.setTargetAtTime(mix,t,0.025);
        dryGain.gain.setTargetAtTime(1-mix,t,0.025);
      }
    }
    function connect(nodeToUse) {
      if(destroyed||!wanted)return;
      try{upstream.disconnect();}catch(_){}
      release();
      node=nodeToUse;
      delay=context.createDelay(0.1);
      delay.delayTime.value=DELAY_SAMPLES/context.sampleRate;
      dryGain=context.createGain();wetGain=context.createGain();hub=context.createGain();
      // Attach both paths with equal latency to avoid comb-filter distortion.
      dryGain.gain.value=1;wetGain.gain.value=0;
      upstream.connect(delay);delay.connect(dryGain);dryGain.connect(hub);
      upstream.connect(node);node.connect(wetGain);wetGain.connect(hub);
      hub.connect(downstream);
      setMix(mix);
      connected=true;
      node.onprocessorerror=()=>fail(Error('AudioWorklet RNNoise terhenti.'));
      tell('RNNoise terhubung ke pemutar video. Efeknya mengikuti suara saat video berjalan; musik mungkin masih terdengar.');
    }
    function fail(error) {
      if(destroyed)return;
      wanted=false;generation++;
      aborter?.abort();
      dry();
      tell('RNNoise live gagal. Suara kembali ke filter stereo. '+(error?.message||String(error)));
      onFailure?.(error);
    }
    async function start(current) {
      const abort=new AbortController();aborter=abort;
      try {
        if(context.sampleRate!==48000) throw Error('RNNoise live membutuhkan AudioContext 48 kHz (sekarang '+context.sampleRate+' Hz).');
        if(!context.audioWorklet||typeof AudioWorkletNode==='undefined') throw Error('Safari tidak menyediakan AudioWorklet.');
        tell('Memuat RNNoise-WASM lokal untuk video…');
        if(!workletAdded) workletAdded=context.audioWorklet.addModule(WORKLET).catch(error=>{workletAdded=null;throw error;});
        const [{RnnoiseWorkletNode}] = await Promise.all([import(MAIN), workletAdded]);
        if(typeof RnnoiseWorkletNode!=='function') throw Error('Modul RNNoise tidak cocok.');
        const response=await fetch(WASM,{signal:abort.signal});
        if(!response.ok)throw Error(response.status===404?'Aset RNNoise belum terpasang di GitHub Pages. Jalankan Deploy Saring Suara + GTCRN & RNNoise.':'RNNoise WASM HTTP '+response.status);
        const binary=await response.arrayBuffer();
        if(!binary.byteLength||!WebAssembly.validate(binary))throw Error('RNNoise WASM tidak valid.');
        if(!wanted||destroyed||current!==generation)return;
        const ready=new RnnoiseWorkletNode(context,{wasmBinary:binary,maxChannels:1});
        if(!wanted||destroyed||current!==generation){ready.destroy();ready.disconnect();return;}
        connect(ready);
      } catch(e) {
        if(wanted&&!destroyed&&current===generation)fail(e);
      } finally {if(aborter===abort)aborter=null;if(current===generation)pending=null;}
    }
    function enable(value) {
      if(destroyed)return;
      const next=Boolean(value);
      if(next===wanted && (connected||pending))return;
      wanted=next;generation++;
      if(!wanted) {
        aborter?.abort();dry();
        tell('RNNoise live nonaktif. Video tetap memakai filter stereo/musik tengah.');
      } else { pending=start(generation); }
    }
    function destroy() {
      if(destroyed)return;
      wanted=false;generation++;aborter?.abort();
      try{upstream.disconnect();}catch(_){}
      release();destroyed=true;connected=false;
    }
    return {enable,setLevel(value){setMix(Math.max(0,Math.min(100,Number(value)||0))/100);},reset(){/* 10 ms tail only; no full reset needed on seek */},destroy,get active(){return connected;}};
  }
  window.SaringRNNoise=Object.freeze({create});
})();
