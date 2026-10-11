class RecordingProcessor extends AudioWorkletProcessor {
  constructor(){super();this.samples=[];this.phase=0;this.enabled=true;this.port.onmessage=e=>{this.enabled=e.data.enabled;};}
  process(inputs){const channels=inputs[0];if(!this.enabled||!channels?.length)return true;for(let i=0;i<channels[0].length;i++){this.phase+=16000;if(this.phase>=sampleRate){this.phase-=sampleRate;let sum=0;for(const channel of channels)sum+=channel[i];this.samples.push(sum/channels.length);}}if(this.samples.length>=1600){const block=new Float32Array(this.samples);this.samples=[];this.port.postMessage(block,[block.buffer]);}return true;}
}
registerProcessor('recording-pcm',RecordingProcessor);
