import { checkpointAttemptIds } from './ai-checkpoints';
import { checkpointSecret, sealChunkedEnvelope, unsealChunkedEnvelope, type SecretKeyring } from '../ai/secrets';
import type { Env } from '../env';
import { withStorageOwner } from './managed-storage';
import type { ToolExchange,WebCitation } from '../ai/tool-transport';
import type { GatewayCallOutput, ProviderRetryState } from '../ai/gateway';
import type { ProjectReference } from './project-evidence';
import type { ContextPhase } from '../ai/context-phases';
import { nowIso } from '../core/db';
import { invalidState } from '../core/errors';
/** Yield only after the model response/tool progress is durably checkpointed. */
export class InvestigationContinuation extends Error {
  readonly safeToResume=true;
  constructor(message='调查已安全保存，将在下一次执行中继续') {
    super(message);this.name='InvestigationContinuation';
  }
}
export interface InvestigationCheckpoint {
  contextPhase?:ContextPhase;
  effectiveStandardsVersionId?:string|null;
  step: number; exchanges: ToolExchange[]; references: ProjectReference[];
  trace: Array<{name:string;status:string;fileId?:string}>;
  compacted?: string; pendingDispatch?: boolean; content?: string;
  pendingOutput?: GatewayCallOutput;
  pendingResults?: ToolExchange['results'];
  pendingSearchOutput?: GatewayCallOutput;
  citations?: WebCitation[];
  searchUsed?: boolean;
  providerRetry?: ProviderRetryState;
  executionGeneration?: number;
}
interface EncryptedCheckpoint {
  format:'encrypted-investigation-v1';step:number;phase:'complete'|'read';chunks:string[];
}
async function encryptCheckpoint(checkpoint:InvestigationCheckpoint,id:string,secret:string | SecretKeyring):Promise<EncryptedCheckpoint> {
  const { chunks } = await sealChunkedEnvelope('encrypted-investigation-v1', 'id', id, checkpoint, secret);
  return {format:'encrypted-investigation-v1',step:checkpoint.step,phase:checkpoint.content?'complete':'read',chunks};
}
async function decryptCheckpoint(envelope:EncryptedCheckpoint,id:string,secret:string | SecretKeyring):Promise<InvestigationCheckpoint> {
  return unsealChunkedEnvelope<InvestigationCheckpoint>(
    envelope,
    'encrypted-investigation-v1',
    'id',
    id,
    secret,
    { invalidFormat: '调查检查点加密格式无效', mismatch: '调查检查点加密内容不匹配' },
  );
}
export async function loadInvestigation(env: Env, id: string, allowUncertainDispatch=false,jobId?:string): Promise<InvestigationCheckpoint | null> {
  let stored:R2ObjectBody|null=null;
  if(jobId){for(const attempt of await checkpointAttemptIds(env,jobId)){stored=await env.FILES.get(`ai/investigations/${id}/${attempt}.json`);if(stored)break;}}
  else {const row=await env.DB.prepare('SELECT checkpoint_key FROM ai_investigations WHERE id=?1').bind(id).first<{checkpoint_key:string}>();if(row)stored=await env.FILES.get(row.checkpoint_key);}
  stored??=await env.FILES.get(`ai/investigations/${id}.json`);
  if(!stored) return null;
  const data=await stored.json<InvestigationCheckpoint|EncryptedCheckpoint>();
  const checkpoint='format' in data&&data.format==='encrypted-investigation-v1'
    ? await decryptCheckpoint(data,id,checkpointSecret(env)) : data as InvestigationCheckpoint;
  if(checkpoint.pendingDispatch && !allowUncertainDispatch) throw invalidState('上次模型请求已派发但结果未确认；请从停止处继续，该步骤可能再次计费');
  if(checkpoint.pendingDispatch) { checkpoint.pendingDispatch=false; checkpoint.providerRetry=undefined; }
  return checkpoint;
}
export async function saveInvestigation(env: Env, context:{projectId:string;userId:string;jobId?:string}, id:string, promptVersion:string, checkpoint:InvestigationCheckpoint, privateContext=false) {
  if(context.jobId && await env.DB.prepare('SELECT 1 FROM admin_ai_retry_links WHERE parent_job_id=?1').bind(context.jobId).first())throw invalidState('任务已由新尝试继续，旧结果不会保存');
  const key=context.jobId?`ai/investigations/${id}/${context.jobId}.json`:`ai/investigations/${id}.json`;
  const phase=checkpoint.content?'complete':'read';
  const stored=await encryptCheckpoint(checkpoint,id,checkpointSecret(env));
  await withStorageOwner(env,{userId:context.userId,projectId:context.projectId,category:'system'}).FILES.put(key,JSON.stringify(stored),{httpMetadata:{contentType:'application/json'},customMetadata:{step:String(checkpoint.step),phase}});
  await env.DB.prepare(`INSERT INTO ai_investigations(id,project_id,job_id,requested_by,prompt_version,checkpoint_key,phase,step,updated_at)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9 WHERE ?3 IS NULL OR EXISTS(SELECT 1 FROM jobs WHERE id=?3 AND status IN ('queued','running','waiting_input') AND NOT EXISTS(SELECT 1 FROM admin_ai_retry_links WHERE parent_job_id=?3)) ON CONFLICT(id) DO UPDATE SET job_id=excluded.job_id,checkpoint_key=excluded.checkpoint_key,phase=excluded.phase,step=excluded.step,updated_at=excluded.updated_at`)
    .bind(id,context.projectId,context.jobId??null,context.userId,promptVersion,key,phase,checkpoint.step,nowIso()).run();
}
/** Deterministic compaction retains resource locators and exact read excerpts; the model can reread omitted content. */
export function compactExchanges(exchanges:ToolExchange[], maxChars:number): {exchanges:ToolExchange[];summary:string} {
  const kept:ToolExchange[]=[];let size=0;
  for(let i=exchanges.length-1;i>=0;i--) {const n=JSON.stringify(exchanges[i]).length;if(size+n>maxChars)break;kept.unshift(exchanges[i]!);size+=n;}
  const removed=exchanges.slice(0,exchanges.length-kept.length);
  const summary=removed.flatMap(e=>e.results.map(r=>({tool:r.call.name,args:r.call.args,
    result: typeof r.output==='object'&&r.output ? Object.fromEntries(Object.entries(r.output).filter(([k])=>!['text','fragments','body'].includes(k)).map(([k,v])=>[k,k==='items'&&Array.isArray(v)?v.map(item=>({id:item.id,resourceId:item.resourceId,versionId:item.versionId,title:item.title})):v])) : r.output}))) ;
  return {exchanges:kept,summary:JSON.stringify(summary)};
}
