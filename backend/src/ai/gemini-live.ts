import { z } from 'zod';
import type { Env } from '../env';
import { AppError, aiUnavailable } from '../core/errors';
import { unseal } from './secrets';

export const TRANSCRIBE_LIVE_MODEL='gemini-3.5-transcribe-live';
export interface RealtimeTranscriptionConfig {
  provider:'google-ai-studio';model:typeof TRANSCRIBE_LIVE_MODEL;gatewayId:string;
  apiKeyEncrypted?:string;gatewayTokenEncrypted?:string;languageCodes?:string[];
}
export const VOICE_FRAME_BYTES=48*1024;
export const VOICE_PCM_BYTES=32*1024;
const base64=z.string().min(4).max(Math.ceil(VOICE_PCM_BYTES/3)*4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const voiceClientEventSchema=z.discriminatedUnion('type',[
  z.object({type:z.literal('start')}).strict(),
  z.object({type:z.literal('stop')}).strict(),
  z.object({type:z.literal('audio'),sequence:z.number().int().min(1),data:base64}).strict(),
]);
export type VoiceClientEvent=z.infer<typeof voiceClientEventSchema>;
export type VoiceServerEvent={type:'ready'}|{type:'partial'|'final';text:string;sequence:number}|{type:'complete'}|{type:'error';code:string;message:string;retryAfterSeconds:60};
export function parseVoiceClientEvent(raw:unknown):VoiceClientEvent {
  if(typeof raw!=='string' || new TextEncoder().encode(raw).length>VOICE_FRAME_BYTES)throw new AppError('VALIDATION_FAILED','语音消息格式无效或超过大小限制',422,false);
  let value:unknown;try{value=JSON.parse(raw);}catch{throw new AppError('VALIDATION_FAILED','语音消息必须为JSON',422,false);}
  const parsed=voiceClientEventSchema.safeParse(value);
  if(!parsed.success)throw new AppError('VALIDATION_FAILED','语音消息含不支持的字段或格式',422,false);
  if(parsed.data.type==='audio') {
    const bytes=atob(parsed.data.data).length;
    if(!bytes || bytes>VOICE_PCM_BYTES || bytes%2)throw new AppError('VALIDATION_FAILED','语音数据必须为受限PCM16单声道格式',422,false);
  }
  return parsed.data;
}
export function transcribeLiveSetup(config:RealtimeTranscriptionConfig) {
  return {setup:{model:`models/${TRANSCRIBE_LIVE_MODEL}`,generationConfig:{responseModalities:['TEXT']},
    realtimeInputConfig:{automaticActivityDetection:{disabled:true}},
    inputAudioTranscription:{mode:'VERBATIM',languageCodes:config.languageCodes??[]}}};
}
export function upstreamAudioEvent(event:VoiceClientEvent) {
  if(event.type==='start')return {realtimeInput:{activityStart:{}}};
  if(event.type==='stop')return {realtimeInput:{activityEnd:{}}};
  return {realtimeInput:{audio:{data:event.data,mimeType:'audio/pcm;rate=16000'}}};
}
export function parseTranscriptionEvent(raw:unknown):{ready?:boolean;partial?:string;final?:string;complete?:boolean} {
  if(typeof raw!=='string' || raw.length>256*1024)throw aiUnavailable('语音服务响应格式无效');
  let data:unknown;try{data=JSON.parse(raw);}catch{throw aiUnavailable('语音服务响应格式无效');}
  if(!data || typeof data!=='object')throw aiUnavailable('语音服务响应格式无效');
  const record=data as Record<string,unknown>;
  if(record.error || record.toolCall || record.tool_call)throw aiUnavailable('语音服务未能完成转录');
  const content=(record.serverContent??record.server_content) as Record<string,unknown>|undefined;
  const text=(value:unknown):string|undefined=>value&&typeof value==='object'&&typeof (value as Record<string,unknown>).text==='string'?(value as {text:string}).text:undefined;
  const partial=text(content?.interimInputTranscription??content?.interim_input_transcription);
  const final=text(content?.inputTranscription??content?.input_transcription);
  if((partial?.length??0)>8000 || (final?.length??0)>8000)throw aiUnavailable('语音转录文本超过限制');
  return {ready:Boolean(record.setupComplete??record.setup_complete),partial,final,complete:Boolean(content?.turnComplete??content?.turn_complete)};
}
/** Worker-only handshake: provider credentials never appear in a browser response. */
export async function connectTranscribeGateway(env:Env,config:RealtimeTranscriptionConfig,guard:()=>Promise<void>,fetchImpl:typeof fetch=fetch):Promise<WebSocket> {
  if(config.model!==TRANSCRIBE_LIVE_MODEL || config.provider!=='google-ai-studio' || !/^[a-z0-9-]{1,64}$/.test(config.gatewayId) || !/^[a-zA-Z0-9_-]+$/.test(env.CLOUDFLARE_ACCOUNT_ID) || !config.apiKeyEncrypted || !config.gatewayTokenEncrypted)throw aiUnavailable('实时转录Gateway配置不完整');
  const apiKey=await unseal(config.apiKeyEncrypted,env.AUTH_SECRET),token=await unseal(config.gatewayTokenEncrypted,env.AUTH_SECRET);
  if(!apiKey || !token || /[\x00-\x1f\x7f]/.test(apiKey+token))throw aiUnavailable('实时转录凭据无效');
  const url=new URL(`https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${config.gatewayId}/google`);
  url.searchParams.set('api_key',apiKey);
  await guard();
  let response:Response;
  try {response=await fetchImpl(url,{headers:{Upgrade:'websocket','cf-aig-authorization':`Bearer ${token}`,'cf-aig-skip-cache':'true','cf-aig-collect-log':'false'},redirect:'manual',signal:AbortSignal.timeout(15000)});}
  catch{throw aiUnavailable('语音Gateway连接失败或超时，文字回答仍可使用');}
  if(response.status!==101 || !response.webSocket)throw aiUnavailable('语音Gateway拒绝连接，文字回答仍可使用');
  return response.webSocket;
}
