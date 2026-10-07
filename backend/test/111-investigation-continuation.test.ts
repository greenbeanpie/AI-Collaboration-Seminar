import { describe,it,expect } from 'vitest';
import { env } from './helpers/env';
import { seedProject,seedUser } from './helpers/seed';
import { newId } from '../src/core/db';
import { InvestigationContinuation,loadInvestigation,saveInvestigation,type InvestigationCheckpoint } from '../src/services/project-investigation';

async function fixture(){const owner=await seedUser(),projectId=await seedProject(owner.userId);return {context:{projectId,userId:owner.userId},id:newId()};}
function checkpoint():InvestigationCheckpoint {
  const calls=[{id:'call-1',name:'read_task',args:{id:'task-1'}},{id:'call-2',name:'read_admin_feedback',args:{}}];
  return {step:3,exchanges:[{assistant:{role:'assistant',content:'私密偏好与工作经历',tool_calls:calls},results:[]}],references:[],trace:[{name:'read_task',status:'ok'}],compacted:'私密调查历史',
    pendingOutput:{content:'模型私密判断',promptTokens:21,completionTokens:12,latencyMs:50,toolOutput:{content:'模型私密判断',assistant:{role:'assistant',content:'私密助手消息',tool_calls:calls},toolCalls:calls,citations:[]}},
    pendingResults:[{call:calls[0]!,output:{title:'私密已完成工具结果',revision:2}}]};
}
describe('durable investigation continuation',()=>{
  it('identifies safe continuation without masquerading as an uncertain dispatch',()=>{
    const continuation=new InvestigationContinuation();expect(continuation).toBeInstanceOf(Error);expect(continuation.name).toBe('InvestigationContinuation');expect(continuation.safeToResume).toBe(true);
  });
  it('encrypts all private protocol state while restoring pending output and partial tool results exactly',async()=>{
    const f=await fixture(),state=checkpoint();await saveInvestigation(env,f.context,f.id,'private-resume-v1',state,true);
    const object=(await env.FILES.get(`ai/investigations/${f.id}.json`))!,raw=await object.text(),envelope=JSON.parse(raw);
    expect(envelope).toMatchObject({format:'encrypted-investigation-v1',step:3,phase:'read'});
    expect(object.customMetadata).toEqual({step:'3',phase:'read'});
    for(const secret of ['私密偏好与工作经历','私密调查历史','模型私密判断','私密助手消息','私密已完成工具结果','pendingOutput','pendingResults','assistant'])expect(raw).not.toContain(secret);
    expect(await loadInvestigation(env,f.id)).toEqual(state);
    expect(await env.DB.prepare('SELECT phase,step FROM ai_investigations WHERE id=?1').bind(f.id).first()).toEqual({phase:'read',step:3});
  });
  it('encrypts checkpoints by default while preserving partial tool results',async()=>{
    const f=await fixture(),state=checkpoint();await saveInvestigation(env,f.context,f.id,'old-format',state);
    expect(await (await env.FILES.get(`ai/investigations/${f.id}.json`))!.json()).toMatchObject({format:'encrypted-investigation-v1'});
    expect(await loadInvestigation(env,f.id)).toEqual(state);
    expect(await loadInvestigation(env,newId())).toBeNull();
  });
  it.each([false,true])('refuses uncertain paid replay after pendingDispatch, encrypted=%s',async privateContext=>{
    const f=await fixture();await saveInvestigation(env,f.context,f.id,'uncertain-dispatch',{...checkpoint(),pendingDispatch:true},privateContext);
    await expect(loadInvestigation(env,f.id)).rejects.toThrow('结果未确认');
  });
  it('encrypts completed content and restores large multilingual checkpoints without truncation',async()=>{
    const f=await fixture(),state={...checkpoint(),content:'私密最终决策',compacted:'🔐私密历史中文'.repeat(25000)};
    await saveInvestigation(env,f.context,f.id,'large-private',state,true);
    const object=(await env.FILES.get(`ai/investigations/${f.id}.json`))!,raw=await object.text();
    expect(JSON.parse(raw).chunks.length).toBeGreaterThan(1);expect(raw).not.toContain('私密最终决策');expect(object.customMetadata?.phase).toBe('complete');
    expect(await loadInvestigation(env,f.id)).toEqual(state);
  });
  it('rejects wrong secrets, moved ciphertext, and reordered encrypted chunks',async()=>{
    const f=await fixture();await saveInvestigation(env,f.context,f.id,'bound-checkpoint',{...checkpoint(),compacted:'🔐隐私'.repeat(10000)},true);
    await expect(loadInvestigation({...env,AUTH_SECRET:'wrong-secret'},f.id)).rejects.toThrow();
    const raw=await (await env.FILES.get(`ai/investigations/${f.id}.json`))!.text(),otherId=newId();
    await env.FILES.put(`ai/investigations/${otherId}.json`,raw);await expect(loadInvestigation(env,otherId)).rejects.toThrow('不匹配');
    const envelope=JSON.parse(raw);envelope.chunks.reverse();await env.FILES.put(`ai/investigations/${f.id}.json`,JSON.stringify(envelope));
    await expect(loadInvestigation(env,f.id)).rejects.toThrow('不匹配');
  });
});
