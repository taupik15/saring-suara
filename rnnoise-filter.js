/* Fix 1.9: RNNoise live + real neural speech probability (VAD). No FFmpeg.
 * Runtime is self-hosted from vendor-rnnoise/ by GitHub Pages.
 * Source audio/video stays local; only WASM/JS assets are loaded.
 * RNNoise reduces noise, not guaranteed music separation.
 */
'use strict';
(() => {
  const ROOT = './vendor-rnnoise/';
  const WASM = ROOT + 'rnnoise.wasm';
  const WORKLET = ROOT + 'rnnoise-vad-worklet.js';
  const DELAY_SAMPLES = 640; // library's mono AudioWorklet delay: 640 samples at 48kHz
  function create({context, upstream, downstream, onStatus, onFailure, onVad}) {
    let node=null, delay=null, dryGain=null, wetGain=null, hub=null;
    let destroyed=false, wanted=false, connected=false, aborter=null;
    let generation=0, mix=0.25, pending=null, workletAdded=null;
    const tell = msg => {if (!destroyed) onStatus?.(msg);};
    function clearVad() {try{onVad?.(null);}catch(_) {}}
    function dispose(used) {
      if(!used)return;
      try{used.port.postMessage({type:'destroy'});}catch(_){}
      try{used.disconnect();}catch(_){}
      used.onprocessorerror=null;
      try{used.port.close();}catch(_){}
    }
    function release() {
      if(node) {dispose(node);node=null;}
      for(const n of [delay,dryGain,wetGain,hub]) {try{n?.disconnect();}catch(_){} }
      delay=dryGain=wetGain=hub=null;
    }
    function dry() {
      if(destroyed)return;
      try{upstream.disconnect();}catch(_){}
      release();
      upstream.connect(downstream);
      connected=false;
      clearVad();
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
      node.port.onmessage=({data})=>{
        if(data?.type==='vad' && Number.isFinite(data.value) && connected && wanted){
          try{onVad?.(Math.max(0,Math.min(1,data.value)));}catch(_){}
        }else if(data?.type==='error') fail(Error(data.message||'RNNoise VAD error.'));
      };
      tell('RNNoise VAD aktif. Deteksi bicara dikirim ke Speech Gate; audio video tetap real-time.');
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
      let candidate=null;
      try {
        if(context.sampleRate!==48000) throw Error('RNNoise VAD membutuhkan 48 kHz (sekarang '+context.sampleRate+' Hz).');
        if(!context.audioWorklet||typeof AudioWorkletNode==='undefined') throw Error('Safari tidak menyediakan AudioWorklet.');
        tell('Memuat RNNoise dan deteksi bicara (VAD) lokal…');
        if(!workletAdded) workletAdded=context.audioWorklet.addModule(WORKLET).catch(error=>{workletAdded=null;throw error;});
        const responsePromise=fetch(WASM,{signal:abort.signal});
        const [response]=await Promise.all([responsePromise,workletAdded]);
        if(!response.ok)throw Error(response.status===404?'Aset RNNoise tidak tersedia di Pages. Jalankan ulang workflow build.':'RNNoise WASM HTTP '+response.status);
        const binary=await response.arrayBuffer();
        if(!binary.byteLength||!WebAssembly.validate(binary))throw Error('RNNoise WASM tidak valid.');
        if(!wanted||destroyed||current!==generation)return;
        candidate=new AudioWorkletNode(context,'saring-rnnoise-vad',{
          numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1],
          channelCount:1,channelCountMode:'explicit',
          processorOptions:{wasmBinary:binary}
        });
        await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(Error('RNNoise VAD tidak siap dalam 20 detik.')),20000);
          const cleanup=()=>{clearTimeout(timer);abort.signal.removeEventListener('abort',cancel);};
          const cancel=()=>{cleanup();reject(Error('RNNoise dibatalkan.'));};
          candidate.port.onmessage=({data})=>{
            if(data?.type==='ready') {cleanup();resolve();}
            else if(data?.type==='error') {cleanup();reject(Error(data.message||'RNNoise VAD tidak dapat dimuat.'));}
          };
          candidate.onprocessorerror=()=>{cleanup();reject(Error('RNNoise AudioWorklet terhenti saat inisialisasi.'));};
          abort.signal.addEventListener('abort',cancel,{once:true});
        });
        if(!wanted||destroyed||current!==generation)return;
        const ready=candidate;candidate=null;
        connect(ready);
      } catch(e) {
        if(wanted&&!destroyed&&current===generation)fail(e);
      } finally {
        if(candidate)dispose(candidate);
        if(aborter===abort)aborter=null;
        if(current===generation)pending=null;
      }
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
      release();destroyed=true;connected=false;clearVad();
    }
    return {enable,setLevel(value){setMix(Math.max(0,Math.min(100,Number(value)||0))/100);},reset(){try{node?.port.postMessage({type:'reset'});}catch(_){}clearVad();},destroy,get active(){return connected;}};
  }
  window.SaringRNNoise=Object.freeze({create});
})();
