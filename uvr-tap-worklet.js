/* Saring Suara Fix 2.0 · low-memory audio pre-reader.
 * Captures source audio a fixed chunk ahead of the visible player.
 * This processor never outputs audible audio. No inference on audio thread.
 */
'use strict';
const UVR_HOP=1024, UVR_FRAMES=256, UVR_RATE=44100;
class UvrTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size=Math.ceil(sampleRate*UVR_HOP*UVR_FRAMES/UVR_RATE);
    this.left=new Float32Array(this.size);
    this.right=new Float32Array(this.size);
    this.at=0;
    this.index=0;
    this.dead=false;
    this.port.onmessage=({data})=>{
      if(data?.type==='stop') {this.dead=true;this.at=0;}
      else if(data?.type==='flush' && this.at) {
        this.emit(this.at);
      }
    };
  }
  emit(valid) {
    const a=this.left,b=this.right;
    // The already-zero-padded tail is intentional for end of a video.
    this.port.postMessage({type:'chunk', index:this.index++,valid,left:a.buffer,right:b.buffer,rate:sampleRate},[a.buffer,b.buffer]);
    this.left=new Float32Array(this.size);
    this.right=new Float32Array(this.size);
    this.at=0;
  }
  process(inputs,outputs) {
    const out=outputs[0];
    if(out)for(const ch of out)ch.fill(0);
    if(this.dead)return false;
    const channels=inputs[0];
    if(!channels?.[0])return true;
    const a=channels[0],b=channels[1]||a;
    for(let i=0;i<a.length;i++){
      this.left[this.at]=a[i];this.right[this.at]=b[i];
      if(++this.at===this.size)this.emit(this.size);
    }
    return true;
  }
}
registerProcessor('saring-uvr-tap',UvrTapProcessor);
