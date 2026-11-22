'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {performance}=require('node:perf_hooks');
const path=require('node:path');
const root=path.join(__dirname,'..');
const source=fs.readFileSync(path.join(root,'uvr-live-worker.js'),'utf8');

function makeWorker({gpu=false,gpuFail=false}={}){
  const messages=[], imports=[];
  let sharedTensor=null;
  const fakeSession={
    inputNames:['input'],outputNames:['output'],
    inputMetadata:{input:{dims:[1,4,2048,256]}},
    async run(feeds){return {output:{data:feeds.input.data}};}
  };
  const ort={
    env:{wasm:{}},
    Tensor:class Tensor{constructor(type,data,shape){assert.equal(type,'float32');assert.deepEqual(Array.from(shape),[1,4,2048,256]);this.data=data;sharedTensor=data;}},
    InferenceSession:{async create(url,options){
      if(gpuFail&&options.executionProviders[0]==='webgpu')throw Error('unsupported operator');
      return fakeSession;
    }}
  };
  const context={
    self:{navigator:{gpu:gpu?{}:undefined},location:{href:'https://example.test/uvr-live-worker.js'}},
    performance,Float32Array,Uint16Array,Math,Number,URL,ArrayBuffer,ort:undefined,
    postMessage:(message)=>messages.push(message),
    importScripts:(file)=>{imports.push(file);context.ort=ort;}
  };
  vm.createContext(context);
  vm.runInContext(source,context);
  return {context,messages,imports,get sharedTensor(){return sharedTensor;}};
}
async function waitFor(messages,type,timeoutMs=2500){
  const end=Date.now()+timeoutMs;
  while(Date.now()<end){
    const msg=messages.find(msg=>msg.type===type);
    if(msg)return msg;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw Error('Timed out waiting for '+type+', got '+JSON.stringify(messages.map(m=>m.type)));
}

test('UVR reports Safari Worker WebGPU fallback accurately',async()=>{
  const worker=makeWorker();
  worker.context.self.onmessage({data:{type:'init'}});
  const msg=await waitFor(worker.messages,'ready');
  assert.equal(msg.backend,'wasm');
  assert.match(msg.gpuFallbackReason,/navigator\.gpu/);
  assert.equal(worker.imports.length,1);
  assert.match(worker.imports[0],/ort\.min\.js/);
});

test('UVR chooses WebGPU only if GPU session actually starts',async()=>{
  const gpu=makeWorker({gpu:true});
  gpu.context.self.onmessage({data:{type:'init'}});
  const ready=await waitFor(gpu.messages,'ready');
  assert.equal(ready.backend,'webgpu');
  assert.equal(ready.gpuFallbackReason,'');

  const fallback=makeWorker({gpu:true,gpuFail:true});
  fallback.context.self.onmessage({data:{type:'init'}});
  const slow=await waitFor(fallback.messages,'ready');
  assert.equal(slow.backend,'wasm');
  assert.match(slow.gpuFallbackReason,/unsupported operator/);
  assert.equal(fallback.imports.length,2);
});

test('UVR retains STFT accuracy and emits per-stage profiler data',async()=>{
  const worker=makeWorker();
  worker.context.self.onmessage({data:{type:'init'}});
  await waitFor(worker.messages,'ready');
  const rate=44100,size=262144;
  const left=new Float32Array(size),right=new Float32Array(size);
  for(let i=0;i<size;i++){
    left[i]=.2*Math.sin(i*2*Math.PI*110/rate);
    right[i]=.15*Math.sin(i*2*Math.PI*330/rate);
  }
  worker.context.self.onmessage({data:{type:'chunk',index:0,left:left.buffer,right:right.buffer,rate}});
  const m=await waitFor(worker.messages,'result',10000);
  assert.equal(m.index,0);
  assert.equal(m.left.byteLength,size*4);
  assert.ok(m.timings&&Number.isFinite(m.timings.inferenceMs));
  assert.ok(m.timings.totalMs>=m.timings.stftMs+m.timings.inferenceMs+m.timings.istftMs-5);
  const gotL=new Float32Array(m.left),gotR=new Float32Array(m.right);
  let numerator=0,denominator=0;
  for(let i=2048;i<size-2048;i+=64){
    numerator+=(gotL[i]-left[i])**2+(gotR[i]-right[i])**2;
    denominator+=left[i]**2+right[i]**2;
  }
  const error=Math.sqrt(numerator/denominator);
  assert.ok(error<0.0001,`STFT round-trip error ${error}`);
});

test('UVR controls retain bypass, heat guard and stage diagnostics',()=>{
  const control=fs.readFileSync(path.join(root,'uvr-live.js'),'utf8');
  assert.match(control,/MAX_MISSED=3/);
  assert.match(control,/MAX_SLOW=2/);
  assert.match(control,/showProfile\(m\)/);
  assert.match(control,/gpuFallbackReason/);
  assert.match(control,/onStatus/);
  assert.match(control,/restorePath\(\)/);
});
