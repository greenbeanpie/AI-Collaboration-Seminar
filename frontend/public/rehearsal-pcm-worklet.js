/* global AudioWorkletProcessor, registerProcessor */
class RehearsalPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super(); this.buffer = new Float32Array(1024); this.offset = 0;
    this.port.onmessage = event => {
      if (event.data?.type !== 'flush') return;
      if (this.offset) this.port.postMessage(this.buffer.slice(0, this.offset).buffer);
      this.offset = 0; this.port.postMessage({ flushed: true });
    };
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let index = 0; index < channels[0].length; index++) {
      let sample = 0;
      for (const channel of channels) sample += channel[index] || 0;
      this.buffer[this.offset++] = sample / channels.length;
      if (this.offset === this.buffer.length) {
        this.port.postMessage(this.buffer.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(1024); this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('rehearsal-pcm', RehearsalPcmProcessor);
