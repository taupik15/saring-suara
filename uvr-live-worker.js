/* Saring Suara Fix 2.0 · experimental true MDX-Net stem inference.
 * Worker-only and single-inference bounded. No media is uploaded.
 * Input: stereo PCM 48 kHz via transfer. Output: predicted vocal stereo PCM.
 * MDX 9482: [1,4,2048,256], 44100 Hz, FFT=4096, hop=1024, vocals stem.
 */
'use strict';
const FS=4096,HOP=1024,FRAMES=256,BINS=2048,RATE=44100,LENGTH=FRAMES*HOP;
let session=null,active=false,initDone=false,backend='wasm';
let gpuFallbackReason='';
// Reuse scratch buffers: there is only one in-flight inference per worker.
const fftRe=new Float32Array(FS),fftIm=new Float32Array(FS);
const stftPlanes=new Float32Array(4*BINS*FRAMES);
const inputLeft=new Float32Array(LENGTH),inputRight=new Float32Array(LENGTH);
const inverseNorm=new Float32Array(LENGTH);
const reverse=new Uint16Array(FS),win=new Float32Array(FS);
for(let i=0;i<FS;i++){
  let p=i,v=0;for(let j=0;j<12;j++){v=(v<<1)|(p&1);p>>=1;}
  reverse[i]=v;
  win[i]=.5-.5*Math.cos(2*Math.PI*i/FS);
}
// Fixed MDX window positions: normalisation is identical for every chunk.
for(let t=0;t<FRAMES;t++){
  const start=t*HOP-FS/2;
  for(let n=0;n<FS;n++){const at=start+n;if(at>=0&&at<LENGTH)inverseNorm[at]+=win[n]*win[n];}
}
function fft(re,im,inverse=false){
  for(let i=0;i<FS;i++){const j=reverse[i];if(j>i){let t=re[i];re[i]=re[j];re[j]=t;t=im[i];im[i]=im[j];im[j]=t;}}
  for(let len=2;len<=FS;len*=2){
    const h=len/2,a=(inverse?2:-2)*Math.PI/len,wr=Math.cos(a),wi=Math.sin(a);
    for(let p=0;p<FS;p+=len){
      let cr=1,ci=0;
      for(let j=0;j<h;j++){
        const u=p+j,v=u+h;
        const tr=re[v]*cr-im[v]*ci,ti=re[v]*ci+im[v]*cr;
        re[v]=re[u]-tr;im[v]=im[u]-ti;
        re[u]+=tr;im[u]+=ti;
        const nc=cr*wr-ci*wi;ci=ci*wr+cr*wi;cr=nc;
      }
    }
  }
  if(inverse){for(let i=0;i<FS;i++){re[i]/=FS;im[i]/=FS;}}
}
function sample(arr,pos){
  if(pos<0)return arr[0]||0;
  if(pos>=arr.length-1)return arr[arr.length-1]||0;
  const i=Math.floor(pos),f=pos-i;return arr[i]*(1-f)+arr[i+1]*f;
}
function resample(src,sr,targetLen,targetRate=RATE,destination=null){
  const out=destination||new Float32Array(targetLen),ratio=sr/targetRate;
  for(let i=0;i<targetLen;i++)out[i]=sample(src,i*ratio);
  return out;
}
function spectrogram(left,right){
  // Plane order: [L_re,L_im,R_re,R_im], frequency-major, 256 frames.
  const data=stftPlanes;
  const re=fftRe,im=fftIm;
  for(let c=0;c<2;c++){
    const pcm=c?right:left;
    for(let t=0;t<FRAMES;t++){
      const start=t*HOP-FS/2;
      for(let n=0;n<FS;n++){
        const p=start+n;
        // Each position is at most 2048 samples outside the signal.
        const at=p<0?-p:(p>=LENGTH?2*LENGTH-2-p:p);
        re[n]=pcm[at]*win[n];im[n]=0;
      }
      fft(re,im);
      for(let k=0;k<BINS;k++){
        data[((2*c)*BINS+k)*FRAMES+t]=re[k];
        data[((2*c+1)*BINS+k)*FRAMES+t]=im[k];
      }
    }
  }
  return data;
}
function inverseSpectrogram(data){
  const channels=[];
  const re=fftRe,im=fftIm;
  const norm=inverseNorm;
  for(let c=0;c<2;c++){
    const out=new Float32Array(LENGTH);
    for(let t=0;t<FRAMES;t++){
      for(let k=0;k<BINS;k++){
        re[k]=data[((2*c)*BINS+k)*FRAMES+t];
        im[k]=data[((2*c+1)*BINS+k)*FRAMES+t];
      }
      // Discarded Nyquist bin from MDX contract. Enforce real-valued DC.
      im[0]=0;re[BINS]=0;im[BINS]=0;
      for(let k=1;k<BINS;k++){re[FS-k]=re[k];im[FS-k]=-im[k];}
      fft(re,im,true);
      const start=t*HOP-FS/2;
      for(let n=0;n<FS;n++){
        const p=start+n;
        if(p>=0&&p<LENGTH)out[p]+=re[n]*win[n];
      }
    }
    for(let i=0;i<LENGTH;i++)out[i]=Math.max(-1,Math.min(1,out[i]/Math.max(1e-7,norm[i])));
    channels.push(out);
  }
  return channels;
}
function shortError(error){
  return String(error?.message||error||'unknown').replace(/\s+/g,' ').slice(0,230);
}
async function loadRuntime(){
  let gpu=false;
  gpuFallbackReason='';
  try{
    gpu=!!self.navigator?.gpu;
    if(!gpu)gpuFallbackReason='navigator.gpu tidak tersedia di Web Worker Safari';
  }catch(e){gpuFallbackReason='Pemeriksaan WebGPU gagal: '+shortError(e);}
  if(gpu){
    try{importScripts('./vendor-uvr/ort.webgpu.min.js');backend='webgpu';}
    catch(e){gpu=false;gpuFallbackReason='Bundle WebGPU tidak bisa dimuat: '+shortError(e);}
  }
  if(!gpu){importScripts('./vendor-uvr/ort.min.js');backend='wasm';}
  if(typeof ort==='undefined')throw Error('ONNX Runtime Web gagal dimuat.');
  ort.env.wasm.numThreads=1;
  ort.env.wasm.proxy=false;
  ort.env.wasm.wasmPaths=new URL('./vendor-uvr/',self.location.href).href;
  const url=new URL('./vendor-uvr/UVR_MDXNET_9482.onnx',self.location.href).href;
  // Only call this WebGPU if the requested WebGPU provider *actually* loads.
  try{
    session=await ort.InferenceSession.create(url,{
      executionProviders:gpu?['webgpu']:['wasm'],graphOptimizationLevel:'basic'
    });
  }catch(err){
    if(!gpu)throw err;
    gpuFallbackReason='Sesi ONNX WebGPU gagal: '+shortError(err);
    // Safari may expose WebGPU but not the required operators or memory.
    // Preserve the existing single-thread WASM fallback.
    importScripts('./vendor-uvr/ort.min.js');backend='wasm';
    ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;
    ort.env.wasm.wasmPaths=new URL('./vendor-uvr/',self.location.href).href;
    session=await ort.InferenceSession.create(url,{executionProviders:['wasm'],graphOptimizationLevel:'basic'});
  }
  const meta=session.inputMetadata[session.inputNames[0]];
  const dims=meta?.dims||meta?.dimensions;
  if(dims&&dims.length===4&&Number(dims[2])!==BINS)throw Error('Model UVR tidak sesuai FFT 9482.');
  initDone=true;
  postMessage({type:'ready',backend,gpuFallbackReason,frames:FRAMES,chunkSeconds:LENGTH/RATE});
}
async function processChunk(message){
  if(!initDone||active){postMessage({type:'skip',index:message.index,reason:'AI sibuk'});return;}
  active=true;
  const start=performance.now();
  try{
    const a=new Float32Array(message.left),b=new Float32Array(message.right);
    const left=resample(a,message.rate,LENGTH,RATE,inputLeft);
    const right=resample(b,message.rate,LENGTH,RATE,inputRight);
    const t1=performance.now();
    const input=spectrogram(left,right);
    const t2=performance.now();
    const shape=[1,4,BINS,FRAMES];
    const tensor=new ort.Tensor('float32',input,shape);
    const outputs=await session.run({[session.inputNames[0]]:tensor});
    const t3=performance.now();
    const output=outputs[session.outputNames[0]];
    if(!output?.data||output.data.length!==input.length)throw Error('Output UVR tidak sesuai input.');
    const [vl,vr]=inverseSpectrogram(output.data);
    const t4=performance.now();
    const len=Math.ceil(message.rate*LENGTH/RATE);
    const ol=resample(vl,RATE,len,message.rate),or=resample(vr,RATE,len,message.rate);
    const end=performance.now();
    const timings={
      resampleInMs:Math.round(t1-start),
      stftMs:Math.round(t2-t1),
      inferenceMs:Math.round(t3-t2),
      istftMs:Math.round(t4-t3),
      resampleOutMs:Math.round(end-t4),
      totalMs:Math.round(end-start)
    };
    postMessage({type:'result',index:message.index,left:ol.buffer,right:or.buffer,
      rate:message.rate,ms:timings.totalMs,timings},[ol.buffer,or.buffer]);
  }catch(error){postMessage({type:'error',message:error?.message||String(error)});}
  finally{active=false;}
}
self.onmessage=({data})=>{
  if(data?.type==='init'){loadRuntime().catch(e=>postMessage({type:'error',message:e?.message||String(e),gpuFallbackReason}));}
  else if(data?.type==='chunk'){processChunk(data);}
  else if(data?.type==='stop') {session?.release?.();session=null;close();}
};
