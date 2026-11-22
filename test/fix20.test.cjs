'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');

test('UVR experimental opt-in preserves safe sound path',()=>{
  const app=read('app.js');
  const page=read('index.html');
  const code=read('uvr-live.js');
  assert.match(page,/src="uvr-live.js"/);
  assert.match(app,/uvrController\.destroy\(\)/);
  assert.match(app,/upstream:limiter/);
  assert.match(code,/toggle\.checked=false/);
  assert.match(code,/player\.pause\(\)/);
  assert.match(code,/MAX_RTF=1\.15/);
  assert.match(code,/return to filter|filter sebelumnya|Filter lama/i);
});

test('Worker uses actual 9482 spectrogram contract and correct signed residual',()=>{
  const code=read('uvr-live-worker.js');
  assert.match(code,/FRAMES=256,BINS=2048,RATE=44100/);
  assert.match(code,/shape=\[1,4,BINS,FRAMES\]/);
  assert.match(code,/session\.run/);
  const scope={self:{location:{href:'https://example.test/uvr-live-worker.js'}},postMessage(){},performance,Float32Array,Uint16Array,Math,Number,URL,ArrayBuffer};
  vm.createContext(scope);vm.runInContext(code,scope);
  // Full STFT+iSTFT identity ensures the fallback never invents stems.
  const result=vm.runInContext(`(()=>{
    const N=LENGTH;
    const l=new Float32Array(N),r=new Float32Array(N);
    for(let i=0;i<N;i++){l[i]=.2*Math.sin(2*Math.PI*110*i/RATE);r[i]=.16*Math.sin(2*Math.PI*330*i/RATE);}
    const [a,b]=inverseSpectrogram(spectrogram(l,r));
    let err=0,power=0;
    for(let i=2048;i<N-2048;i+=16){err+=(a[i]-l[i])**2+(b[i]-r[i])**2;power+=l[i]**2+r[i]**2;}
    return Math.sqrt(err/power);
  })()`,scope);
  assert.ok(result<0.0001,`FFT inversion relative error: ${result}`);
});

test('AudioWorklet collector has a fixed max buffer and zero audible output',()=>{
  let registered=null,events=[];
  class AWP {constructor(){this.port={onmessage:null,postMessage:(v)=>events.push(v)};}}
  const scope={AudioWorkletProcessor:AWP,registerProcessor:(id,ctor)=>{assert.equal(id,'saring-uvr-tap');registered=ctor;},sampleRate:48000,Float32Array,Math};
  vm.createContext(scope);vm.runInContext(read('uvr-tap-worklet.js'),scope);
  const p=new registered();
  assert.ok(p.size>280000&&p.size<300000);
  for(let j=0;j<Math.ceil(p.size/128);j++){
    const input=new Float32Array(128).fill(.1),output=[new Float32Array(128),new Float32Array(128)];
    p.process([ [input,input] ],[output]);
    assert.equal(output[0][0],0);
  }
  assert.equal(events.length,1);
  assert.equal(events[0].index,0);
  assert.equal(events[0].type,'chunk');
});

test('GitHub Pages workflow bundles verified UVR model at deploy time',()=>{
  const workflow=read('.github/workflows/deploy-pages.yml');
  const installer=read('scripts/install-uvr-lite.sh');
  assert.match(workflow,/bash scripts\/install-uvr-lite\.sh/);
  assert.match(workflow,/needs: build/);
  assert.match(installer,/sha256sum --check/);
  assert.match(installer,/9d78f8566fa8198065214ab628be1de966a500c57786695aa4b13e2b27a7727d/);
});
