/* Fix 1: isolate the heavy runtimes, add a no-FFmpeg preview and diagnostics. */
'use strict';
const $=id=>document.getElementById(id);
const file=$('file'), run=$('run'), cancel=$('cancel'), result=$('result');
const bar=document.querySelector('progress');
const isIOS=/iPad|iPhone|iPod/.test(navigator.userAgent)||
  (navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
let activeWorker=null, rejectActive=null, currentURL=null, audioContext=null, centerNode=null, aiController=null, rnnoiseController=null, speechGate=null, uvrController=null, generation=0, running=false;
let detachPlayback=null;
const stateKey='saring-suara-fix1-last-stage';

// Local checkpoints contain only file metadata, position and slider values.
// Browsers cannot automatically re-open a local file after a reload.
const playbackKey='saring-suara-playback-fix13';
const settingsKey='saring-suara-controls-fix13';
const gateSettingsKey='saring-suara-gate-fix18';
function jsonFromStorage(key) {
  try {return JSON.parse(localStorage.getItem(key)||'null');} catch (_) {return null;}
}
function clampNumber(value,min,max,fallback) {
  return Number.isFinite(value)?Math.max(min,Math.min(max,value)):fallback;
}
function savedControls() {
  const s=jsonFromStorage(settingsKey)||{};
  return {stereo:clampNumber(s.stereo,0,100,85),
    center:clampNumber(s.center,0,100,35),
    vocal:clampNumber(s.vocal,-12,12,4),
    gtcrnMix:clampNumber(s.gtcrnMix,0,100,25),
    rnnoiseMix:clampNumber(s.rnnoiseMix,0,100,25)};
}
function saveControls(values) {
  try {localStorage.setItem(settingsKey,JSON.stringify(values));} catch (_) {}
}
function checkpoint() {
  const c=jsonFromStorage(playbackKey);
  if(!c||typeof c.name!=='string'||!Number.isFinite(c.position)||c.position<3||
    !Number.isFinite(c.duration)||c.duration<=0||c.position>=c.duration-3||
    !Number.isFinite(c.updated)||Date.now()-c.updated>90*24*3600*1000) return null;
  return c;
}
function sameSource(saved,source) {
  return !!saved&&!!source&&saved.name===source.name&&saved.size===source.size&&
    (!saved.modified||!source.lastModified||saved.modified===source.lastModified);
}
function clockTime(seconds) {
  const n=Math.floor(Math.max(0,seconds));
  const h=Math.floor(n/3600),m=Math.floor(n%3600/60),s=n%60;
  return (h?h+':':'')+String(m).padStart(h?2:1,'0')+':'+String(s).padStart(2,'0');
}
function showResumeInfo() {
  const item=$('resumeInfo');
  if(!item)return;
  const saved=checkpoint(),source=file.files[0];
  item.hidden=!saved;
  if(!saved)return;
  if(!source) item.textContent='Posisi terakhir '+clockTime(saved.position)+' pada '+saved.name+
    ' tersimpan. Pilih ulang file yang sama setelah refresh.';
  else if(sameSource(saved,source)) item.textContent='Posisi '+clockTime(saved.position)+
    ' ditemukan. Pilih mode pemutaran dan tekan Jalankan untuk menampilkan tombol Lanjutkan.';
  else item.textContent='Posisi tersimpan untuk '+saved.name+' ('+clockTime(saved.position)+
    '). Pilih file itu kembali untuk melanjutkan.';
}
// Attach to live players, not exported files. Resume requires choosing the same
// local file again, and never starts automatically at the old position.
function attachPlayback(player,source,mode,host) {
  const saved=checkpoint();
  const canResume=sameSource(saved,source);
  let lastWrite=0,ended=false;
  const save=(force=false)=>{
    if(ended||!Number.isFinite(player.currentTime)||player.currentTime<0||
       !Number.isFinite(player.duration)||player.duration<=0)return;
    const now=Date.now();
    if(!force&&now-lastWrite<4000)return;
    lastWrite=now;
    if(player.currentTime>=player.duration-3){
      try {localStorage.removeItem(playbackKey);} catch (_) {}
      showResumeInfo();
      return;
    }
    try {localStorage.setItem(playbackKey,JSON.stringify({
      name:source.name,size:source.size,modified:source.lastModified||0,
      position:player.currentTime,duration:player.duration,mode,updated:now
    }));} catch (_) {}
  };
  const onEnd=()=>{
    ended=true;
    const old=checkpoint();
    if(sameSource(old,source))try{localStorage.removeItem(playbackKey);}catch(_){}
    showResumeInfo();
  };
  const onHidden=()=>{if(document.visibilityState==='hidden')save(true);};
  const onPageHide=()=>save(true);
  player.addEventListener('timeupdate',()=>save(false));
  player.addEventListener('pause',()=>save(true));
  player.addEventListener('seeked',()=>save(true));
  player.addEventListener('ended',onEnd);
  document.addEventListener('visibilitychange',onHidden);
  window.addEventListener('pagehide',onPageHide);
  detachPlayback=()=>{
    save(true);
    document.removeEventListener('visibilitychange',onHidden);
    window.removeEventListener('pagehide',onPageHide);
    detachPlayback=null;
  };
  if(!canResume)return false;
  const notice=document.createElement('div');notice.className='note resume-actions';
  const label=document.createElement('span');
  label.textContent='Sesi sebelumnya: '+clockTime(saved.position)+'. ';
  const button=document.createElement('button');
  button.type='button';button.textContent='Lanjutkan dari '+clockTime(saved.position);
  // Wait for metadata to avoid seeking an unknown duration on Safari.
  button.disabled=player.readyState<1;
  player.addEventListener('loadedmetadata',()=>{button.disabled=false;});
  button.addEventListener('click',()=>{
    if(!Number.isFinite(player.duration)||player.duration<=0)return;
    const position=Math.max(0,Math.min(saved.position,player.duration-2));
    player.currentTime=position;
    button.disabled=true;
    label.textContent='Melanjutkan dari '+clockTime(position)+'. ';
    if(audioContext)audioContext.resume().catch(()=>{});
    const playing=player.play();
    if(playing?.catch)playing.catch(e=>{$('status').textContent='Tekan Play pada video: '+(e?.message||'pemutaran memerlukan interaksi.');});
  });
  notice.append(label,button);
  host.prepend(notice);
  return true;
}

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
  if(uvrController){try{uvrController.destroy();}catch(_){}uvrController=null;}
  if(speechGate){try{speechGate.node.disconnect();speechGate.node.port?.close?.();}catch(_){}speechGate=null;}
  if(rnnoiseController){try{rnnoiseController.destroy();}catch(_){}rnnoiseController=null;}
  if(aiController){try{aiController.destroy();}catch(_){}aiController=null;}
  if(detachPlayback)detachPlayback();
  if(centerNode){try{centerNode.disconnect();centerNode.port.onmessage=null;}catch(_){}centerNode=null;}
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
  const preview=stem==='dialog-preview'||stem==='center-live'||stem==='rnnoise-live';
  $('dialogOptions').hidden=song||stem==='center-live'||stem==='rnnoise-live';
  $('centerHint').hidden=stem!=='center-live'&&stem!=='rnnoise-live';
  $('hint').hidden=!song;
  $('modeOptions').hidden=preview;
  $('previewHint').hidden=!preview;
  $('heavyGuard').hidden=!(isIOS&&song);
  $('exportWarning').hidden=stem!=='dialog-export';
}

