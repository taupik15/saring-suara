'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');

function createFakeRNNoiseWorklet() {
  const registered={};
  class AudioWorkletProcessor {
    constructor() {this.messages=[];this.port={postMessage:m=>this.messages.push(m),onmessage:null};}
  }
  class FakeRnnoise {
    constructor(){this.frameSize=480;}
    createDenoiseState(){return {destroy(){},processFrame(frame){
      for(let i=0;i<frame.length;i++) frame[i]*=0.9;
      return 0.8;
    }};}
    static loadBinary(){return Promise.resolve(new FakeRnnoise());}
  }
  const src=read('scripts/rnnoise-vad-worklet-entry.js').replace("import { Rnnoise } from '@shiguredo/rnnoise-wasm';",'');
  const ctx={Rnnoise:FakeRnnoise,AudioWorkletProcessor,sampleRate:48000,registerProcessor:(k,v)=>registered[k]=v,console,Float32Array,ArrayBuffer,Error,Math,Number,Promise};
  vm.runInNewContext(src,ctx);
  return registered['saring-rnnoise-vad'];
}

test('RNNoise VAD worklet reports real processFrame scores without another model',async()=>{
  const Worklet=createFakeRNNoiseWorklet();
  const w=new Worklet({processorOptions:{wasmBinary:new ArrayBuffer(100)}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(w.messages.some(m=>m.type==='ready'));
  for(let i=0;i<38;i++){
    const signal=new Float32Array(128);signal.fill(0.15);
    const output=new Float32Array(128);
    w.process([[signal]],[[output]]);
    assert.ok(output.every(Number.isFinite));
  }
  const scores=w.messages.filter(m=>m.type==='vad');
  assert.ok(scores.length>=2);
  scores.forEach(m=>assert.equal(m.value,0.8));
  w.port.onmessage({data:{type:'reset'}});
  w.process([[new Float32Array(128)]],[[new Float32Array(128)]]);
  w.port.onmessage({data:{type:'destroy'}});
  assert.equal(w.process([[new Float32Array(128)]],[[new Float32Array(128)]]),false);
});

function createFakeGateWorklet() {
  const registered={};
  class AudioWorkletProcessor {
    constructor(){this.messages=[];this.port={postMessage:m=>this.messages.push(m),onmessage:null};}
  }
  const ctx={AudioWorkletProcessor,sampleRate:48000,currentTime:0,registerProcessor:(k,v)=>registered[k]=v,Float32Array,Math,Number,console};
  vm.runInNewContext(read('speech-gate-worklet.js'),ctx);
  return {Gate:registered['speech-gate'],ctx};
}

test('SpeechGate switches between actual VAD and energy fallback; reset clears stale VAD',()=>{
  const {Gate,ctx}=createFakeGateWorklet();
  const g=new Gate();
  g.port.onmessage({data:{type:'params',params:{enabled:true,holdMs:0,releaseMs:20}}});
  const out=new Float32Array(128);
  const process=()=>{ctx.currentTime+=128/48000;g.process([[new Float32Array(128)]],[[out]]);};
  g.port.onmessage({data:{type:'vad',value:0.9}});
  for(let i=0;i<40;i++)process();
  let meter=g.messages.filter(m=>m.detector).at(-1);
  assert.equal(meter.detector,'vad');
  assert.equal(meter.vadScore,0.9);
  g.port.onmessage({data:{type:'vadClear'}});
  for(let i=0;i<40;i++)process();
  meter=g.messages.filter(m=>m.detector).at(-1);
  assert.equal(meter.detector,'energy');
  g.port.onmessage({data:{type:'vad',value:0.2}});
  g.port.onmessage({data:{type:'reset'}});
  for(let i=0;i<40;i++)process();
  meter=g.messages.filter(m=>m.detector).at(-1);
  assert.equal(meter.detector,'energy');
});

test('Fix 1.9 wiring exposes VAD callback and keeps full video playback',()=>{
  const app=read('app.js');
  const rn=read('rnnoise-filter.js');
  const html=read('index.html');
  assert.ok(app.includes('onVad:score=>{if(audioContext===ctx)speechGate?.setVad(score);}'));
  assert.ok(rn.includes("rnnoise-vad-worklet.js"));
  assert.ok(rn.includes("const DELAY_SAMPLES = 640"));
  assert.ok(rn.includes('onVad?.(null)'));
  assert.ok(html.includes('<script src="speech-gate.js"></script>'));
  assert.ok(app.includes("document.createElement(isVideo(source)?'video':'audio')"));
  assert.ok(app.includes('attachPlayback(player,source'));
});

test('RNNoise build includes required loadBinary patch and same-origin VAD worklet',()=>{
  const sh=read('scripts/install-rnnoise.sh');
  assert.ok(sh.includes('static async loadBinary(binary)'));
  assert.ok(sh.includes('rnnoise-vad-entry.js'));
  assert.ok(sh.includes('vendor-rnnoise/rnnoise-vad-worklet.js'));
  assert.ok(!read('rnnoise-filter.js').includes("import(MAIN)"));
});


test('RNNoise controller forwards VAD during playback and clears it on disable',async()=>{
  const vad=[];
  class GraphNode {
    constructor(){this.connections=[];}
    connect(node){this.connections.push(node);}
    disconnect(){this.connections=[];}
  }
  class GainNode extends GraphNode {
    constructor(){super();this.gain={value:1,setTargetAtTime(){}};}
  }
  class DelayNode extends GraphNode {
    constructor(){super();this.delayTime={value:0};}
  }
  let lastWorklet=null;
  class FakeWorklet extends GraphNode {
    constructor(ctx,name,opts){
      super();this.port={onmessage:null,postMessage(){},close(){}};
      this.onprocessorerror=null;lastWorklet=this;
      assert.equal(name,'saring-rnnoise-vad');
      assert.ok(opts.processorOptions.wasmBinary instanceof ArrayBuffer);
      setImmediate(()=>this.port.onmessage?.({data:{type:'ready'}}));
    }
  }
  const context={sampleRate:48000,currentTime:0,
    audioWorklet:{addModule:async()=>{}},createDelay:()=>new DelayNode(),createGain:()=>new GainNode()};
  const upstream=new GraphNode(),downstream=new GraphNode();
  const fakeWindow={};
  const jsContext={window:fakeWindow,AudioWorkletNode:FakeWorklet,WebAssembly:{validate:()=>true},
    fetch:async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(30000)}),
    AbortController,console,Math,Number,setTimeout,clearTimeout,Promise};
  vm.runInNewContext(read('rnnoise-filter.js'),jsContext);
  const r=fakeWindow.SaringRNNoise.create({context,upstream,downstream,onVad:v=>vad.push(v)});
  r.enable(true);
  for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(r.active,true);
  lastWorklet.port.onmessage({data:{type:'vad',value:0.77}});
  assert.equal(vad.at(-1),0.77);
  r.enable(false);
  assert.equal(r.active,false);
  assert.equal(vad.at(-1),null);
  r.destroy();
});
