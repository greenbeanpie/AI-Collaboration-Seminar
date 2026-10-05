import { z } from 'zod';
import { LIMITS } from '../core/limits';
export const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo' as const;
const segmentSchema = z.object({start:z.number().finite().optional(),end:z.number().finite().optional(),text:z.string().optional(),avg_logprob:z.number().finite().optional(),no_speech_prob:z.number().finite().optional(),compression_ratio:z.number().finite().optional()});
export const transcriptSchema = z.object({text:z.string().max(1000000),transcription_info:z.object({duration:z.number().finite().positive().optional(),language:z.string().optional(),language_probability:z.number().optional()}).optional(),segments:z.array(segmentSchema).max(100000).optional()});
export type Transcript = z.infer<typeof transcriptSchema>;
export type AudioChunk = {start:number;end:number;text:string;segments:NonNullable<Transcript['segments']>};
export const qualitySchema = z.object({score:z.number().min(0).max(1),critical:z.boolean(),reasons:z.array(z.string().max(512)).max(8),anomalies:z.array(z.object({seconds:z.number().nonnegative(),reason:z.string().max(512)})).max(16)});
export type AudioQuality = z.infer<typeof qualitySchema>;
/** Language probability is intentionally not consulted: it is not ASR accuracy. */
export function transcriptGate(t:Transcript):string[] {
 const reasons:string[]=[];const duration=t.transcription_info?.duration;
 if(!t.text.trim())reasons.push('转录文本为空');
 if(!duration || duration>14400)reasons.push('无法确认音频时长或超过四小时');
 const segments=(t.segments??[]).filter(s=>s.text?.trim());
 if(!segments.length)reasons.push('缺少语音分段');
 let previousEnd=0;const seen=new Map<string,number>();
 for(const s of segments){
  if(s.start===undefined||s.end===undefined||s.start<0||s.end<=s.start||s.start<previousEnd-0.1||!duration||s.end>duration+0.1)reasons.push('分段时间无效');
  previousEnd=s.end??previousEnd;
  if(s.avg_logprob===undefined||s.avg_logprob > 0 || s.avg_logprob < -1 ||s.no_speech_prob===undefined||s.no_speech_prob<0||s.no_speech_prob>=0.6||s.compression_ratio===undefined||s.compression_ratio<=0||s.compression_ratio>2.4)reasons.push('分段质量指标缺失或低于门槛');
  const text=s.text!.trim();seen.set(text,(seen.get(text)??0)+1);
  if(text.length>=10&&(seen.get(text)??0)>=3 || /(.{5,})\1\1/u.test(text))reasons.push('转录存在明显重复');
 }
 const normalized=(s:string)=>s.replace(/\s+/gu,'');
 if(normalized(segments.map(s=>s.text).join(''))!==normalized(t.text))reasons.push('全文与分段文本不一致');
 return [...new Set(reasons)];
}
/** A whole segment is never silently clipped or split; oversized inputs fall back. */
export function chunkTranscript(t:Transcript,maxInputChars:number):AudioChunk[] {
 const cap=Math.min(LIMITS.audioTranscriptChunkChars,maxInputChars-4096);if(cap<256)throw new Error('模型输入上限不足');
 const chunks:AudioChunk[]=[];
 for(const s of (t.segments??[]).filter(s=>s.text?.trim())){
  const line=`[${s.start}s-${s.end}s] ${s.text}`;
  if(line.length>cap || JSON.stringify(s).length>cap)throw new Error('完整分段超过模型输入上限');
  let current=chunks[chunks.length-1];
  if(!current || current.text.length+line.length+1>cap || JSON.stringify({...current,text:current.text+'\n'+line,segments:[...current.segments,s]}).length>maxInputChars-2048){const candidate={start:s.start!,end:s.end!,text:line,segments:[s]};if(JSON.stringify(candidate).length>maxInputChars-2048)throw new Error('完整分段连同质量指标超过模型输入上限');current={start:s.start!,end:s.end!,text:'',segments:[]};chunks.push(current);}
  current.text+=(current.text?'\n':'')+line;current.segments.push(s);current.end=s.end!;
 }
 if(!chunks.length || chunks.length>LIMITS.audioTranscriptMaxChunks)throw new Error('转录超出分块处理范围');
 return chunks;
}
export function allQualityPassed(values:AudioQuality[],chunks:number):boolean{return values.length===chunks&&values.every(v=>v.score>=0.85&&!v.critical&&v.anomalies.length===0);}
