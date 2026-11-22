/* Saring Suara Fix 2.0 · experimental near-live music-stem reduction.
 * Source audio is read ahead by a separate <audio> element (no full-file
 * decoding) and separated by MDX 9482 in a worker. It needs an initial
 * ~6-second pre-roll. Main video remains the master clock. Missing/late
 * chunks are never played late: existing filters are audible instead.
 * No promise that iOS can keep up. Default OFF; fail closed to original DSP.
 */
'use strict';
(() => {
  const CHUNK=256*1024/44100;
  const MAX_RTF=1.15; // Auto-fallback if each UVR chunk takes too long.
  const MIX_MAX=0.45; // Protect dialogue artifacts and audio quality.
  function create({context, player, sourceUrl, upstream, mount, onStatus}) {
    const ctx=context;
    const tell=s=>{if(!destroyed){state.textContent=s;onStatus?.(s);}};
    const ui=document.createElement('div');ui.className='ai-controls';
    const label=document.createElement('label');
    const toggle=document.createElement('input');toggle.type='checkbox';toggle.checked=false;
    label.append(toggle,document.createTextNode(' UVR 9482 · redam sisa musik (eksperimen)'));
    const details=document.createElement('small');
    details.textContent='Model ~28 MB, potongan ~6 detik. Butuh buffer awal dan audio scanner yang bisa memutar file. Jika pemrosesan lebih lambat daripada video, otomatis kembali ke filter sebelumnya. Matikan saat iPhone terasa panas.';
    const mixLabel=document.createElement('label');
    mixLabel.textContent='Campuran hasil UVR: ';
    const slider=document.createElement('input');slider.type='range';slider.min='0';slider.max='45';slider.step='5';slider.value='25';slider.disabled=true;
    const value=document.createElement('span');value.textContent='25%';
    mixLabel.append(slider,value);
    const scannerButton=document.createElement('button');scannerButton.type='button';scannerButton.textContent='Mulai buffer UVR';scannerButton.disabled=true;
    const state=document.createElement('small');state.setAttribute('role','status');
    state.textContent='UVR mati. Video memakai filter RNNoise/GTCRN seperti biasa.';
    ui.append(label,details,mixLabel,scannerButton,state);
    mount.append(ui);
    let destroyed=false,armed=false,worker=null,scanner=null,tap=null;
    let dryGain=null,wetBus=null,scannerSource=null,rewired=false;
    let startAt=0,enabled=false,busy=false,scannerStarted=false;
    let workerReady=false,streamReady=false,prepared=false,playReady=false;
    let generation=0,scanned=0,processed=0,totalMs=0;
    const segments=new Map(),sources=new Map();
    const status={get enabled(){return enabled;},get ready(){return playReady;}};
    function setStrength(){
      value.textContent=slider.value+'%';
      const factor=Number(slider.value)/100;
      if(dryGain){
        const v=sources.size?1-factor:1;
        dryGain.gain.setTargetAtTime(v,ctx.currentTime,0.04);
      }
      for(const item of sources.values())item.gain.gain.setTargetAtTime(factor,ctx.currentTime,0.04);
    }
    slider.oninput=setStrength;
    function stopScheduled(){
      for(const {source,gain} of sources.values()){
        try{source.stop();}catch(_){}
        try{source.disconnect();gain.disconnect();}catch(_){}
      }
      sources.clear();
      if(dryGain)dryGain.gain.setTargetAtTime(1,ctx.currentTime,0.02);
    }
    function schedule(){
      if(!enabled||!playReady||!player||player.paused||!dryGain||!wetBus)return;
      if(Math.abs(player.playbackRate-1)>1e-6){tell('UVR hanya untuk kecepatan 1×. Filter lama tetap berjalan.');return;}
      const now=player.currentTime;
      for(const [index,segment] of segments){
        if(sources.has(index))continue;
        const begin=startAt+index*CHUNK;
        const offset=Math.max(0,now-begin);
        if(offset>segment.duration-0.1)continue;
        const wait=Math.max(0,begin-now);
        if(wait>1.4)continue;
        try{
          const buffer=ctx.createBuffer(2,segment.left.length,segment.rate);
          buffer.copyToChannel(segment.left,0);buffer.copyToChannel(segment.right,1);
          const source=ctx.createBufferSource(),gain=ctx.createGain();
          gain.gain.value=0;
          source.buffer=buffer;source.connect(gain);gain.connect(wetBus);
          const when=ctx.currentTime+Math.max(.045,wait);
          const playOffset=Math.min(buffer.duration-.05,offset+(wait<=0?.045:0));
          const end=when+buffer.duration-playOffset;
          const factor=Number(slider.value)/100;
          gain.gain.setValueAtTime(0,when);
          gain.gain.linearRampToValueAtTime(factor,when+Math.min(.045,(end-when)/4));
          if(end-when>.15)gain.gain.setValueAtTime(factor,end-.045);
          gain.gain.linearRampToValueAtTime(0,end);
          dryGain.gain.setTargetAtTime(1-factor,when,.018);
          // The dry path always remains available. At a missing AI chunk it
          // returns to full volume rather than playing stale vocals.
          dryGain.gain.setTargetAtTime(1,end,.023);
          sources.set(index,{source,gain});
          source.onended=()=>{
            if(sources.get(index)?.source===source)sources.delete(index);
            try{source.disconnect();gain.disconnect();}catch(_){}
            for(const key of segments.keys())if(key<index-1)segments.delete(key);
          };
          source.start(when,playOffset);
        }catch(error){tell('UVR chunk gagal dijadwalkan: '+(error?.message||error));}
      }
    }
    function restorePath(){
      stopScheduled();
      if(dryGain){
        try{upstream.disconnect(dryGain);}catch(_){}
        try{dryGain.disconnect();}catch(_){}
        dryGain=null;
      }
      if(rewired){try{upstream.connect(ctx.destination);}catch(_){}rewired=false;}
      if(wetBus){try{wetBus.disconnect();}catch(_){}wetBus=null;}
    }
    function cleanup(){
      if(scanner){try{scanner.pause();scanner.removeAttribute('src');scanner.load();scanner.remove();}catch(_){}scanner=null;}
      if(tap){try{tap.port.postMessage({type:'stop'});tap.port.close();tap.disconnect();}catch(_){}tap=null;}
      if(scannerSource){try{scannerSource.disconnect();}catch(_){}scannerSource=null;}
      if(worker){try{worker.postMessage({type:'stop'});worker.terminate();}catch(_){}worker=null;}
      restorePath();
      segments.clear();armed=false;enabled=false;busy=false;workerReady=streamReady=prepared=playReady=scannerStarted=false;
      scannerButton.disabled=true;slider.disabled=true;
    }
    function disable(message){
      generation++;
      cleanup();
      toggle.checked=false;
      if(message)tell(message);
    }
    function fail(error){disable('UVR dinonaktifkan: '+(error?.message||String(error))+'. Video kembali ke filter sebelumnya.');}
    function onChunk(event){
      if(!enabled||!worker||!scannerStarted)return;
      if(event.type!=='chunk')return;
      scanned++;
      if(busy){
        // Do not queue up megabytes of PCM or trigger ever-growing lag.
        fail(Error('AI tertinggal dari audio. Mode real-time tidak cukup cepat di perangkat ini'));
        return;
      }
      busy=true;
      try{worker.postMessage({type:'chunk',index:event.index,left:event.left,right:event.right,rate:event.rate},[event.left,event.right]);}
      catch(e){fail(e);}
    }
    function onWorker(event,token){
      if(token!==generation||!enabled)return;
      const m=event.data||{};
      if(m.type==='ready'){
        workerReady=true;scannerButton.disabled=false;
        tell('UVR siap ('+m.backend+'). Ketuk Mulai buffer UVR untuk membaca audio awal.');
      }else if(m.type==='result'){
        busy=false;processed++;totalMs+=m.ms;
        if(m.ms>CHUNK*1000*MAX_RTF){
          fail(Error('Model membutuhkan '+(m.ms/1000).toFixed(1)+' dtk untuk '+CHUNK.toFixed(1)+' dtk audio'));
          return;
        }
        segments.set(m.index,{left:new Float32Array(m.left),right:new Float32Array(m.right),rate:m.rate,duration:new Float32Array(m.left).length/m.rate});
        // Limit retained PCM to three chunks (~7MB) to avoid Safari reloads.
        for(const key of segments.keys())if(key<m.index-2)segments.delete(key);
        if(!playReady){playReady=true;tell('UVR siap diputar: ketuk Play pada video. Pemrosesan berikutnya berjalan di depan video.');}
        else tell('UVR aktif · '+processed+' blok diproses · '+(m.ms/1000).toFixed(1)+' dtk/blok. Jika blok berikut terlambat, filter lama tetap bekerja.');
        schedule();
      }else if(m.type==='skip')fail(Error('Buffer AI penuh. Pemutar kembali ke filter lama'));
      else if(m.type==='error')fail(Error(m.message||'Mesin MDX gagal'));
    }
    async function enable(){
      if(destroyed||enabled)return;
      generation++;const token=generation;
      enabled=true;armed=true;
      player.pause();
      startAt=Math.max(0,player.currentTime||0);
      tell('Memuat model UVR 9482 (~28 MB). Video dijeda agar tidak kehilangan sinkronisasi…');
      try{
        if(!ctx.audioWorklet||typeof AudioWorkletNode==='undefined'||typeof Worker==='undefined')throw Error('AudioWorklet/Worker tidak tersedia.');
        worker=new Worker('./uvr-live-worker.js');
        worker.onerror=e=>{if(enabled&&token===generation)fail(Error(e.message||'Worker tidak bisa dimuat'));};
        worker.onmessage=e=>onWorker(e,token);
        await ctx.audioWorklet.addModule('./uvr-tap-worklet.js');
        if(token!==generation||destroyed)return;
        scanner=document.createElement('audio');
        scanner.preload='auto';scanner.playsInline=true;
        scanner.src=sourceUrl;
        scanner.style.cssText='position:absolute;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none';
        mount.append(scanner);
        scanner.onerror=()=>{if(enabled&&token===generation)fail(Error('Audio scanner tidak bisa membaca trek audio file video ini'))};
        scanner.onended=()=>{try{tap?.port.postMessage({type:'flush'});}catch(_){};};
        scannerSource=ctx.createMediaElementSource(scanner);
        tap=new AudioWorkletNode(ctx,'saring-uvr-tap',{
          numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2],channelCount:2,channelCountMode:'max'
        });
        tap.port.onmessage=e=>onChunk(e.data||{});
        scannerSource.connect(tap);tap.connect(ctx.destination); // tap always outputs silence
        dryGain=ctx.createGain();dryGain.gain.value=1;
        wetBus=ctx.createGain();wetBus.connect(ctx.destination);
        try{upstream.disconnect(ctx.destination);}catch(_){}
        upstream.connect(dryGain);dryGain.connect(ctx.destination);rewired=true;
        slider.disabled=false;
        streamReady=true;
        worker.postMessage({type:'init'});
      }catch(e){if(token===generation)fail(e);}
    }
    function startScanner(){
      if(!enabled||!workerReady||!scanner||scannerStarted)return;
      // No await before play(): Safari requires a direct user gesture.
      ctx.resume().catch(()=>{});
      try{scanner.currentTime=startAt;}catch(_){}
      const p=scanner.play();
      scannerStarted=true;scannerButton.disabled=true;
      tell('Membaca audio sekitar 6 detik di depan video. Tunggu sampai UVR siap diputar.');
      p?.catch(error=>{
        scannerStarted=false;scannerButton.disabled=false;
        tell('Safari menolak audio scanner. Ketuk Mulai buffer lagi: '+(error?.message||error));
      });
    }
    scannerButton.onclick=startScanner;
    toggle.onchange=()=>{
      if(toggle.checked)enable();
      else disable('UVR mati. Filter RNNoise/GTCRN seperti sebelumnya kembali aktif.');
    };
    const playing=()=>{if(enabled){
      if(scannerStarted&&scanner?.paused&&!scanner.ended)scanner.play().catch(()=>{tell('Safari menahan scanner; suara memakai filter lama saat buffer kosong.');});
      schedule();
    }};
    const timeupdate=()=>{if(enabled)schedule();};
    const pause=()=>{if(enabled){stopScheduled();if(playReady)scanner?.pause();}};
    const seek=()=>{if(enabled)disable('UVR dimatikan saat seek agar audio tidak meleset. Aktifkan lagi dari posisi baru.');};
    const speed=()=>{if(enabled&&player.playbackRate!==1)disable('UVR memerlukan video 1×. Filter lama tetap berjalan.');};
    player.addEventListener('playing',playing);
    player.addEventListener('timeupdate',timeupdate);
    player.addEventListener('pause',pause);
    player.addEventListener('seeking',seek);
    player.addEventListener('ratechange',speed);
    function destroy(){
      if(destroyed)return;
      disable(null);
      destroyed=true;
      player.removeEventListener('playing',playing);
      player.removeEventListener('timeupdate',timeupdate);
      player.removeEventListener('pause',pause);
      player.removeEventListener('seeking',seek);
      player.removeEventListener('ratechange',speed);
    }
    return {...status,destroy};
  }
  window.SaringUVR=Object.freeze({create});
})();