// HTDemucs cannot be used reliably on iPhone: block it rather than baiting users
// into a repeatable tab-killing memory allocation. Desktop still has it.
if(isIOS){
  for(const opt of $('stem').options) if(opt.value==='vokal'||opt.value==='instrumen'){
    opt.disabled=true;opt.textContent+=' · tidak tersedia di iPhone';
  }
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
  showResumeInfo();
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
  const hasResume=attachPlayback(player,source,'dialog-preview',result);
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
  const play=hasResume?Promise.resolve():player.play();
  return Promise.allSettled([resume,play]).then(([,playState])=>{
    if(playState.status==='rejected') {
      const error=playState.reason;
      if(error?.name==='NotAllowedError') $('status').textContent='Pratinjau siap. Tekan Play pada video untuk memulai suara yang difilter.';
      else $('status').textContent='Tidak dapat memutar file: '+(error?.message||'Codec media tidak didukung.');
    } else $('status').textContent=hasResume?'Pratinjau siap. Pilih Lanjutkan untuk kembali ke posisi terakhir.':'Pratinjau Dialog ringan aktif (tanpa FFmpeg).';
  });
}

// Real-time stereo mid/side spectral masking via a dedicated AudioWorklet.
// This targets music spread across stereo channels; it is not an AI separator.
// No giant model, no FFmpeg and no full-file conversion are involved.
async function startCenterPreview(source,autoRNNoise=false){
  clearResult();
  currentURL=URL.createObjectURL(source);
  const player=document.createElement(isVideo(source)?'video':'audio');
  player.controls=true;player.playsInline=true;player.preload='metadata';
  player.src=currentURL;
  const note=document.createElement('p');note.className='note';
  note.textContent=autoRNNoise ? 'Video diputar langsung dengan filter stereo dan RNNoise-WASM opsional. RNNoise menekan noise, bukan menjamin musik hilang.' : 'Filter stereo dan penekan musik tengah adaptif berjalan saat video diputar. Ini bukan AI: musik yang bercampur dengan dialog tetap dapat terdengar.';
  const controls=document.createElement('div');controls.className='live-controls';
  const defaults=savedControls();
  const text=document.createElement('label');text.textContent='Kekuatan peredaman stereo: ';
  const strength=document.createElement('input');strength.type='range';strength.min='0';strength.max='100';strength.step='5';strength.value=String(defaults.stereo);
  const percent=document.createElement('span');percent.textContent=defaults.stereo+'%';
  text.append(strength,percent);
  // Separate control for music that is also located in the stereo center.
  // Its adaptive spectral floor helps for sustained music; voice may get thinner.
  const centerText=document.createElement('label');
  centerText.textContent='Redam musik di tengah (eksperimental): ';
  const centerStrength=document.createElement('input');
  centerStrength.type='range';centerStrength.min='0';centerStrength.max='100';
  centerStrength.step='5';centerStrength.value=String(defaults.center);
  const centerPercent=document.createElement('span');centerPercent.textContent=defaults.center+'%';
  centerText.append(centerStrength,centerPercent);
  const centerCaution=document.createElement('small');
  centerCaution.textContent='Melemahkan komponen suara yang stabil di tengah. ' +
    'Mulai 35%; 70–100% lebih agresif tetapi suara dialog dapat ikut tipis. ' +
    'Musik dan dialog yang benar-benar tumpang tindih tidak dapat dipisahkan sempurna tanpa model AI.';
  // Post-filter vocal enhancement. It never reintroduces the unfiltered input.
  const vocalText=document.createElement('label');
  vocalText.textContent='Level dialog / vokal setelah musik diredam (−12 hingga +12 dB): ';
  const vocalBoost=document.createElement('input');vocalBoost.type='range';
  vocalBoost.min='-12';vocalBoost.max='12';vocalBoost.step='1';
  vocalBoost.value=String(defaults.vocal);
  const vocalValue=document.createElement('span');vocalValue.textContent=(defaults.vocal>0?'+':'')+defaults.vocal+' dB';
  vocalText.append(vocalBoost,vocalValue);
  const vocalNote=document.createElement('small');
  vocalNote.textContent='Mengatur level keluaran setelah peredaman musik dan AI (jika aktif). Sisa musik yang belum hilang juga dapat ikut berubah volumenya.';
  const compare=document.createElement('label');
  const original=document.createElement('input');original.type='checkbox';
  compare.append(original,document.createTextNode(' Bandingkan campuran tanpa peredaman (mono, masih melalui EQ)'));
  // Optional real neural inference; off until explicitly enabled to protect iPhone RAM.
  const aiSection=document.createElement('div');aiSection.className='ai-controls';
  const aiLabel=document.createElement('label');
  const aiSwitch=document.createElement('input');aiSwitch.type='checkbox';aiSwitch.id='aiEnabled';
  aiLabel.append(aiSwitch,document.createTextNode(' AI penjernih GTCRN (opsional)'));
  const aiStrengthLabel=document.createElement('label');aiStrengthLabel.textContent='Campuran AI (0% = suara filter sebelumnya): ';
  const aiStrength=document.createElement('input');aiStrength.type='range';aiStrength.min='0';aiStrength.max='100';
  aiStrength.step='5';aiStrength.value=String(defaults.gtcrnMix);
  const aiPercent=document.createElement('span');aiPercent.textContent=defaults.gtcrnMix+'%';
  aiStrengthLabel.append(aiStrength,aiPercent);aiStrengthLabel.hidden=true;
  const aiStatus=document.createElement('small');aiStatus.setAttribute('role','status');
  aiStatus.textContent='AI mati secara default. Hasil AI dicampur dengan suara filter sebelumnya; penghilangan musik tidak dijamin.';
  aiSection.append(aiLabel,aiStrengthLabel,aiStatus);
  // Separate real-time RNNoise control: processes the audio track as the video plays.
  const rnSection=document.createElement('div');rnSection.className='ai-controls';
  const rnLabel=document.createElement('label');
  const rnSwitch=document.createElement('input');rnSwitch.type='checkbox';rnSwitch.id='rnnoiseEnabled';
  rnLabel.append(rnSwitch,document.createTextNode(' RNNoise langsung · video tetap berjalan'));
  const rnMixLabel=document.createElement('label');
  rnMixLabel.textContent='Campuran RNNoise (0% = hasil filter sebelum RNNoise): ';
  const rnMix=document.createElement('input');rnMix.type='range';rnMix.min='0';rnMix.max='100';rnMix.step='5';
  rnMix.value=String(defaults.rnnoiseMix);
  const rnPercent=document.createElement('span');rnPercent.textContent=defaults.rnnoiseMix+'%';
  rnMixLabel.append(rnMix,rnPercent);rnMixLabel.hidden=!autoRNNoise;
  const rnStatus=document.createElement('small');rnStatus.setAttribute('role','status');
  rnStatus.textContent='RNNoise real-time mati. Tidak memakai FFmpeg atau mengekspor seluruh audio.';
  rnSection.append(rnLabel,rnMixLabel,rnStatus);
  // Smart gate receives VAD from RNNoise's running denoiser; energy is fallback.
  const gateSection=document.createElement('div');gateSection.className='ai-controls';
  const gateTitle=document.createElement('strong');gateTitle.textContent='Gerbang suara pintar · RNNoise VAD / energi';
  const gateInfo=document.createElement('small');gateInfo.setAttribute('role','status');
  gateInfo.textContent='RNNoise live aktif → VAD AI; RNNoise mati → energi adaptif. Gate mati secara default.';
  const gateMount=document.createElement('div');
  gateSection.append(gateTitle,gateInfo,gateMount);
  const uvrMount=document.createElement('div');
  controls.append(text,centerText,centerCaution,vocalText,vocalNote,compare,aiSection,rnSection,gateSection,uvrMount);
  result.append(player,note,controls);
  const hasResume=attachPlayback(player,source,'center-live',result);
  player.addEventListener('error',()=>{$('status').textContent='Codec file tidak didukung iPhone. Coba video MP4/H.264/AAC.';});
  const Context=window.AudioContext||window.webkitAudioContext;
  if(!Context)throw Error('Web Audio API tidak tersedia di browser.');
  let ctx;
  try {ctx=new Context({sampleRate:48000});} catch (_) {ctx=new Context();}
  audioContext=ctx;
  const sourceNode=ctx.createMediaElementSource(player);
  // Connect immediately, and call resume()/play() while still in user gesture.
  const highpass=ctx.createBiquadFilter();highpass.type='highpass';highpass.frequency.value=140;
  const lowpass=ctx.createBiquadFilter();lowpass.type='lowpass';lowpass.frequency.value=5800;
  const presence=ctx.createBiquadFilter();presence.type='peaking';presence.frequency.value=2300;presence.Q.value=0.8;presence.gain.value=2;
  const compressor=ctx.createDynamicsCompressor();compressor.threshold.value=-23;compressor.ratio.value=2.5;
  const voiceGain=ctx.createGain();
  const limiter=ctx.createDynamicsCompressor();
  limiter.threshold.value=-5;limiter.knee.value=1;limiter.ratio.value=18;
  limiter.attack.value=0.003;limiter.release.value=0.16;
  const applyVocalBoost=()=>{
    const db=Number(vocalBoost.value);
    vocalValue.textContent=(db>0?'+':'')+db+' dB';
    voiceGain.gain.setTargetAtTime(original.checked?1:Math.pow(10,db/20),ctx.currentTime,0.025);
    presence.gain.setTargetAtTime(original.checked?2:2+db/4,ctx.currentTime,0.025);
  };
  const persistControls=()=>saveControls({stereo:Number(strength.value),center:Number(centerStrength.value),vocal:Number(vocalBoost.value),gtcrnMix:Number(aiStrength.value),rnnoiseMix:Number(rnMix.value)});
  sourceNode.connect(highpass);highpass.connect(lowpass);lowpass.connect(presence);
  presence.connect(compressor);compressor.connect(voiceGain);voiceGain.connect(limiter);limiter.connect(ctx.destination);
  // Opt-in MDX 9482. Creates a second AUDIO-ONLY reader ahead of the video.
  // Never blocks or replaces the existing safe DSP / neural denoiser path.
  if(window.SaringUVR){
    try{uvrController=window.SaringUVR.create({
      context:ctx,player,sourceUrl:currentURL,upstream:limiter,mount:uvrMount,
      onStatus:()=>{}
    });}
    catch(err){uvrMount.textContent='UVR tidak siap: '+(err?.message||err);}
  }else{
    const warning=document.createElement('small');
    warning.textContent='Modul UVR tidak ditemukan. Filter lama tetap aktif.';
    uvrMount.append(warning);
  }
  // Insert speech gate AFTER either neural denoiser and vocal gain, BEFORE limiter.
  // Do not route from compressor: GTCRN/RNNoise already rewire compressor -> voiceGain.
  async function prepareGate() {
    if(!window.SpeechGate) {gateInfo.textContent='speech-gate.js belum dimuat. Suara tetap normal.';return;}
    const saved=jsonFromStorage(gateSettingsKey)||{};
    const params={enabled:false,
      thresholdDb:clampNumber(saved.thresholdDb,3,20,8),
      depthDb:clampNumber(saved.depthDb,-60,-6,-28),
      holdMs:clampNumber(saved.holdMs,0,500,200),
      releaseMs:clampNumber(saved.releaseMs,20,500,150),
      vadThreshold:clampNumber(saved.vadThreshold,0.2,0.9,0.5)};
    const created=await window.SpeechGate.create(ctx,params);
    if(audioContext!==ctx) {
      try{created.node.disconnect();created.node.port?.close?.();}catch(_){}return;
    }
    if(!created.supported) {
      gateInfo.textContent='Gerbang tidak didukung oleh Safari ini. Filter stereo tetap normal.';
      return;
    }
    speechGate=created;
    const setParams=created.setParams.bind(created);
    created.setParams=updates=>{
      setParams(updates);
      const {thresholdDb,depthDb,holdMs,releaseMs,vadThreshold}=created.params;
      try{localStorage.setItem(gateSettingsKey,JSON.stringify({thresholdDb,depthDb,holdMs,releaseMs,vadThreshold}));}catch(_){}
    };
    window.SpeechGate.mountControls(gateMount,created);
    voiceGain.disconnect(limiter);
    voiceGain.connect(created.node);
    created.node.connect(limiter);
    gateInfo.textContent='Gate siap. Aktifkan RNNoise live dan centang gate untuk menggunakan VAD AI. Tanpa RNNoise, energi adaptif otomatis.';
    player.addEventListener('seeking',()=>{try{created.node.port.postMessage({type:'reset'});}catch(_){}});
  }
  prepareGate().catch(error=>{if(audioContext===ctx)gateInfo.textContent='Gate tidak bisa diaktifkan: '+(error?.message||error);});
  if(window.SaringAI){
    aiController=window.SaringAI.create({
      context:ctx,upstream:compressor,downstream:voiceGain,
      onStatus:message=>{if(audioContext===ctx)aiStatus.textContent=message;},
      onFailure:()=>{if(audioContext===ctx){aiSwitch.checked=false;aiStrengthLabel.hidden=true;}}
    });
    aiController.setLevel(defaults.gtcrnMix);
    aiSwitch.onchange=()=>{
      if(audioContext!==ctx)return;
      if(aiSwitch.checked&&rnSwitch.checked){
        rnSwitch.checked=false;rnMixLabel.hidden=true;
        rnnoiseController?.enable(false); // Never run two speech denoisers in series.
      }
      aiStrengthLabel.hidden=!aiSwitch.checked;
      aiController?.enable(aiSwitch.checked);
    };
    aiStrength.oninput=()=>{
      aiPercent.textContent=aiStrength.value+'%';persistControls();
      aiController?.setLevel(Number(aiStrength.value));
    };
  }else {aiSwitch.disabled=true;aiStatus.textContent='Modul GTCRN tidak tersedia; filter stereo tetap berjalan.';}
  if(window.SaringRNNoise){
    rnnoiseController=window.SaringRNNoise.create({
      context:ctx,upstream:compressor,downstream:voiceGain,
      onStatus:message=>{if(audioContext===ctx)rnStatus.textContent=message;},
      onFailure:()=>{if(audioContext===ctx){rnSwitch.checked=false;rnMixLabel.hidden=true;speechGate?.setVad(null);}},
      onVad:score=>{if(audioContext===ctx)speechGate?.setVad(score);}
    });
    rnnoiseController.setLevel(defaults.rnnoiseMix);
    rnSwitch.onchange=()=>{
      if(audioContext!==ctx)return;
      if(rnSwitch.checked&&aiSwitch.checked){
        aiSwitch.checked=false;aiStrengthLabel.hidden=true;
        aiController?.enable(false);
      }
      rnMixLabel.hidden=!rnSwitch.checked;
      rnnoiseController?.enable(rnSwitch.checked);
    };
    rnMix.oninput=()=>{
      rnPercent.textContent=rnMix.value+'%';persistControls();
      rnnoiseController?.setLevel(Number(rnMix.value));
    };
  }else {
    rnSwitch.disabled=true;
    rnStatus.textContent='Berkas rnnoise-filter.js tidak ditemukan. Filter biasa tetap tersedia.';
  }
  applyVocalBoost();
  if(autoRNNoise&&rnnoiseController){rnSwitch.checked=true;rnnoiseController.enable(true);}

  // Wire controls before asynchronous AudioWorklet load, avoiding lost slider input.
  strength.oninput=()=>{
    percent.textContent=strength.value+'%';persistControls();
    if(centerNode&&audioContext===ctx)centerNode.port.postMessage({type:'strength',value:Number(strength.value)/100});
  };
  centerStrength.oninput=()=>{
    centerPercent.textContent=centerStrength.value+'%';persistControls();
    if(centerNode&&audioContext===ctx)centerNode.port.postMessage({type:'centerStrength',value:Number(centerStrength.value)/100});
  };
  vocalBoost.oninput=()=>{persistControls();applyVocalBoost();};
  const resume=ctx.resume();
  // Do not auto-play from 0 when a previous position is available.
  const play=hasResume?Promise.resolve():player.play();
  const prepare=async()=>{
    if(!ctx.audioWorklet||typeof AudioWorkletNode==='undefined')
      throw Error('AudioWorklet tidak tersedia pada browser ini.');
    await ctx.audioWorklet.addModule('voice-worklet.js');
    if(audioContext!==ctx) return;
    const node=new AudioWorkletNode(ctx,'saring-center-voice',{
      numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1],
      channelCount:2,channelCountMode:'max'
    });
    centerNode=node;
    node.port.onmessage=({data})=>{
      if(data?.type==='mono'&&audioContext===ctx){
        note.textContent='Audio mono: pemisahan kiri/kanan tidak tersedia, tetapi filter adaptif musik tengah masih bekerja terbatas. Dialog mungkin ikut berubah.';
      }
    };
    node.port.postMessage({type:'strength',value:Number(strength.value)/100});
    node.port.postMessage({type:'centerStrength',value:Number(centerStrength.value)/100});
    player.addEventListener('seeking',()=>{node.port.postMessage({type:'resetEstimator'});aiController?.reset?.();rnnoiseController?.reset?.();});
    original.onchange=()=>{
      if(original.checked){
        // Compare without an active neural filter; never claim the original
        // if RNNoise/GTCRN is still altering it.
        aiController?.enable(false);rnnoiseController?.enable(false);
        aiSwitch.checked=false;rnSwitch.checked=false;
        aiStrengthLabel.hidden=true;rnMixLabel.hidden=true;
      }
      node.port.postMessage({type:'bypass',value:original.checked});applyVocalBoost();
    };
    // Swap graph atomically: no two audible paths in parallel.
    sourceNode.disconnect();
    sourceNode.connect(node);node.connect(highpass);
    $('status').textContent=hasResume?'Filter siap. Tekan Lanjutkan untuk kembali ke posisi terakhir.':'Peredaman stereo dan musik tengah + penguat vokal aktif. Sisa musik masih mungkin terdengar.';
  };
  prepare().catch(e=>{
    if(audioContext===ctx){
      text.hidden=true;centerText.hidden=true;centerCaution.hidden=true;compare.hidden=true;
      note.textContent='Pemisahan spektral tidak dapat diaktifkan. Video tetap dapat diputar dengan EQ suara biasa.';
      $('status').textContent='Pemisahan spektral tidak tersedia: '+e.message+' Filter Dialog ringan tetap berjalan.';
    }
  });
  Promise.allSettled([resume,play]).then(([,p])=>{
    if(audioContext!==ctx)return;
    if(p.status==='rejected'){
      const msg=p.reason?.name==='NotAllowedError'?'Tekan Play pada video.':'Media gagal diputar: '+(p.reason?.message||'codec tidak didukung');
      $('status').textContent=msg;
    }
  });
}

run.addEventListener('click',()=>{
  const source=file.files[0];if(!source||running) return;
  const stem=$('stem').value;
  if((stem==='vokal'||stem==='instrumen')&&isIOS) {
    $('status').textContent='HTDemucs tidak dijalankan di iPhone karena terbukti membuat tab refresh. Gunakan Pemisahan pusat stereo atau komputer untuk HTDemucs.';
    return;
  }
  if(stem==='center-live'||stem==='rnnoise-live') {
    startCenterPreview(source,stem==='rnnoise-live').catch(e=>{$('status').textContent='Pratinjau gagal: '+e.message;});
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
showResumeInfo();
