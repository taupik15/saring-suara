/* Demucs-only pipeline: receives already-extracted stereo 44.1 kHz PCM. */
async function separatePcm(mix, stem) {
  if (!mix || !mix.size || mix.size % 4) throw Error('Audio PCM tidak valid.');
  postMessage({message:'Memuat model vokal HTDemucs…',phase:'model-init'});
  const model=await loadDemucs();
  const framesTotal=mix.size/4;
  const block=44100*28;
  const overlap=11025;
  const reader=new FileReaderSync();
  const pieces=[];
  let tail=null;
  for (let start=0;start<framesTotal;start+=block-overlap) {
    const end=Math.min(framesTotal,start+block);
    const pcm=new Int16Array(reader.readAsArrayBuffer(mix.slice(start*4,end*4)));
    postMessage({message:'Memisahkan '+stem+' · '+Math.floor(start/44100)+' / '+Math.ceil(framesTotal/44100)+' detik',phase:'separating',progress:start/framesTotal});
    const audio=isolateBlock(model,pcm,stem);
    if (tail) {
      for(let i=0;i<tail.length;i++) {
        const weight=Math.floor(i/2)/overlap;
        audio[i]=Math.round(tail[i]*(1-weight)+audio[i]*weight);
      }
    }
    const keep=end===framesTotal?audio.length:audio.length-2*overlap;
    pieces.push(new Blob([audio.subarray(0,keep)]));
    if(end===framesTotal) break;
    tail=audio.slice(keep);
  }
  return new Blob(pieces,{type:'application/octet-stream'});
}

async function loadDemucs() {
  importScripts('vendor/demucs_onnx_simd.js');
  const model=await libdemucs({locateFile:name=>new URL('vendor/'+name,location.href).href});
  const response=await fetch('vendor/htdemucs_ft_vocals.ort.gzipped');
  if(!response.ok) throw Error('Model vokal gagal dimuat (HTTP '+response.status+').');
  const weights=new Uint8Array(await response.arrayBuffer());
  const pointer=model._malloc(weights.length);
  if(!pointer) throw Error('Memori untuk model vokal tidak cukup.');
  try {
    model.HEAPU8.set(weights,pointer);
    model._modelInit(pointer,weights.length);
  } finally {model._free(pointer);}
  return model;
}

function isolateBlock(model,pcm,stem) {
  const frames=pcm.length/2;
  const pointers=[];
  try {
    for(let i=0;i<10;i++) {
      const ptr=model._malloc(frames*4);
      if(!ptr) throw Error('Memori perangkat tidak cukup untuk buffer HTDemucs.');
      pointers.push(ptr);
    }
    for(let ch=0;ch<2;ch++) {
      const offset=pointers[ch]/4;
      for(let i=0;i<frames;i++) model.HEAPF32[offset+i]=pcm[2*i+ch]/32768;
    }
    model._modelDemixSegment(pointers[0],pointers[1],frames,...pointers.slice(2),0,0,0,0,0,1,0);
    const out=new Int16Array(pcm.length);
    for(let ch=0;ch<2;ch++) {
      const offset=pointers[8+ch]/4;
      for(let i=0;i<frames;i++) {
        const k=2*i+ch;
        const v=model.HEAPF32[offset+i]*32768;
        const keep=stem==='vokal'?v:pcm[k]-v;
        out[k]=Math.max(-32768,Math.min(32767,Math.round(keep)));
      }
    }
    return out;
  } finally {for(const p of pointers) model._free(p);}
}
