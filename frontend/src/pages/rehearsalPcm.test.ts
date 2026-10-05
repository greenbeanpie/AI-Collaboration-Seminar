import { expect, it } from 'vitest';
import { Pcm16Encoder, pcmBase64 } from './rehearsalPcm';
it.each([16000, 44100, 48000, 96000])('resamples %s Hz blocks without boundary loss', rate => {
  const input = Float32Array.from({length:rate}, (_, i) => Math.sin(i * Math.PI * 880 / rate));
  const encoder = new Pcm16Encoder(rate), frames: Uint8Array[] = [];
  for(let offset=0;offset<input.length;offset+=1024) frames.push(...encoder.push(input.slice(offset,offset+1024)));
  const tail=encoder.flush();if(tail)frames.push(tail);
  const bytes=frames.reduce((count,frame)=>count+frame.length,0);expect(bytes).toBeGreaterThanOrEqual(31996);expect(bytes).toBeLessThanOrEqual(32000);
  expect(frames.slice(0,-1).every(frame=>frame.length===3200)).toBe(true);
  const whole=new Pcm16Encoder(rate), reference=whole.push(input), remainder=whole.flush();if(remainder)reference.push(remainder);expect(frames).toEqual(reference);
});
it('clips signed little endian PCM',()=>{const frames=new Pcm16Encoder(16000,4).push(new Float32Array([-2,2,-.5,.5,0]));expect([...frames[0]]).toEqual([0,128,255,127,0,192,0,64]);expect(pcmBase64(frames[0])).toBe('AID/fwDAAEA=');});
it('rejects invalid sample rates',()=>{expect(()=>new Pcm16Encoder(0)).toThrow();expect(()=>new Pcm16Encoder(NaN)).toThrow();});
