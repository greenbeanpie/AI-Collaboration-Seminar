import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultLocalSpeech, localSpeechChunks, selectLocalVoice, speakLocal, waitForLocalVoice } from './localSpeech';
const voice = (lang:string,localService:boolean,preferred=false): SpeechSynthesisVoice => ({voiceURI:lang,name:lang,lang,localService,default:preferred});
let synthesis: SpeechSynthesis & { getVoices: ReturnType<typeof vi.fn>; speak: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
let current: SpeechSynthesisUtterance | undefined;
beforeEach(()=>{
 current=undefined;
 synthesis=Object.assign(new EventTarget(),{getVoices:vi.fn(()=>[voice('zh-CN',true)]),speaking:false,pending:false,speak:vi.fn((utterance:SpeechSynthesisUtterance)=>{current=utterance;Object.assign(synthesis,{speaking:true});}),cancel:vi.fn(()=>Object.assign(synthesis,{speaking:false}))}) as unknown as typeof synthesis;
 vi.stubGlobal('speechSynthesis',synthesis);vi.stubGlobal('SpeechSynthesisUtterance',class{constructor(public text:string){}voice=null;lang='';rate=1;volume=1;onstart=null;onend=null;onerror=null;});
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it('selects matching local language before defaults and rejects network voices',()=>{
 const remote=voice('zh-CN',false,true),local=voice('zh-CN',true),other=voice('en-US',true,true);
 expect(selectLocalVoice([remote,other,local],'zh-CN')).toBe(local);expect(selectLocalVoice([remote,other],'zh-CN')).toBe(other);expect(selectLocalVoice([remote],'zh-CN')).toBeNull();expect(selectLocalVoice([voice('zh-TW',true),other],'zh-CN')?.lang).toBe('zh-TW');
});
it('accepts voices loaded asynchronously and removes listeners',async()=>{
 synthesis.getVoices.mockReturnValue([]);const remove=vi.spyOn(synthesis,'removeEventListener');const result=waitForLocalVoice(synthesis,'zh-CN',new AbortController().signal);synthesis.getVoices.mockReturnValue([voice('zh-CN',true)]);synthesis.dispatchEvent(new Event('voiceschanged'));expect((await result).localService).toBe(true);expect(remove).toHaveBeenCalledWith('voiceschanged',expect.any(Function));
});
it('waits no more than two seconds and never speaks a remote/default voice',async()=>{
 vi.useFakeTimers();synthesis.getVoices.mockReturnValue([voice('zh-CN',false,true)]);const playback=speakLocal('只允许本地',defaultLocalSpeech);const failure=expect(playback.finished).rejects.toThrow('系统没有可用的本地');await vi.advanceTimersByTimeAsync(2001);await failure;expect(synthesis.speak).not.toHaveBeenCalled();expect(synthesis.cancel).not.toHaveBeenCalled();
});
it('aborts voice discovery without canceling another component speech',async()=>{
 synthesis.getVoices.mockReturnValue([]);const controller=new AbortController();const pending=waitForLocalVoice(synthesis,'zh-CN',controller.signal);const failure=expect(pending).rejects.toMatchObject({name:'AbortError'});controller.abort();await failure;expect(synthesis.cancel).not.toHaveBeenCalled();
});
it('preserves all text and Unicode with bounded sentence chunks',()=>{
 const text='第一段，有保留的空格。\n第二段🙂！ '+ '甲'.repeat(7950);const chunks=localSpeechChunks(text);expect(chunks.join('')).toBe(text);expect(chunks.every(chunk=>Array.from(chunk).length<=40)).toBe(true);expect(()=>localSpeechChunks(text,201)).toThrow();
});
it('serializes exact chunks through an explicit local voice',async()=>{
 const text='甲'.repeat(90);const playback=speakLocal(text,{...defaultLocalSpeech,rate:1.25,volume:.6});await Promise.resolve();expect(synthesis.speak).toHaveBeenCalledTimes(1);
 while(current?.onend){const utterance=current;expect(utterance.voice?.localService).toBe(true);expect(utterance.rate).toBe(1.25);expect(utterance.volume).toBe(.6);Object.assign(synthesis,{speaking:false});utterance.onend?.({} as SpeechSynthesisEvent);await Promise.resolve();}
 await playback.finished;expect(synthesis.speak.mock.calls.map(([utterance])=>utterance.text).join('')).toBe(text);expect(synthesis.cancel).not.toHaveBeenCalled();
});
it('cancel only affects the owned utterance and clears delayed callbacks',async()=>{
 const started=vi.fn();const playback=speakLocal('取消本轮',defaultLocalSpeech,started);const failure=expect(playback.finished).rejects.toMatchObject({name:'AbortError'});await Promise.resolve();const late=current?.onstart;playback.cancel();await failure;expect(synthesis.cancel).toHaveBeenCalledTimes(1);expect(current?.onstart).toBeNull();expect(current?.onend).toBeNull();late?.call(current!, {} as SpeechSynthesisEvent);expect(started).not.toHaveBeenCalled();playback.cancel();expect(synthesis.cancel).toHaveBeenCalledTimes(1);
});
it('does not interrupt externally owned system speech',async()=>{
 Object.assign(synthesis,{speaking:true});const playback=speakLocal('本轮问题',defaultLocalSpeech);await expect(playback.finished).rejects.toThrow('其他朗读');expect(synthesis.cancel).not.toHaveBeenCalled();expect(synthesis.speak).not.toHaveBeenCalled();
});
it('engine failure releases ownership and allows a subsequent explicit request',async()=>{
 const playback=speakLocal('失败',defaultLocalSpeech);const failure=expect(playback.finished).rejects.toThrow('synthesis-failed');await Promise.resolve();current?.onerror?.({error:'synthesis-failed'} as SpeechSynthesisErrorEvent);await failure;expect(synthesis.cancel).toHaveBeenCalled();const next=speakLocal('再次点击',defaultLocalSpeech);await Promise.resolve();Object.assign(synthesis,{speaking:false});current?.onend?.({} as SpeechSynthesisEvent);await next.finished;expect(synthesis.speak).toHaveBeenCalledTimes(2);
});
it('missing engine events hit a watchdog and release busy ownership',async()=>{
 vi.useFakeTimers();const playback=speakLocal('无事件',defaultLocalSpeech);const failure=expect(playback.finished).rejects.toThrow('响应超时');await Promise.resolve();await vi.advanceTimersByTimeAsync(60001);await failure;expect(synthesis.cancel).toHaveBeenCalledTimes(1);
});
it('rejects excessive text instead of silently truncating it',async()=>{
 await expect(speakLocal('甲'.repeat(8001),defaultLocalSpeech).finished).rejects.toThrow('超过 8000');expect(synthesis.speak).not.toHaveBeenCalled();
});
