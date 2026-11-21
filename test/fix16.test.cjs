'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname,'..');
const script = fs.readFileSync(path.join(root,'gtcrn-filter.js'),'utf8');
function node(name) {
  return {name,targets:[],connect(to){this.targets.push(to);return to;},disconnect(){this.targets=[];},port:{postMessage(){},onmessage:null}};
}
function host(config={}) {
  const window = {}, status=[],errors=[],stream=[];
  let fetches=0;
  const upstream=node('post-stereo'), downstream=node('voice-gain');
  upstream.connect(downstream);
  class FakeWorkletNode {
    constructor(_context,_id,options) {
      this.opts=options;
      this.targets=[];
      this.sent=[];
      this.port={onmessage:null,postMessage:message=>this.sent.push(message)};
      stream.push(this);
      queueMicrotask(()=>this.port.onmessage?.({data:{type:'ready'}}));
    }
    connect(to){this.targets.push(to);return to;}
    disconnect(){this.targets=[];}
  }
  const audioWorklet={addModule:async _url=>{if(config.moduleError)throw Error('bad JS bundle');}};
  const context={sampleRate: config.rate||48000,audioWorklet};
  const wasm=new ArrayBuffer(200_000);
  const fetch=async()=>{fetches++;return config.notFound?{ok:false,status:404}:{ok:true,status:200,arrayBuffer:async()=>wasm};};
  vm.runInNewContext(script,{window,fetch,AudioWorkletNode:FakeWorkletNode,WebAssembly:{},AbortController,Error,Number,Math,console,setTimeout,clearTimeout});
  const controller=window.SaringAI.create({context,upstream,downstream,onStatus:m=>status.push(m),onFailure:e=>errors.push(e)});
  return {window,controller,upstream,downstream,status,errors,stream,get fetches(){return fetches;}};
}
const drain = () => new Promise(r=>setTimeout(r,30));
test('no AI/model download until user enables GTCRN; previous stereo pipeline stays connected',()=>{
  const h=host();
  assert.equal(h.fetches,0);
  assert.equal(h.controller.active,false);
  assert.equal(h.upstream.targets[0],h.downstream);
  h.controller.destroy();
});
test('model HTTP 404 leaves existing filtered audio connected with visible error',async()=>{
  const h=host({notFound:true});
  h.controller.enable(true);
  await drain();
  assert.equal(h.controller.active,false);
  assert.equal(h.upstream.targets[0],h.downstream);
  assert.match(h.status.join(' '),/workflow/i);
  assert.equal(h.errors.length,1);
});
test('GTCRN routes only after worklet ready, sets mix, resets and returns to stereo when disabled',async()=>{
  const h=host();
  h.controller.setLevel(25);
  h.controller.enable(true);
  await drain();
  assert.equal(h.controller.active,true);
  assert.equal(h.upstream.targets[0],h.stream[0]);
  assert.equal(h.stream[0].targets[0],h.downstream);
  assert.ok(h.stream[0].sent.some(s=>s.type==='mix'&&s.value===0.25));
  h.controller.setLevel(60);
  h.controller.reset();
  assert.ok(h.stream[0].sent.some(s=>s.type==='mix'&&s.value===0.6));
  assert.ok(h.stream[0].sent.some(s=>s.type==='reset'));
  h.controller.enable(false);
  assert.equal(h.upstream.targets[0],h.downstream);
  assert.equal(h.controller.active,false);
  assert.ok(h.stream[0].sent.some(s=>s.type==='dispose'));
  h.controller.destroy();
});
test('unsupported sample rate and bad worklet fall back without muted audio',async()=>{
  for(const config of [{rate:44100},{moduleError:true}]){
    const h=host(config);
    h.controller.enable(true);
    await drain();
    assert.equal(h.controller.active,false);
    assert.equal(h.upstream.targets[0],h.downstream);
    assert.equal(h.errors.length,1);
  }
});
test('disabling before WASM promise resolves never connects the AI graph',async()=>{
  const h=host();
  h.controller.enable(true);
  h.controller.enable(false);
  await drain();
  assert.equal(h.controller.active,false);
  assert.equal(h.upstream.targets[0],h.downstream);
});
test('app preserves resume, vocal control and stereo DSP; defaults mix AI gently',()=>{
  const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  assert.match(app,/gtcrnMix:clampNumber\(s\.gtcrnMix,0,100,25\)/);
  assert.match(app,/vocalBoost\.min='-12'/);
  assert.match(app,/resumeInfo/);
  assert.match(app,/voice-worklet\.js/);
  assert.match(app,/aiController\?\.reset\?\.\(\)/);
  assert.match(html,/gtcrn-filter\.js/);
  assert.doesNotMatch(html,/<script src="ai-filter\.js"/);
});
test('GTCRN AudioWorklet keeps speech level at mixed 25% when denoiser preserves input',async()=>{
  const workletSource=fs.readFileSync(path.join(root,'scripts/gtcrn-worklet-entry.js'),'utf8')
    .replace(/^import \{ GtcrnProcessor, loadGtcrnModule \} from '@sapphi-red\/gtcrn-wasm';\s*/m,'');
  let Worklet = null;
  class AudioWorkletProcessor {
    constructor(){this.port={onmessage:null,messages:[],postMessage(m){this.messages.push(m);}};}
  }
  class GtcrnProcessor {
    constructor(){this.destroyed=false;}
    process(frame){return frame.slice();}
    destroy(){this.destroyed=true;}
  }
  const globals={
    registerProcessor:(_name,type)=>Worklet=type,
    AudioWorkletProcessor, GtcrnProcessor,
    loadGtcrnModule:async()=>({}),
    sampleRate:48000,Float32Array,ArrayBuffer,Math,Number,console
  };
  vm.runInNewContext(workletSource,globals);
  const p=new Worklet({processorOptions:{wasmBinary:new ArrayBuffer(200000)}});
  await Promise.resolve();await Promise.resolve();
  assert.equal(p.port.messages.some(m=>m.type==='ready'),true);
  const outputs=[];
  for(let iteration=0;iteration<32;iteration++){
    const src=new Float32Array(128).fill(0.2);
    const dst=new Float32Array(128);
    p.process([[src]],[[dst]]);
    outputs.push(...dst);
  }
  assert.ok(outputs.slice(1024).every(s=>Math.abs(s-0.2)<0.000001),
    'Wet and delayed-dry signal must stay aligned and retain speech amplitude');
  p.port.onmessage({data:{type:'reset'}});
  p.port.onmessage({data:{type:'dispose'}});
});
