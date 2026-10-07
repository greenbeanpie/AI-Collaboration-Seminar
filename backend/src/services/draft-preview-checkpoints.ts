import { checkpointSecret, type SecretKeyring } from '../ai/secrets';
import type { Env } from '../env';
import type { GatewayCallOutput } from '../ai/gateway';
import type { ToolExchange } from '../ai/tool-transport';
import type { ContextPhase } from '../ai/context-phases';
import type { DraftPayload, creationGoal } from './creation-drafts';
import type { z } from 'zod';
import { invalidState } from '../core/errors';
import { seal, unseal } from '../ai/secrets';

export interface DraftPreviewCheckpoint {
  version: 1;
  draftId: string;
  userId: string;
  revision: number;
  attempt: string;
  configVersionId: string;
  payload: DraftPayload;
  context: Array<{fileId:string;name:string;pages:string[];limitation:string|null}>;
  requestedGoal?: z.infer<typeof creationGoal>;
  system: string;
  step: number;
  segment?: number;
  dispatchGeneration?: number;
  dispatchSegment?: number;
  dispatchInstanceId?: string;
  executionGeneration?: number;
  feedback?: string;
  finalizing?: boolean;
  providerRetry?: {attempt:number;deadline:number;nextAttemptAt:number};
  exchanges: ToolExchange[];
  contextPhase?: ContextPhase;
  readProgress?: Array<{fileId:string;lastOffset:number;lastCharOffset:number;nextOffset:number|null;nextCharOffset:number;locators:Array<{locator:string;pageNumber:number|null}>}>;
  clarificationProgress?: unknown[];
  pendingDispatch?: boolean;
  pendingOutput?: GatewayCallOutput;
  pendingResults?: ToolExchange['results'];
  content?: string;
}
export class DraftPreviewYield extends Error {
  constructor() { super('预览检查点已保存，等待下一执行分段'); this.name='DraftPreviewYield'; }
}
/** Bound UTF-16 input limits without splitting a surrogate pair. */
export function draftTextPrefix(text:string,maxUnits:number):string {
  if(text.length<=maxUnits)return text;
  let end=Math.max(0,Math.floor(maxUnits));
  if(end>0&&/[\uD800-\uDBFF]/u.test(text[end-1]!))end--;
  return text.slice(0,end);
}
/** Dropped tool text remains in immutable document blocks and can be read again. */
export function compactDraftHistory(state:DraftPreviewCheckpoint,budget:number,metadataBudget=12000):void {
  let size=state.exchanges.reduce((n,e)=>n+JSON.stringify(e).length,0);
  state.readProgress??=[];state.clarificationProgress??=[];
  while(state.exchanges.length&&size>Math.max(0,budget)) {
    const old=state.exchanges.shift()!;size-=JSON.stringify(old).length;
    for(const result of old.results) {
      if(result.call.name==='read_draft_document') {
        const args=result.call.args as {fileId?:unknown;offset?:unknown;charOffset?:unknown}|null;
        const output=result.output as {nextOffset?:number|null;nextCharOffset?:number;blocks?:Array<{locator:string;pageNumber:number|null}>}|null;
        if(!args||typeof args.fileId!=='string'||args.fileId.length>100)continue;
        const previous=state.readProgress.find(p=>p.fileId===args.fileId);
        const locators=[...(previous?.locators??[]),...(output?.blocks??[]).map(b=>({locator:draftTextPrefix(String(b.locator),100),pageNumber:b.pageNumber}))];
        const unique=new Map(locators.map(l=>[l.locator,l]));
        const progress={fileId:args.fileId,lastOffset:Number(args.offset)||0,lastCharOffset:Number(args.charOffset)||0,nextOffset:typeof output?.nextOffset==='number'?output.nextOffset:null,nextCharOffset:Number(output?.nextCharOffset)||0,locators:[...unique.values()].slice(-50)};
        state.readProgress=state.readProgress.filter(p=>p.fileId!==args.fileId);state.readProgress.push(progress);state.readProgress=state.readProgress.slice(-10);
      }else if(result.call.name==='ask_user_question') {
        // Clarification rounds are bounded separately; retain their answers as data.
        state.clarificationProgress.push({question:draftTextPrefix(JSON.stringify(result.call.args)??'null',1000),result:draftTextPrefix(JSON.stringify(result.output)??'null',2000)});
        state.clarificationProgress=state.clarificationProgress.slice(-3);
      }
    }
  }
  // Also bound migrated metadata and invalid-output feedback before every save.
  state.readProgress=state.readProgress.slice(-10).map(p=>({...p,locators:p.locators.slice(-50)}));
  state.clarificationProgress=state.clarificationProgress.slice(-3);
  while(JSON.stringify({reads:state.readProgress,clarifications:state.clarificationProgress}).length>metadataBudget) {
    const withLocators=state.readProgress.find(p=>p.locators.length>0);
    if(withLocators){withLocators.locators.shift();continue;}
    if(state.clarificationProgress.length){state.clarificationProgress.shift();continue;}
    if(state.readProgress.length){state.readProgress.shift();continue;}
    break;
  }
  if(state.feedback)state.feedback=draftTextPrefix(state.feedback,2000);
}
interface Envelope { format:'encrypted-draft-preview-v1';chunks:string[] }
export class DraftCheckpointBusy extends Error {
  constructor() { super('同一预览已由另一请求处理；请刷新状态'); this.name='DraftCheckpointBusy'; }
}
const key = (attempt:string) => `ai/draft-investigations/${attempt}.json`;

export async function loadDraftCheckpoint(env:Env,attempt:string):Promise<{checkpoint:DraftPreviewCheckpoint;etag:string}|null> {
  const object=await env.FILES.get(key(attempt));
  if(!object)return null;
  const envelope=await object.json<Envelope>();
  if(envelope.format!=='encrypted-draft-preview-v1'||!Array.isArray(envelope.chunks)||!envelope.chunks.length)throw invalidState('预览检查点格式无效');
  let text='';
  for(const [index,chunk] of envelope.chunks.entries()) {
    const part=JSON.parse(await unseal(chunk,checkpointSecret(env))) as {attempt:string;index:number;total:number;data:string};
    if(part.attempt!==attempt||part.index!==index||part.total!==envelope.chunks.length||typeof part.data!=='string')throw invalidState('预览检查点内容不匹配');
    text+=part.data;
  }
  const checkpoint=JSON.parse(text) as DraftPreviewCheckpoint;
  if(checkpoint.version!==1||checkpoint.attempt!==attempt)throw invalidState('预览检查点版本无效');
  return {checkpoint,etag:object.etag};
}

/** Conditional writes serialize all executions of one attempt, including answer retries. */
export async function saveDraftCheckpoint(env:Env,checkpoint:DraftPreviewCheckpoint,etag?:string):Promise<string> {
  const characters=Array.from(JSON.stringify(checkpoint)),chunks:string[]=[],total=Math.ceil(characters.length/16000);
  for(let index=0;index<total;index++)chunks.push(await seal(JSON.stringify({attempt:checkpoint.attempt,index,total,data:characters.slice(index*16000,(index+1)*16000).join('')}),checkpointSecret(env)));
  const object=await env.FILES.put(key(checkpoint.attempt),JSON.stringify({format:'encrypted-draft-preview-v1',chunks} satisfies Envelope),{
    onlyIf:etag?{etagMatches:etag}:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}
  });
  if(!object)throw new DraftCheckpointBusy();
  return object.etag;
}
