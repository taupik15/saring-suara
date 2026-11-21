/* FFmpeg-only worker. The worker is terminated before the Demucs worker starts. */
let busy = false;
self.onmessage = async ({data}) => {
  if (busy) return;
  busy = true;
  const {action, source, pcm, centered} = data;
  try {
    postMessage({message:'Memulai FFmpeg WebAssembly…',phase:'ffmpeg-init'});
    importScripts('vendor/ffmpeg-core.js');
    const wasmURL = new URL('vendor/ffmpeg-core.wasm',location.href).href;
    const core = await createFFmpegCore({mainScriptUrlOrBlob:'#'+btoa(JSON.stringify({wasmURL}))});
    const fs = core.FS;
    core.setProgress(({progress}) => {
      if (Number.isFinite(progress)) postMessage({message:'FFmpeg sedang bekerja…',progress:Math.max(0,Math.min(1,progress)),phase:action});
    });
    fs.mkdir('/source');
    fs.mount(fs.filesystems.WORKERFS,{blobs:[{name:'input',data:source}]},'/source');

    if (action === 'extract') {
      postMessage({message:'Membaca audio sumber…',phase:'extract'});
      const take = outputFile(fs,'mix.pcm');
      const code = core.exec('-i','/source/input','-map','0:a:0','-vn','-af','aresample=44100:first_pts=0','-ar','44100','-ac','2','-f','s16le','mix.pcm');
      if (code) throw Error('Tidak dapat membaca trek audio. Coba MP4/H.264 atau audio MP3/M4A.');
      const blob = take('application/octet-stream');
      if (!blob.size || blob.size % 4) throw Error('Trek audio tidak tersedia atau format PCM tidak valid.');
      postMessage({blob,kind:'pcm',phase:'extracted'});
    } else if (action === 'mux') {
      if (!pcm || !pcm.size || pcm.size % 4) throw Error('Data vokal tidak valid.');
      fs.mkdir('/stem');
      fs.mount(fs.filesystems.WORKERFS,{blobs:[{name:'output',data:pcm}]},'/stem');
      const args=['-i','/source/input','-f','s16le','-ar','44100','-ac','2','-i','/stem/output','-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','192k','-shortest','-movflags','+faststart'];
      postMessage({message:'Menggabungkan vokal dengan video…',phase:'mux'});
      const take=outputFile(fs,'out.mp4');
      const code=core.exec(...args,'out.mp4');
      if (code) throw Error('Tidak dapat membuat MP4. Codec video sumber mungkin tidak kompatibel; coba keluaran Audio saja.');
      const blob=take('video/mp4');
      if(!blob.size) throw Error('Hasil video kosong.');
      postMessage({blob,kind:'file',ext:'mp4',phase:'finished'});
    } else if (action === 'dialog-export') {
      const response=await fetch('vendor/voice.rnnn');
      if (!response.ok) throw Error('Model RNNoise tidak dapat dimuat.');
      fs.writeFile('voice.rnnn',new Uint8Array(await response.arrayBuffer()));
      // Centered mode uses a stereo mid-side spectral mask; otherwise use RNNoise.
      const mid='pow(real(b,0),2)+pow(imag(b,0),2)';
      const side='pow(real(b,1),2)+pow(imag(b,1),2)';
      const mask='max(0.10,1-('+side+')/(1e-12+'+mid+'))';
      const filter=centered
        ? "aresample=48000,aformat=channel_layouts=stereo,pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0-0.5*c1,"+
          "afftfilt=real='re*"+mask+"|0':imag='im*"+mask+"|0':win_size=1024:overlap=0.75,pan=mono|c0=c0"
        : 'aresample=48000,arnndn=m=voice.rnnn';
      const video=!!data.video;
      const args=['-i','/source/input','-map','0:a:0','-af',filter,'-c:a','aac','-b:a','128k'];
      if (video) args.push('-map','0:v:0','-c:v','copy','-movflags','+faststart');
      const ext=video?'mp4':'m4a';
      const take=outputFile(fs,'out.'+ext);
      postMessage({message:'Menyaring dialog dengan FFmpeg…',phase:'dialog-export'});
      const code=core.exec(...args,'out.'+ext);
      if (code) throw Error('Ekspor dialog gagal. Coba file lain atau pratinjau Dialog ringan.');
      const blob=take(video?'video/mp4':'audio/mp4');
      if(!blob.size) throw Error('Hasil ekspor dialog kosong.');
      postMessage({blob,kind:'file',ext,phase:'finished'});
    } else {
      throw Error('Perintah worker tidak dikenal.');
    }
  } catch(e) {
    postMessage({error:e?.message || String(e),phase:action || 'ffmpeg'});
  } finally {busy=false;}
};

/* Write FFmpeg output in 2 MiB Blob pages, not one growing Uint8Array. */
function outputFile(fs,path) {
  const size=2*1024*1024;
  const pages=[];
  const buffer=new Uint8Array(size);
  let active=-1;
  const node=fs.create(path);
  function flush() {
    if (active<0) return;
    const count=Math.min(size,node.usedBytes-active*size);
    pages[active]=new Blob([buffer.subarray(0,count)]);
    active=-1;
  }
  const reader=new FileReaderSync();
  node.stream_ops={...node.stream_ops,write(stream,src,offset,length,position) {
    let copied=0;
    while(copied<length) {
      const at=position+copied, page=Math.floor(at/size), start=at%size;
      if(page!==active) {
        flush(); buffer.fill(0);
        if(pages[page]) buffer.set(new Uint8Array(reader.readAsArrayBuffer(pages[page])));
        active=page;
      }
      const count=Math.min(length-copied,size-start);
      buffer.set(src.subarray(offset+copied,offset+copied+count),start);
      copied+=count;
      node.usedBytes=Math.max(node.usedBytes,position+copied);
    }
    return length;
  }};
  return type=>{flush();return new Blob(pages,{type});};
}
