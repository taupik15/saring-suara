const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const script = fs.readFileSync(path.resolve(__dirname, '../app.js'), 'utf8');
class Target {
  constructor(tag='div') {this.tag=tag;this.listeners={};this.children=[];this.hidden=false;this.disabled=false;
    this.value='';this.files=[];this.style={};this.readyState=1;this.duration=3600;this.currentTime=0;this.paused=true;}
  setAttribute(name,value){this[name]=value;}
  addEventListener(name,cb) {(this.listeners[name]??=[]).push(cb);}
  removeEventListener(name,cb) {this.listeners[name]=(this.listeners[name]||[]).filter(x=>x!==cb);}
  fire(name) {for(const fn of this.listeners[name]||[])fn({target:this});}
  append(...x){this.children.push(...x);} prepend(...x){this.children.unshift(...x);}
  replaceChildren(){this.children=[];}
  connect(n){this.connected=n;} disconnect(){};
  play(){this.paused=false;this.fire('play');return Promise.resolve();}
  pause(){this.paused=true;this.fire('pause');}
}
const store=new Map();
const localStorage={setItem:(k,v)=>store.set(k,String(v)),getItem:k=>store.get(k)||null,removeItem:k=>store.delete(k)};
const sess=new Map();
const sessionStorage={setItem:(k,v)=>sess.set(k,String(v)),getItem:k=>sess.get(k)||null,removeItem:k=>sess.delete(k)};
const nodes=new Map();
for(const id of ['file','run','cancel','result','status','options','stem','dialogOptions','centerHint','hint','modeOptions','previewHint','heavyGuard','exportWarning','resumeInfo','centered','allowHeavy'])nodes.set(id,new Target());
nodes.get('stem').value='center-live';nodes.get('stem').options=[{value:'center-live',textContent:'center-live'},{value:'vokal',textContent:'vokal'}];
const docEvents=new Target('document');
const document={
  getElementById:id=>{if(!nodes.has(id))nodes.set(id,new Target());return nodes.get(id);},
  createElement:tag=>new Target(tag),createTextNode:txt=>({textContent:txt}),
  querySelector:()=>({value:'audio'}),
  addEventListener:docEvents.addEventListener.bind(docEvents),
  removeEventListener:docEvents.removeEventListener.bind(docEvents),
  visibilityState:'visible'
};
const winEvents=new Target('window');
const win={addEventListener:winEvents.addEventListener.bind(winEvents),removeEventListener:winEvents.removeEventListener.bind(winEvents)};
function audioParam(v=0){return {value:v,setTargetAtTime(x){this.value=x;}};}
class AudioNode extends Target {
  constructor(kind){super(kind);this.kind=kind;this.gain=audioParam();this.frequency=audioParam();this.Q=audioParam();this.threshold=audioParam();this.ratio=audioParam();this.knee=audioParam();this.attack=audioParam();this.release=audioParam();}
}
const audioContexts=[];
class AudioContext {
  constructor(){this.kind='AudioContext';this.currentTime=0;this.destination=new AudioNode('destination');this.nodes=[];this.audioWorklet={addModule:async()=>{}};audioContexts.push(this);}
  make(kind){const n=new AudioNode(kind);this.nodes.push(n);return n;}
  createMediaElementSource(){return this.make('source');}
  createBiquadFilter(){return this.make('biquad');}
  createDynamicsCompressor(){return this.make('compressor');}
  createGain(){return this.make('gain');}
  resume(){return Promise.resolve();}
  close(){return Promise.resolve();}
}
class AudioWorkletNode extends AudioNode {
  constructor(){super('worklet');this.messages=[];this.port={postMessage:m=>this.messages.push(m),onmessage:null};}
}
win.AudioContext=AudioContext;
win.SaringAI={create(){return {setLevel(){},enable(){},destroy(){}};}};
const URL={createObjectURL:()=>`blob:mock-${Math.random()}`,revokeObjectURL:()=>{}};
const context=vm.createContext({document,window:win,localStorage,sessionStorage,URL,AudioWorkletNode,
  navigator:{userAgent:'Mozilla',platform:'Linux',maxTouchPoints:0},console,setTimeout,clearTimeout,
  Date,Number,Math,JSON,Promise,Error,Blob,Uint8Array,DataView,ArrayBuffer});
