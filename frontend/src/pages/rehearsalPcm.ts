/** Streaming linear resampler: preserves the boundary sample across hardware blocks. */
export class Pcm16Encoder {
  private samples: number[] = [];
  private position = 0;
  private frame: number[] = [];
  constructor(private readonly inputRate: number, private readonly frameSamples = 1600) {
    if (!Number.isFinite(inputRate) || inputRate < 16000) throw new Error('不支持的麦克风采样率');
  }
  push(input: Float32Array): Uint8Array[] {
    for (const sample of input) this.samples.push(sample);
    const output: Uint8Array[] = [];
    const step = this.inputRate / 16000;
    while (this.position + 1 < this.samples.length) {
      const index = Math.floor(this.position), fraction = this.position - index;
      this.frame.push(this.samples[index] * (1 - fraction) + this.samples[index + 1] * fraction);
      this.position += step;
      if (this.frame.length === this.frameSamples) output.push(this.encode());
    }
    const consumed = Math.min(this.samples.length, Math.floor(this.position));
    this.samples.splice(0, consumed);
    this.position -= consumed;
    return output;
  }
  flush(): Uint8Array | null { return this.frame.length ? this.encode() : null; }
  private encode(): Uint8Array {
    const bytes = new Uint8Array(this.frame.length * 2), view = new DataView(bytes.buffer);
    this.frame.forEach((sample, index) => view.setInt16(index * 2, Math.round(Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767)), true));
    this.frame = [];
    return bytes;
  }
}
export function pcmBase64(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

export type MicrophoneCapture = { stop: (flush?: boolean) => void | Promise<void> };
export async function captureMicrophone(onFrame: (frame: Uint8Array) => void, signal: AbortSignal, onEnded?: () => void): Promise<MicrophoneCapture> {
  if (!navigator.mediaDevices?.getUserMedia || !globalThis.AudioContext || !globalThis.AudioWorkletNode) throw new Error('浏览器不支持实时音频采集，请使用文字回答。');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
  if (signal.aborted) { stream.getTracks().forEach(track => track.stop()); throw new DOMException('Cancelled', 'AbortError'); }
  let context: AudioContext | undefined;
  try {
    context = new AudioContext();
    await context.audioWorklet.addModule('/rehearsal-pcm-worklet.js');
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const encoder = new Pcm16Encoder(context.sampleRate);
    const source = context.createMediaStreamSource(stream), node = new AudioWorkletNode(context, 'rehearsal-pcm');
    const mute = context.createGain(); mute.gain.value = 0;
    let stopped = false, finishing: (() => void) | undefined;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const ended = () => { if (!stopped) onEnded?.(); };
    stream.getTracks().forEach(track => track.addEventListener?.('ended', ended));
    node.port.onmessage = event => {
      if (stopped || signal.aborted) return;
      if (event.data?.flushed) { finishing?.(); return; }
      for (const frame of encoder.push(new Float32Array(event.data))) onFrame(frame);
    };
    source.connect(node); node.connect(mute); mute.connect(context.destination);
    await context.resume();
    const dispose = () => {
      if (stopped) return;
      stopped = true; clearTimeout(flushTimer);
      node.port.onmessage = null; source.disconnect(); node.disconnect(); mute.disconnect();
      stream.getTracks().forEach(track => { track.removeEventListener?.('ended', ended); track.stop(); }); void context?.close();
      signal.removeEventListener('abort', abort);
    };
    const stop = (flush = false): void | Promise<void> => {
      if (stopped) return;
      if (!flush) { dispose(); finishing?.(); return; }
      return new Promise<void>(resolve => {
        finishing = () => { if (!stopped) { const tail = encoder.flush(); if (tail) onFrame(tail); } dispose(); resolve(); };
        node.port.postMessage({ type: 'flush' });
        flushTimer = setTimeout(finishing, 200);
      });
    };
    const abort = () => { void stop(); }; signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) void stop();
    return { stop };
  } catch (error) { stream.getTracks().forEach(track => track.stop()); void context?.close(); throw error; }
}
