import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from './helpers/env';
import { seedProject, seedUser } from './helpers/seed';
import { configureGoFixture } from './helpers/provider-config';
import { loadAiConfig } from '../src/ai/config';
import { newId, nowIso } from '../src/core/db';
import { reserveAiSlot } from '../src/services/budget';
import { projectToolConversation } from '../src/services/project-ai-tools';
import { InvestigationContinuation, loadInvestigation } from '../src/services/project-investigation';
afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  await configureGoFixture();
  const owner = await seedUser(), projectId = await seedProject(owner.userId), jobId = newId();
  const config = (await loadAiConfig(env.DB))!;
  await reserveAiSlot(env, { projectId, jobId, purpose: 'review_run', maxCalls: 24 });
  await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_at,updated_at) VALUES(?1,?2,'review_run','running','{}',?3,?3)").bind(jobId, projectId, nowIso()).run();
  return { owner, projectId, jobId, params: {
    context: { projectId, userId: owner.userId, jobId }, config: config.config.review,
    configVersionId: config.id, purpose: 'review' as const, privateContext: true,
    messages: [{ role: 'user' as const, content: '自主调查' }], promptVersion: 'execution-slice-fixture',
  } };
}
describe('durable autonomous investigation execution slices', () => {
  it('persists three provider retries across instances without replaying successful responses', async () => {
    const f=await fixture();
    const fetch=vi.fn(async()=>fetch.mock.calls.length<=3 ? new Response('',{status:503}) : Response.json({choices:[{finish_reason:'stop',message:{content:'{"summary":"恢复成功","referenceIds":[],"decisionReferences":[]}'}}],usage:{prompt_tokens:10,completion_tokens:5}}));
    vi.stubGlobal('fetch',fetch);
    const due:number[]=[];
    for(let attempt=1;attempt<=3;attempt++) {
      await expect(projectToolConversation({...env,AI_EXECUTION_SLICE:true},f.params)).rejects.toBeInstanceOf(InvestigationContinuation);
      const saved=await loadInvestigation(env,f.jobId+'-'+f.params.promptVersion);
      expect(saved?.pendingDispatch).toBe(false);
      expect(saved?.providerRetry?.attempt).toBe(attempt);
      due.push(saved!.providerRetry!.nextAttemptAt);
      expect(fetch).toHaveBeenCalledTimes(attempt);
    }
    const result=await projectToolConversation({...env,AI_EXECUTION_SLICE:true},f.params);
    expect(result.content).toContain('恢复成功');expect(fetch).toHaveBeenCalledTimes(4);
    await projectToolConversation({...env,AI_EXECUTION_SLICE:true},f.params);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(due[1]! - due[0]!).toBeGreaterThanOrEqual(5000);
    expect(due[2]! - due[1]!).toBeGreaterThanOrEqual(15000);
    expect((await env.DB.prepare('SELECT attempts_started FROM usage_reservations WHERE job_id=?1').bind(f.jobId).first<{attempts_started:number}>())?.attempts_started).toBe(4);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM ai_calls WHERE job_id=?1').bind(f.jobId).first<{n:number}>())?.n).toBe(4);
  }, 40_000);
  it('continues 14 tool reads across separate invocations without replaying paid responses or completed tools', async () => {
    const f = await fixture();
    const fetch = vi.fn(async () => Response.json({ choices: [{ finish_reason: fetch.mock.calls.length === 1 ? 'tool_calls' : 'stop', message: fetch.mock.calls.length === 1 ? {
      content: 'private assistant reasoning must stay encrypted',
      tool_calls: Array.from({ length: 14 }, (_, i) => ({ id: `read-${i}`, type: 'function', function: { name: 'list_project_resources', arguments: JSON.stringify({ offset: i * 20 }) } })),
    } : { content: '{"summary":"完成","referenceIds":[],"decisionReferences":[]}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    vi.stubGlobal('fetch', fetch);
    let slices = 0, previousReads = 0, result;
    for (; slices < 20; slices++) {
      try { result = await projectToolConversation({ ...env, AI_EXECUTION_SLICE: true }, f.params); break; }
      catch (error) { expect(error).toBeInstanceOf(InvestigationContinuation); }
      const reads = (await env.DB.prepare('SELECT COUNT(*) count FROM ai_tool_calls WHERE job_id=?1').bind(f.jobId).first<{ count: number }>())!.count;
      expect(reads - previousReads).toBeLessThanOrEqual(4); previousReads = reads;
    }
    expect(slices).toBe(5); expect(result?.trace).toHaveLength(14); expect(fetch).toHaveBeenCalledTimes(2);
    expect((await env.DB.prepare('SELECT COUNT(*) count FROM ai_tool_calls WHERE job_id=?1').bind(f.jobId).first<{ count: number }>())!.count).toBe(14);
    await projectToolConversation({ ...env, AI_EXECUTION_SLICE: true }, f.params);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('rechecks membership on continuation before another read or paid call', async () => {
    const f = await fixture();
    const fetch = vi.fn(async () => Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'read', type: 'function', function: { name: 'list_project_resources', arguments: '{}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    vi.stubGlobal('fetch', fetch);
    await expect(projectToolConversation({ ...env, AI_EXECUTION_SLICE: true }, f.params)).rejects.toBeInstanceOf(InvestigationContinuation);
    await env.DB.prepare('DELETE FROM project_members WHERE project_id=?1 AND user_id=?2').bind(f.projectId, f.owner.userId).run();
    await expect(projectToolConversation({ ...env, AI_EXECUTION_SLICE: true }, f.params)).rejects.toThrow('权限已变化');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await env.DB.prepare('SELECT COUNT(*) count FROM ai_tool_calls WHERE job_id=?1').bind(f.jobId).first<{ count: number }>())!.count).toBe(0);
  });
});
