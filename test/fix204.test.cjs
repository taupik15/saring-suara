'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'uvr-live-worker.js'),'utf8');
const ui=fs.readFileSync(path.join(root,'uvr-live.js'),'utf8');
const installer=fs.readFileSync(path.join(root,'scripts/install-uvr-lite.sh'),'utf8');
function mockWorker({gpu=false,webgpuFails=false}={}) {
  let context,loaded=[];const messages=[];
  const session={inputNames:['input'],outputNames:['output'],inputMetadata:{input:{dims:[1,4,2048,256]}},async run(feeds){return {output:{data:feeds.input.data}};}};
  const makeRuntime=()=>({env:{wasm:{}},InferenceSession:{async create(url,opts){if(webgpuFails && opts.executionProviders[0]==='webgpu')throw Error('unsupported WebGPU op');return session;}},Tensor:class Tensor{constructor(type,data,shape){this.data=data;assert.equal(type,'float32');assert.equal(shape.join(','),'1,4,2048,256');}}});
  const transformed=source.replace(/await import\('\.\/vendor-uvr\/ort\.(webgpu|wasm)\.min\.mjs'\)/g,(_,p)=>`await self.__testImport('${p}')`);
  assert.doesNotMatch(transformed,/await import\('/);
  context={self:{location:{href:'https://example.test/uvr-live-worker.js'},navigator:{gpu:gpu?{}:undefined},__testImport:async type=>{loaded.push(type);return makeRuntime();}},postMessage:(m)=>messages.push(m),performance,Float32Array,Uint16Array,Math,Number,URL,ArrayBuffer};
  vm.createContext(context);vm.runInContext(transformed,context);
  return {context,loaded,messages};
}
async function waitFor(arr,type){for(let i=0;i<300;i++){const r=arr.find(x=>x.type===type);if(r)return r;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('no '+type+' in '+JSON.stringify(arr));}

test('Module Worker is used, no importScripts remains, ESM paths self-hosted',()=>{
  assert.match(ui,/new Worker\('\.\/uvr-live-worker\.js',\{type:'module'\}\)/);
  assert.doesNotMatch(source,/importScripts\(/);
  assert.match(source,/import\('\.\/vendor-uvr\/ort\.webgpu\.min\.mjs'\)/);
  assert.match(source,/import\('\.\/vendor-uvr\/ort\.wasm\.min\.mjs'\)/);
  assert.match(installer,/ort\.wasm\.min\.mjs ort\.webgpu\.min\.mjs/);
  assert.match(installer,/onnxruntime-web@1\.23\.2/);
});
test('WASM-only environment never initializes GPU',async()=>{
  const w=mockWorker();w.context.self.onmessage({data:{type:'init'}});
  const ready=await waitFor(w.messages,'ready');
  assert.equal(ready.backend,'wasm');assert.match(ready.gpuFallbackReason,/WebGPU tidak tersedia/);
  assert.deepEqual(w.loaded,['wasm']);
});
test('WebGPU session is used only if ready',async()=>{
  const w=mockWorker({gpu:true});w.context.self.onmessage({data:{type:'init'}});
  const ready=await waitFor(w.messages,'ready');
  assert.equal(ready.backend,'webgpu');assert.equal(ready.gpuFallbackReason,'');
  assert.deepEqual(w.loaded,['webgpu']);
});
test('GPU failure safely switches to CPU module and reports reason',async()=>{
  const w=mockWorker({gpu:true,webgpuFails:true});w.context.self.onmessage({data:{type:'init'}});
  const ready=await waitFor(w.messages,'ready');
  assert.equal(ready.backend,'wasm');assert.match(ready.gpuFallbackReason,/unsupported WebGPU op/);
  assert.deepEqual(w.loaded,['webgpu','wasm']);
});
test('Module Worker retained spectral reconstruction and phase profiling',async()=>{
  const w=mockWorker();w.context.self.onmessage({data:{type:'init'}});await waitFor(w.messages,'ready');
  const n=262144,rate=44100,a=new Float32Array(n),b=new Float32Array(n);
  for(let i=0;i<n;i++){a[i]=.2*Math.sin(i*2*Math.PI*110/rate);b[i]=.12*Math.sin(i*2*Math.PI*220/rate);}
  w.context.self.onmessage({data:{type:'chunk',index:0,left:a.buffer,right:b.buffer,rate}});
  const m=await waitFor(w.messages,'result');
  assert.equal(m.index,0);assert.ok(Number.isFinite(m.timings.inferenceMs));
  let top=0,base=0;const aa=new Float32Array(m.left),bb=new Float32Array(m.right);
  for(let i=2048;i<n-2048;i+=64){top+=(aa[i]-a[i])**2+(bb[i]-b[i])**2;base+=a[i]**2+b[i]**2;}
  assert.ok(Math.sqrt(top/base)<.0001);
});
