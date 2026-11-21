// The Demucs runtime takes stereo float samples at 44.1 kHz and returns
// stereo stems in the order drums, bass, other, vocals.
async function separateSong(core, stem) {
  const fs = core.FS;
  postMessage({message:'Menyiapkan audio stereo…'});
  const decoded = outputFile(fs,'mix.pcm');
  if (core.exec('-i','/source/input','-map','0:a:0','-vn','-af','aresample=44100:first_pts=0','-ar','44100','-ac','2','-f','s16le','mix.pcm')) {
    throw Error('Trek audio gagal dibaca.');
  }
  core.reset();
  const mix = decoded('application/octet-stream');
  fs.unlink('mix.pcm');
  if (!mix.size) throw Error('Trek audio kosong.');
  postMessage({message:'Memuat model vokal HTDemucs…'});
  const model = await loadDemucs();
  const samples = mix.size / 4;
  const block = 44100 * 28;
  const overlap = 11025;
  const reader = new FileReaderSync();
  const pieces = [];
  let tail;
  for (let start = 0; start < samples; start += block - overlap) {
    const end = Math.min(samples,start + block);
    const pcm = new Int16Array(reader.readAsArrayBuffer(mix.slice(start*4,end*4)));
    postMessage({message:'Memisahkan ' + stem + ' · ' + Math.floor(start/44100) + ' dari ' + Math.ceil(samples/44100) + ' detik',progress:start/samples});
    const audio = isolateBlock(model,pcm,stem);
    if (tail) {
      for (let i=0;i<tail.length;i++) {
        const weight = Math.floor(i/2)/overlap;
        audio[i] = Math.round(tail[i]*(1-weight) + audio[i]*weight);
      }
    }
    const keep = end === samples ? audio.length : audio.length - 2*overlap;
    pieces.push(new Blob([audio.subarray(0,keep)]));
    if (end === samples) break;
    tail = audio.slice(keep);
  }
  fs.mkdir('/stem');
  fs.mount(fs.filesystems.WORKERFS,{blobs:[{name:'output',data:new Blob(pieces)}]},'/stem');
}

async function loadDemucs() {
  importScripts('vendor/demucs_onnx_simd.js');
  const model = await libdemucs({locateFile:name=>new URL('vendor/'+name,location.href).href});
  const response = await fetch('vendor/htdemucs_ft_vocals.ort.gzipped');
  if (!response.ok) throw Error('Model vokal gagal dimuat.');
  const weights = new Uint8Array(await response.arrayBuffer());
  const pointer = model._malloc(weights.length);
  if (!pointer) throw Error('Memori untuk model vokal tidak cukup.');
  try {
    model.HEAPU8.set(weights,pointer);
    model._modelInit(pointer,weights.length);
  } finally {model._free(pointer);}
  return model;
}

function isolateBlock(model, pcm, stem) {
  const frames = pcm.length/2;
  const pointers = [];
  try {
    for (let i=0;i<10;i++) {
      const ptr = model._malloc(frames*4);
      if (!ptr) throw Error('Memori HP tidak cukup untuk model ini.');
      pointers.push(ptr);
    }
    for (let ch=0;ch<2;ch++) {
      const offset = pointers[ch]/4;
      for (let i=0;i<frames;i++) model.HEAPF32[offset+i] = pcm[2*i+ch]/32768;
    }
    model._modelDemixSegment(pointers[0],pointers[1],frames,...pointers.slice(2),0,0,0,0,0,1,0);
    const result = new Int16Array(pcm.length);
    for (let ch=0;ch<2;ch++) {
      const offset = pointers[8+ch]/4;
      for (let i=0;i<frames;i++) {
        const index = 2*i+ch;
        const vocal = model.HEAPF32[offset+i] * 32768;
        const value = stem==='vokal' ? vocal : pcm[index]-vocal;
        result[index] = Math.max(-32768, Math.min(32767, Math.round(value)));
      }
    }
    return result;
  } finally {for (const pointer of pointers) model._free(pointer);}
}
