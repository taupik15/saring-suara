/* Dedicated model worker: never shares an active FFmpeg WebAssembly runtime. */
let started=false;
onmessage=async ({data})=>{
  if(started) return;
  started=true;
  try {
    importScripts('separation.js');
    const blob=await separatePcm(data.pcm,data.stem);
    postMessage({blob,kind:'pcm',phase:'separated'});
  } catch(e) {
    postMessage({error:e?.message || String(e),phase:'demucs'});
  }
};
