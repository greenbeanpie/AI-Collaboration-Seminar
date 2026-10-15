import { checkpointSecret, sealChunkedEnvelope, unsealChunkedEnvelope } from '../ai/secrets';
import type { Env } from '../env';
import { withManagedStorage } from './managed-storage';
import type { GatewayCallOutput } from '../ai/gateway';
import type { ToolExchange } from '../ai/tool-transport';
import type { ContextPhase } from '../ai/context-phases';
import type { DraftPayload, creationGoal } from './creation-drafts';
import type { z } from 'zod';
import { invalidState } from '../core/errors';

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
  resourceWaitUntil?: number;
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
interface Envelope { format:'encrypted-draft-preview-v1';chunks:string[] }
export class DraftCheckpointBusy extends Error {
  constructor() { super('同一预览已由另一请求处理；请刷新状态'); this.name='DraftCheckpointBusy'; }
}
const key = (attempt:string) => `ai/draft-investigations/${attempt}.json`;

export async function loadDraftCheckpoint(env:Env,attempt:string):Promise<{checkpoint:DraftPreviewCheckpoint;etag:string}|null> {
  const object=await env.FILES.get(key(attempt));
  if(!object)return null;
  const envelope=await object.json<Envelope>();
  const checkpoint=await unsealChunkedEnvelope<DraftPreviewCheckpoint>(
    envelope,
    'encrypted-draft-preview-v1',
    'attempt',
    attempt,
    checkpointSecret(env),
    { invalidFormat: '预览检查点格式无效', mismatch: '预览检查点内容不匹配' },
  );
  if(checkpoint.version!==1||checkpoint.attempt!==attempt)throw invalidState('预览检查点版本无效');
  return {checkpoint,etag:object.etag};
}

/** Conditional writes serialize all executions of one attempt, including answer retries. */
export async function saveDraftCheckpoint(env:Env,checkpoint:DraftPreviewCheckpoint,etag?:string):Promise<string> {
  const envelope=await sealChunkedEnvelope('encrypted-draft-preview-v1','attempt',checkpoint.attempt,checkpoint,checkpointSecret(env));
  const object=await withManagedStorage(env,{userId:checkpoint.userId,projectId:null,category:'system'}).FILES.put(key(checkpoint.attempt),JSON.stringify(envelope satisfies Envelope),{
    onlyIf:etag?{etagMatches:etag}:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}
  });
  if(!object)throw new DraftCheckpointBusy();
  return object.etag;
}
