import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RehearsalVoicePanel } from './RehearsalVoicePanel';
import { captureMicrophone } from './rehearsalPcm';
import { voiceRequest } from './rehearsalVoiceApi';
vi.mock('./rehearsalVoiceApi',async original=>({...await original<typeof import('./rehearsalVoiceApi')>(),voiceRequest:vi.fn()}));
vi.mock('./rehearsalPcm',async original=>({...await original<typeof import('./rehearsalPcm')>(),captureMicrophone:vi.fn()}));
class Socket {
  static OPEN=1;static latest:Socket;readyState=1;bufferedAmount=0;sent:unknown[]=[];
  onmessage:((event:{data:string})=>void)|null=null;onclose:(()=>void)|null=null;onerror:(()=>void)|null=null;
  constructor(){Socket.latest=this;}send(data:string){this.sent.push(JSON.parse(data));}close=vi.fn();
  event(data:unknown){this.onmessage?.({data:JSON.stringify(data)});}
}
const stop=vi.fn(),busy=vi.fn(),final=vi.fn();
const config={configured:true,ready:true,mode:'voice-with-text-fallback',reason:null,speech:{model:'tts',voice:'test'}};
const props={projectId:'p1',rehearsalId:'r1',sequence:1,enabled:true,onTranscriptFinal:final,onBusyChange:busy};
let onFrame:((frame:Uint8Array)=>void)|undefined;
let audioElement:{play:ReturnType<typeof vi.fn>;pause:ReturnType<typeof vi.fn>;load:ReturnType<typeof vi.fn>;removeAttribute:ReturnType<typeof vi.fn>;onended:(()=>void)|null;onerror:(()=>void)|null};
beforeEach(()=>{
  vi.clearAllMocks();vi.stubGlobal('WebSocket',Socket);
  vi.mocked(captureMicrophone).mockImplementation(async cb=>{onFrame=cb;return{stop};});
  vi.mocked(voiceRequest).mockImplementation(async path=>{
    if(path.endsWith('/voice'))return config;
    if(path.endsWith('/voice-sessions'))return{sessionId:'session1',webSocketPath:'/api/v1/projects/p1/rehearsals/r1/voice-sessions/session1/stream',expiresAt:'future'};
    if(path.endsWith('/close'))return{};
    return{speechId:'speech1',status:'ready',audioPath:'/api/v1/projects/p1/rehearsals/r1/speech/speech1/audio'};
  });
  audioElement={play:vi.fn().mockResolvedValue(undefined),pause:vi.fn(),load:vi.fn(),removeAttribute:vi.fn(),onended:null,onerror:null};
  vi.stubGlobal('Audio',class{constructor(){return audioElement;}});
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();});
async function open(){render(<RehearsalVoicePanel {...props}/>);await waitFor(()=>expect(screen.getByRole('button',{name:'语音回答'})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'语音回答'}));}
async function record(){await open();fireEvent.click(screen.getByRole('button',{name:'开始录音'}));await waitFor(()=>expect(captureMicrophone).toHaveBeenCalled());await waitFor(()=>expect(screen.getByRole('button',{name:'正在连接语音'})).toBeInTheDocument());await act(async()=>{await Promise.resolve();});act(()=>Socket.latest.event({type:'ready'}));}
it('only explicitly starts microphone and waits for provider ready',async()=>{
  await open();expect(captureMicrophone).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'开始录音'}));await act(async()=>{await Promise.resolve();});
  act(()=>onFrame?.(new Uint8Array([1,0])));expect(Socket.latest.sent).toEqual([]);act(()=>Socket.latest.event({type:'ready'}));act(()=>onFrame?.(new Uint8Array([1,0])));expect(Socket.latest.sent).toEqual([{type:'start'},{type:'audio',sequence:1,data:'AQA='}]);
});
it('partials remain separate, unique finals append without submission',async()=>{
  await record();act(()=>Socket.latest.event({type:'partial',text:'临时'}));expect(final).not.toHaveBeenCalled();act(()=>{Socket.latest.event({type:'final',sequence:1,text:'已确认'});Socket.latest.event({type:'final',sequence:1,text:'重复'});});expect(final).toHaveBeenCalledExactlyOnceWith('已确认');
  fireEvent.click(screen.getByRole('button',{name:'停止并完成转录'}));expect(stop).toHaveBeenCalledWith(true);expect(busy).toHaveBeenLastCalledWith(true);act(()=>Socket.latest.event({type:'complete'}));expect(busy).toHaveBeenLastCalledWith(false);expect(screen.getByText(/转录完成/)).toBeInTheDocument();expect(vi.mocked(voiceRequest).mock.calls.some(([path])=>path.endsWith('/answers'))).toBe(false);
});
it('configuration unavailable keeps text without microphone',async()=>{
  vi.mocked(voiceRequest).mockResolvedValue({...config,ready:false,reason:'Gateway未配置'});render(<RehearsalVoicePanel {...props}/>);await screen.findByText('Gateway未配置');expect(screen.getByRole('button',{name:'语音回答'})).toBeDisabled();expect(captureMicrophone).not.toHaveBeenCalled();
});
it('failure keeps finals and shuts microphone with one minute cooldown',async()=>{
  await record();act(()=>Socket.latest.event({type:'final',sequence:1,text:'保留'}));act(()=>Socket.latest.event({type:'error',message:'连接失败'}));expect(stop).toHaveBeenCalled();expect(screen.getByText(/已确认字幕：保留/)).toBeInTheDocument();expect(screen.getByRole('button',{name:/秒后可继续/})).toBeDisabled();expect(captureMicrophone).toHaveBeenCalledTimes(1);
});
it('denied microphone falls back without creating session',async()=>{
  vi.mocked(captureMicrophone).mockRejectedValue(new DOMException('麦克风权限被拒绝','NotAllowedError'));await open();fireEvent.click(screen.getByRole('button',{name:'开始录音'}));await screen.findByText(/麦克风权限被拒绝/);expect(vi.mocked(voiceRequest).mock.calls.some(([path])=>path.endsWith('/voice-sessions'))).toBe(false);expect(busy).toHaveBeenLastCalledWith(false);
});
it('TTS excludes recording and switching to text stops audio',async()=>{
  await open();fireEvent.click(screen.getByRole('button',{name:'播放问题'}));await waitFor(()=>expect(audioElement.play).toHaveBeenCalled());expect(screen.getByRole('button',{name:'开始录音'})).toBeDisabled();fireEvent.click(screen.getByRole('button',{name:'文字回答'}));expect(audioElement.pause).toHaveBeenCalled();expect(captureMicrophone).not.toHaveBeenCalled();
});
it('unmount releases all resources and ignores late captions',async()=>{
  await record();cleanup();expect(stop).toHaveBeenCalled();expect(Socket.latest.close).toHaveBeenCalled();act(()=>Socket.latest.event({type:'final',sequence:99,text:'不应写入'}));expect(final).not.toHaveBeenCalled();
});
it('15 second final timeout preserves confirmed transcript',async()=>{
  await record();act(()=>Socket.latest.event({type:'final',sequence:1,text:'保留'}));vi.useFakeTimers();fireEvent.click(screen.getByRole('button',{name:'停止并完成转录'}));await act(async()=>{await Promise.resolve();});act(()=>vi.advanceTimersByTime(15001));expect(screen.getByText(/等待最终字幕超过/)).toBeInTheDocument();expect(screen.getByText(/已确认字幕：保留/)).toBeInTheDocument();expect(busy).toHaveBeenLastCalledWith(false);
});
it('three successive failures stop recovery, next explicit start resets cycle',async()=>{
  await record();vi.useFakeTimers();
  for(let attempt=0;attempt<3;attempt++){
    act(()=>Socket.latest.event({type:'error',message:'恢复失败'}));
    if(attempt<2){act(()=>vi.advanceTimersByTime(60001));fireEvent.click(screen.getByRole('button',{name:'手动继续语音'}));await act(async()=>{await Promise.resolve();});act(()=>Socket.latest.event({type:'ready'}));}
  }
  expect(screen.getByText(/连续三次语音恢复失败/)).toBeInTheDocument();expect(captureMicrophone).toHaveBeenCalledTimes(3);act(()=>vi.advanceTimersByTime(60001));expect(captureMicrophone).toHaveBeenCalledTimes(3);
  fireEvent.click(screen.getByRole('button',{name:'手动继续语音'}));await act(async()=>{await Promise.resolve();});const body=vi.mocked(voiceRequest).mock.calls.filter(([path])=>path.endsWith('/voice-sessions')).at(-1)?.[2];expect(body).toEqual({sequence:1});
});
it('recording blocks synthesis and five seconds backpressure closes microphone',async()=>{
  await record();expect(screen.getByRole('button',{name:'播放问题'})).toBeDisabled();Socket.latest.bufferedAmount=160001;act(()=>onFrame?.(new Uint8Array([1,0])));expect(screen.getByText(/音频发送阻塞/)).toBeInTheDocument();expect(stop).toHaveBeenCalled();
});
it('browser autoplay rejection offers explicit replay without regenerating TTS',async()=>{
 audioElement.play.mockRejectedValueOnce(new DOMException('Gesture required','NotAllowedError'));await open();fireEvent.click(screen.getByRole('button',{name:'播放问题'}));await screen.findByText(/朗读已生成，浏览器未开始播放/);
 const requests=vi.mocked(voiceRequest).mock.calls.filter(([path])=>path.endsWith('/speech')).length;fireEvent.click(screen.getByRole('button',{name:'播放问题'}));await waitFor(()=>expect(audioElement.play).toHaveBeenCalledTimes(2));expect(vi.mocked(voiceRequest).mock.calls.filter(([path])=>path.endsWith('/speech'))).toHaveLength(requests);
});