vm.runInContext(script,context,{filename:'app.js'});
const evaluate=(s)=>vm.runInContext(s,context);
const source={name:'episode.mov',size:34898731,lastModified:321,type:'video/quicktime'};
const f=nodes.get('file'), r=nodes.get('run');
const record=()=>JSON.parse(localStorage.getItem('saring-suara-playback-fix13'));
(async()=>{
  assert.equal(evaluate('clockTime(2700)'), '45:00');
  assert.equal(evaluate('clockTime(3670)'), '1:01:10');
  assert.equal(evaluate('savedControls().vocal'),4);
  f.files=[source];f.fire('change');
  r.fire('click');
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(audioContexts.length,1);
  let player=nodes.get('result').children.find(x=>x.tag==='video');
  assert.ok(player,'video player created');
  const controls=nodes.get('result').children.find(x=>x.className==='live-controls');
  assert.ok(controls,'controls created');
  const sliders=[];
  function gather(o){if(o.tag==='input'&&o.type==='range')sliders.push(o);for(const v of o.children||[])if(v instanceof Target)gather(v);}
  gather(controls);
  assert.equal(sliders.length,4);
  sliders[3].value='65';sliders[3].oninput();
  assert.equal(evaluate('savedControls().gtcrnMix'),65);
  sliders[0].value='100';sliders[0].oninput();
  sliders[1].value='75';sliders[1].oninput();
  sliders[2].value='9';sliders[2].oninput();
  assert.equal(evaluate('savedControls().vocal'),9);
  const voiceGain=audioContexts[0].nodes.find(x=>x.kind==='gain');
  assert.ok(voiceGain.gain.value>2.8,'voice boost 9dB applied to filtered audio');
  // Signed dB is a volume control on the *filtered* signal, not voice-only separation.
  assert.equal(sliders[2].min,'-12');
  assert.equal(sliders[2].max,'12');
  const voiceLabel=controls.children.find(x=>x.tag==='label'&&x.children?.includes(sliders[2]));
  assert.ok(voiceLabel,'vocal gain label exists');
  const dbReadout=voiceLabel.children.find(x=>x.tag==='span');
  assert.equal(dbReadout.textContent,'+9 dB');
  sliders[2].value='-6';sliders[2].oninput();
  assert.equal(evaluate('savedControls().vocal'),-6);
  assert.equal(dbReadout.textContent,'-6 dB');
  assert.ok(Math.abs(voiceGain.gain.value - Math.pow(10,-6/20)) < 1e-9,'-6dB attenuation works');
  sliders[2].value='0';sliders[2].oninput();
  assert.equal(dbReadout.textContent,'0 dB');
  assert.equal(voiceGain.gain.value,1,'0 dB unity gain');
  sliders[2].value='-12';sliders[2].oninput();
  assert.equal(dbReadout.textContent,'-12 dB');
  assert.ok(Math.abs(voiceGain.gain.value - Math.pow(10,-12/20)) < 1e-9,'-12dB attenuation works');
  sliders[2].value='9';sliders[2].oninput();
  assert.equal(dbReadout.textContent,'+9 dB');
  assert.equal(evaluate('savedControls().vocal'),9);

  const compressors=audioContexts[0].nodes.filter(x=>x.kind==='compressor');
  assert.equal(compressors.length,2,'compressor and safety limiter both present');
  player.currentTime=2700;player.fire('timeupdate');player.fire('pause');
  assert.equal(record().name,source.name);
  assert.ok(record().position>2699);
  assert.equal(record().size,source.size);
  assert.equal(record().duration,3600);
  assert.ok(JSON.stringify(record()).length<500,'no media bytes retained');
  // Simulate Safari refresh by mounting the same page code in the same localStorage scope.
  winEvents.fire('pagehide');
  nodes.get('result').replaceChildren();
  f.files=[];f.fire('change');
  assert.ok(nodes.get('resumeInfo').textContent.includes('45:00'));
  f.files=[{...source}];f.fire('change');
  r.fire('click');
  await new Promise(resolve=>setTimeout(resolve,0));
  player=nodes.get('result').children.find(x=>x.tag==='video');
  const notice=nodes.get('result').children.find(x=>x.className==='note resume-actions');
  assert.ok(notice,'resume action created');
  const button=notice.children.find(x=>x.tag==='button');
  assert.ok(button && button.textContent.includes('45:00'));
  assert.equal(player.currentTime,0,'no automatic jump or playback before user chooses');
  button.fire('click');
  assert.equal(player.currentTime,2700);
  assert.equal(player.paused,false);
  // If file differs, must never resume by name alone.
  assert.equal(evaluate('sameSource(checkpoint(), {name:"episode.mov",size:1,lastModified:321})'),false);
  player.fire('ended');
  assert.equal(record(),null,'completed playback must remove saved position');
  console.log('PASS: boost after DSP, limiter, checkpoint, file match, explicit resume, end cleanup, settings');
})().catch(e=>{console.error(e);process.exitCode=1;});
