/* Fix 1: isolate the heavy runtimes, add a no-FFmpeg preview and diagnostics. */
'use strict';
const $=id=>document.getElementById(id);
const file=$('file'), run=$('run'), cancel=$('cancel'), result=$('result');
const bar=document.querySelector('progress');
const isIOS=/iPad|iPhone|iPod/.test(navigator.userAgent)||
  (navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
let activeWorker=null, rejectActive=null, currentURL=null, audioContext=null, generation=0, running=false;
const stateKey='saring-suara-fix1-last-stage';

function persist(phase) {
  try { sessionStorage.setItem(stateKey,JSON.stringify({phase,time:Date.now()})); } catch (_) {}
}
function forget() {try {sessionStorage.removeItem(stateKey);} catch (_) {}}
function showStage(message,phase,progress) {
  $('status').textContent=message || '';
  if (phase) persist(phase);
  if (Number.isFinite(progress)) {bar.hidden=false;bar.max=1;bar.value=Math.max(0,Math.min(1,progress));}
}
function clearResult() {
  if(audioContext) {audioContext.close().catch(()=>{});audioContext=null;}
  result.replaceChildren();
  if(currentURL) URL.revokeObjectURL(currentURL);
  currentURL=null;
}
function idle(message) {
  running=false;
  if(activeWorker){activeWorker.terminate();activeWorker=null;}
  $('status').textContent=message || '';
  bar.hidden=cancel.hidden=true;
  file.disabled=false;
  $('options').disabled=false;
  run.disabled=!file.files.length;
}
function abort() {
  generation++;
  if(rejectActive) rejectActive();
  forget();
  clearResult();
  idle('Proses dibatalkan.');
}
function updateMode() {
  if(currentURL&&!running) clearResult();
  const stem=$('stem').value;
  const song=stem==='vokal'||stem==='instrumen';
  const preview=stem==='dialog-preview';
  $('dialogOptions').hidden=song;
  $('hint').hidden=!song;
  $('modeOptions').hidden=preview;
  $('previewHint').hidden=!preview;
  $('heavyGuard').hidden=!(isIOS&&song);
  $('exportWarning').hidden=stem!=='dialog-export';
}

$('stem').addEventListener('change',updateMode);
file.addEventListener('change',()=>{
  if(running) abort();
  clearResult();
  const source=file.files[0];
  if(source) {
    const video=isVideo(source);
    document.querySelector('input[name="mode"][value="'+(video?'video':'audio')+'"]').checked=true;
  }
  run.disabled=!source;
  $('status').textContent='';
});
cancel.addEventListener('click',abort);

// A worker is terminated immediately when it returns a Blob. This is important:
// FFmpeg's large Wasm heap must not coexist with Demucs's model in one worker.
function task(script,payload,token) {
  return new Promise((resolve,reject)=>{
    if(token!==generation) return reject(Error('Dibatalkan.'));
    let worker,settled=false;
    try { worker=new Worker(script); }
    catch(e) {return reject(Error('Tidak dapat membuat Web Worker: '+e.message));}
    activeWorker=worker;
    const done=(error,data)=>{
      if(settled) return;
      settled=true;
      worker.terminate();
      if(activeWorker===worker) activeWorker=null;
      if(rejectActive===stop) rejectActive=null;
      if(token!==generation) return reject(Error('Dibatalkan.'));
      if(error) reject(error); else resolve(data);
    };
    const stop=()=>done(Error('Dibatalkan.'));
    rejectActive=stop;
    worker.onerror=e=>done(Error('Worker gagal pada '+script+': '+(e.message||'kemungkinan RAM perangkat tidak cukup.')));
    worker.onmessageerror=()=>done(Error('Pesan dari Worker gagal dibaca.'));
    worker.onmessage=({data})=>{
      if(token!==generation) return;
      if(data.error) return done(Error(data.error));
      if(data.blob) return done(null,data);
      showStage(data.message,data.phase,data.progress);
    };
    try {worker.postMessage(payload);} catch(e) {done(Error('Gagal mengirim file ke Worker: '+e.message));}
  });
}
function isVideo(source) {
  return source.type.startsWith('video/')||/\.(mp4|m4v|mov|mkv|webm)$/i.test(source.name);
}
function resultFile(blob,source,stem,ext) {
  clearResult();
  currentURL=URL.createObjectURL(blob);
  const player=document.createElement(ext==='mp4'?'video':'audio');
  player.controls=true;
  player.playsInline=true;
  player.preload='metadata';
  player.src=currentURL;
  const link=document.createElement('a');
  link.href=currentURL;
  link.download=source.name.replace(/\.[^.]+$/,'')+'-'+stem+'.'+ext;
  link.textContent='Unduh '+ext.toUpperCase();
  result.append(player,link);
}
function wavFromPcm(pcm) {
  const bytes=pcm.size;
  if(bytes>0xffffffff-44) throw Error('Audio WAV melebihi batas 4 GiB.');
  const header=new ArrayBuffer(44), d=new DataView(header);
  function textAt(start,str){for(let i=0;i<str.length;i++) d.setUint8(start+i,str.charCodeAt(i));}
  textAt(0,'RIFF'); d.setUint32(4,bytes+36,true);textAt(8,'WAVE');
  textAt(12,'fmt ');d.setUint32(16,16,true);d.setUint16(20,1,true);
  d.setUint16(22,2,true);d.setUint32(24,44100,true);d.setUint32(28,176400,true);
  d.setUint16(32,4,true);d.setUint16(34,16,true);
  textAt(36,'data');d.setUint32(40,bytes,true);
  return new Blob([header,pcm],{type:'audio/wav'});
}

// Browser-native preview; this is voice EQ, not Demucs or true music removal.
// It never loads FFmpeg or the 52 MiB separation model.
function startPreview(source,centered) {
  clearResult();
  currentURL=URL.createObjectURL(source);
  const player=document.createElement(isVideo(source)?'video':'audio');
  player.controls=true;
  player.playsInline=true;
  player.preload='metadata';
  player.src=currentURL;
  const note=document.createElement('p');
  note.className='note';
  note.textContent='Pratinjau EQ berjalan saat video diputar. Ini memperjelas frekuensi percakapan, bukan menghilangkan musik dengan AI. Tidak membuat file ekspor.';
  result.append(player,note);
  player.addEventListener('error',()=>{ $('status').textContent='Codec media tidak didukung oleh browser. Coba video MP4/H.264/AAC.'; });
  const Context=window.AudioContext||window.webkitAudioContext;
  if(!Context) throw Error('Perangkat tidak mendukung Web Audio API.');
  audioContext=new Context();
  const media=audioContext.createMediaElementSource(player);
  const highpass=audioContext.createBiquadFilter();
  highpass.type='highpass';highpass.frequency.value=130;
  const lowpass=audioContext.createBiquadFilter();
  lowpass.type='lowpass';lowpass.frequency.value=5200;
  const presence=audioContext.createBiquadFilter();
  presence.type='peaking';presence.frequency.value=1700;presence.Q.value=0.7;presence.gain.value=3;
  const compressor=audioContext.createDynamicsCompressor();
  compressor.threshold.value=-26;compressor.ratio.value=2.5;
  if(centered) {
    const split=audioContext.createChannelSplitter(2);
    const left=audioContext.createGain(),right=audioContext.createGain();
    const sum=audioContext.createGain();
    left.gain.value=0.5;right.gain.value=0.5;
    media.connect(split);
    split.connect(left,0);split.connect(right,1);
    left.connect(sum);right.connect(sum);sum.connect(highpass);
  } else media.connect(highpass);
  highpass.connect(lowpass);lowpass.connect(presence);
  presence.connect(compressor);compressor.connect(audioContext.destination);
  // Resume is called directly in the user-activation handler to satisfy iOS.
  const resume=audioContext.resume();
  const play=player.play();
  return Promise.allSettled([resume,play]).then(([,playState])=>{
    if(playState.status==='rejected') {
      const error=playState.reason;
      if(error?.name==='NotAllowedError') $('status').textContent='Pratinjau siap. Tekan Play pada video untuk memulai suara yang difilter.';
      else $('status').textContent='Tidak dapat memutar file: '+(error?.message||'Codec media tidak didukung.');
    } else $('status').textContent='Pratinjau Dialog ringan aktif (tanpa FFmpeg).';
  });
}

run.addEventListener('click',()=>{
  const source=file.files[0];if(!source||running) return;
  const stem=$('stem').value;
  if((stem==='vokal'||stem==='instrumen')&&isIOS&&!$('allowHeavy').checked) {
    $('status').textContent='HTDemucs 52 MiB berisiko membuat tab iPhone refresh. Centang izin percobaan model berat jika ingin melanjutkan, atau gunakan Dialog ringan.';
    return;
  }
  if(stem==='dialog-preview') {
    // Call before any await to retain iOS's user gesture.
    try {
      const promise=startPreview(source,$('centered').checked);
      promise.catch(e=>{$('status').textContent='Pratinjau gagal: '+e.message;});
    } catch(e) {$('status').textContent='Pratinjau gagal: '+e.message;}
    return;
  }
  const token=++generation;
  running=true;clearResult();
  file.disabled=run.disabled=$('options').disabled=true;
  cancel.hidden=false;bar.hidden=false;bar.removeAttribute('value');
  const video=document.querySelector('input[name="mode"]:checked').value==='video';
  showStage('Menyiapkan pekerjaan…','start');
  (async()=>{
    try {
      if(stem==='dialog-export') {
        const done=await task('worker.js',{action:'dialog-export',source,centered:$('centered').checked,video},token);
        if(token!==generation) return;
        resultFile(done.blob,source,'dialog',done.ext);
      } else {
        const extracted=await task('worker.js',{action:'extract',source},token);
        if(token!==generation) return;
        showStage('FFmpeg dilepas. Menyiapkan mesin vokal…','handoff');
        // A macrotask boundary gives the browser a chance to release old Worker resources.
        await new Promise(resolve=>setTimeout(resolve,0));
        const separated=await task('demucs-worker.js',{pcm:extracted.blob,stem},token);
        if(token!==generation) return;
        if(video) {
          showStage('HTDemucs dilepas. Menyiapkan hasil video…','handoff');
          await new Promise(resolve=>setTimeout(resolve,0));
          const done=await task('worker.js',{action:'mux',source,pcm:separated.blob},token);
          if(token!==generation) return;
          resultFile(done.blob,source,stem,done.ext);
        } else {
          // WAV avoids loading a second FFmpeg runtime just for audio output.
          resultFile(wavFromPcm(separated.blob),source,stem,'wav');
        }
      }
      if(token===generation){forget();idle('Selesai. Hasil siap diputar atau disimpan.');}
    } catch(e) {
      if(token===generation) {
        forget();idle('Gagal: '+(e?.message||'Terjadi masalah ketika memproses file.'));
      }
    }
  })();
});

// If iOS killed the tab, show the last stage on reload instead of pretending success.
try {
  const previous=JSON.parse(sessionStorage.getItem(stateKey)||'null');
  if(previous&&Date.now()-previous.time<20*60*1000) {
    $('status').textContent='Pekerjaan sebelumnya berhenti saat tahap "'+previous.phase+'". Jika halaman otomatis refresh, kemungkinan browser kehabisan memori. Pilih Dialog ringan atau gunakan komputer.';
  }
  forget();
} catch(_) {}
updateMode();
