importScripts('vendor/ffmpeg-core.js');
onmessage = async ({data:{source,mode,centered,stem}}) => {
  try {
    const wasmURL = new URL('vendor/ffmpeg-core.wasm',location.href).href;
    const core = await createFFmpegCore({mainScriptUrlOrBlob:'#'+btoa(JSON.stringify({wasmURL}))});
    const response = await fetch('vendor/voice.rnnn');
    if (!response.ok) throw Error('Model suara gagal dimuat.');
    core.FS.writeFile('voice.rnnn',new Uint8Array(await response.arrayBuffer()));
    const fs = core.FS;
    fs.mkdir('/source');
    fs.mount(fs.filesystems.WORKERFS, {blobs:[{name:'input',data:source}]}, '/source');
    // Compare mid and side energy in each frequency bin to isolate centered dialogue.
    const mid = 'pow(real(b,0),2)+pow(imag(b,0),2)';
    const side = 'pow(real(b,1),2)+pow(imag(b,1),2)';
    const mask = 'max(0.10,1-(' + side + ')/(1e-12+' + mid + '))';
    const filter = centered
      ? "aresample=48000,aformat=channel_layouts=stereo,pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0-0.5*c1," +
        "afftfilt=real='re*" + mask + "|0':imag='im*" + mask + "|0':win_size=1024:overlap=0.75,pan=mono|c0=c0"
      : 'aresample=48000,arnndn=m=voice.rnnn';
    const song = stem === 'vokal' || stem === 'instrumen';
    if (song) {
      importScripts('separation.js');
      await separateSong(core,stem);
      postMessage({message:'Menyimpan hasil…'});
    }
    core.setProgress(({progress}) => postMessage({message:'Menyaring suara…',progress}));
    const args = song
      ? ['-i','/source/input','-f','s16le','-ar','44100','-ac','2','-i','/stem/output','-map','1:a:0','-c:a','aac','-b:a','192k']
      : ['-i','/source/input','-map','0:a:0','-af',filter,'-c:a','aac','-b:a','128k'];
    let ext='m4a', type='audio/mp4';
    if (mode==='video') {
      args.push('-map','0:V:0','-c:v','copy');
      ext='mp4'; type='video/mp4';
    }
    let output = outputFile(fs,'out.'+ext);
    let code=core.exec(...args,'out.'+ext);
    if (code && mode==='video') {
      core.reset(); ext='mkv'; type='video/x-matroska';
      output = outputFile(fs,'out.'+ext);
      code=core.exec(...args,'out.mkv');
    }
    if (code) throw Error('Gagal membaca trek yang diperlukan. Pastikan file berisi suara dan pilih keluaran yang sesuai.');
    postMessage({blob:output(type),ext});
  } catch(e) {postMessage({error:e?.message || 'Memori perangkat mungkin penuh.'});}
};

function outputFile(fs, path) {
  const size = 2 * 1024 * 1024;
  const pages = [];
  const buffer = new Uint8Array(size);
  let active = -1;
  const node = fs.create(path);
  function flush() {
    if (active < 0) return;
    const count = Math.min(size, node.usedBytes - active * size);
    pages[active] = new Blob([buffer.subarray(0, count)]);
    active = -1;
  }
  const reader = new FileReaderSync();
  node.stream_ops = {...node.stream_ops, write(stream, src, offset, length, position) {
    let copied = 0;
    while (copied < length) {
      const at = position + copied;
      const page = Math.floor(at / size);
      const start = at % size;
      if (page !== active) {
        flush();
        buffer.fill(0);
        if (pages[page]) buffer.set(new Uint8Array(reader.readAsArrayBuffer(pages[page])));
        active = page;
      }
      const count = Math.min(length - copied, size - start);
      buffer.set(src.subarray(offset + copied, offset + copied + count), start);
      copied += count;
      node.usedBytes = Math.max(node.usedBytes, position + copied);
    }
    return length;
  }};
  return type => {
    flush();
    return new Blob(pages, {type});
  };
}
