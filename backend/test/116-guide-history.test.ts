import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from './helpers/env';
import { seedProject, seedUser } from './helpers/seed';
import { newId, nowIso } from '../src/core/db';
import { buildGuideHistory, executeGuideHistoryTool, guideHistoryDefinitions } from '../src/services/guide-history';
import { referencesFromRead, validateReadReferences } from '../src/services/project-evidence';
import { projectReferenceGuard } from '../src/services/project-reference-guard';
import { InvestigationContinuation, loadInvestigation, saveInvestigation } from '../src/services/project-investigation';
import { projectToolConversation } from '../src/services/project-ai-tools';
import { configureGoFixture } from './helpers/provider-config';
import { loadAiConfig } from '../src/ai/config';
import { reserveAiSlot } from '../src/services/ai-reservations';
afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  const owner = await seedUser(), projectId = await seedProject(owner.userId), sessionId = newId(), turnId = newId(), now = nowIso();
  const answer = '甲'.repeat(7980) + 'TAIL-ANSWER-SENTINEL';
  await env.DB.batch([
    env.DB.prepare("INSERT INTO agent_sessions(id,project_id,capability,created_by,created_at,updated_at) VALUES(?1,?2,'guide',?3,?4,?4)").bind(sessionId, projectId, owner.userId, now),
    env.DB.prepare("INSERT INTO agent_turns(id,session_id,project_id,sequence,role,kind,payload_json,created_at) VALUES(?1,?2,?3,1,'user','answer',?4,?5)").bind(turnId, sessionId, projectId, JSON.stringify({ answer }), now),
  ]);
  return { context: { projectId, userId: owner.userId, guideSessionId: sessionId }, turnId, answer };
}
describe('server-bound paged guide history', () => {
  it('advertises pagination bounds that match execution for both history tools', async () => {
    const f = await fixture();
    for (const tool of guideHistoryDefinitions) {
      const properties = tool.parameters.properties as Record<string, { maximum?: number }>;
      const maximum = properties.offset!.maximum;
      expect(typeof maximum).toBe('number');
      const args = tool.name === 'read_guide_turn' ? { turnId: f.turnId, offset: maximum } : { offset: maximum };
      await expect(executeGuideHistoryTool(env, f.context, tool.name, args)).resolves.toHaveProperty('nextOffset', null);
      await expect(executeGuideHistoryTool(env, f.context, tool.name, { ...args, offset: maximum! + 1 })).rejects.toThrow();
    }
  });
  it('executes paged history tool calls across slices and reuses the completed response without paying again', async () => {
    await configureGoFixture();
    const f = await fixture(), config = (await loadAiConfig(env.DB))!, jobId = newId();
    await reserveAiSlot(env, { projectId: f.context.projectId, jobId, purpose: 'agent_run', maxCalls: 5 });
    await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_at,updated_at) VALUES(?1,?2,'agent_run','running','{}',?3,?3)").bind(jobId, f.context.projectId, nowIso()).run();
    let round = 0;
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(JSON.stringify(body.tools)).toContain('read_guide_turn');
      if (round++ === 0) return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [0, 4000].map(offset => ({ id: 'read-' + offset, type: 'function', function: { name: 'read_guide_turn', arguments: JSON.stringify({ turnId: f.turnId, offset }) } })) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      expect(JSON.stringify(body.messages)).toContain('TAIL-ANSWER-SENTINEL');
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ type: 'draft', content: '采用回答末尾信息', referenceIds: [`guide_turn:${f.context.guideSessionId}:4000`] }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    });
    vi.stubGlobal('fetch', fetch);
    const params = { context: { ...f.context, jobId }, config: config.config.textEconomy, configVersionId: config.id, messages: [{ role: 'user' as const, content: await buildGuideHistory(env, f.context) }], promptVersion: 'guide-slice-test', privateContext: true };
    const slicedEnv = { ...env, AI_EXECUTION_SLICE: true as const };
    let result: Awaited<ReturnType<typeof projectToolConversation>> | undefined;
    for (let attempt = 0; attempt < 6 && !result; attempt++) {
      try { result = await projectToolConversation(slicedEnv, params); }
      catch (error) { if (!(error instanceof InvestigationContinuation)) throw error; }
    }
    expect(result).toBeDefined();
    expect(result!.references.some(ref => ref.resourceType === 'guide_turn' && ref.usage === 'decision' && ref.quote?.includes('TAIL-ANSWER-SENTINEL'))).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await projectToolConversation(slicedEnv, params)).content).toBe(result!.content);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('reaches the end of an 8000-character answer without loading it into the initial input', async () => {
    const f = await fixture(), initial = await buildGuideHistory(env, f.context);
    expect(initial.length).toBeLessThan(3000);
    expect(initial).toContain('read_guide_turn');
    expect(initial).not.toContain('TAIL-ANSWER-SENTINEL');
    const first = await executeGuideHistoryTool(env, f.context, 'read_guide_turn', { turnId: f.turnId, offset: 0 });
    const last = await executeGuideHistoryTool(env, f.context, 'read_guide_turn', { turnId: f.turnId, offset: first.nextOffset });
    expect(String(first.text) + String(last.text)).toBe(f.answer);
    expect(last.text).toContain('TAIL-ANSWER-SENTINEL');
    expect(last.nextOffset).toBeNull();
    expect(referencesFromRead(await executeGuideHistoryTool(env, f.context, 'list_guide_turns', { offset: 0 }))).toEqual([]);
    await validateReadReferences(env, f.context.projectId, [...referencesFromRead(first), ...referencesFromRead(last)]);
  });
  it('rejects other users, projects, sessions and model-supplied session selectors', async () => {
    const f = await fixture(), other = await fixture(), stranger = await seedUser();
    await env.DB.prepare("INSERT INTO project_members(project_id,user_id,role,joined_at) VALUES(?1,?2,'member',?3)").bind(f.context.projectId, stranger.userId, nowIso()).run();
    await expect(executeGuideHistoryTool(env, { ...f.context, userId: stranger.userId }, 'list_guide_turns', { offset: 0 })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(executeGuideHistoryTool(env, { ...f.context, projectId: other.context.projectId }, 'list_guide_turns', { offset: 0 })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(executeGuideHistoryTool(env, f.context, 'read_guide_turn', { turnId: other.turnId, offset: 0 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(executeGuideHistoryTool(env, f.context, 'read_guide_turn', { turnId: f.turnId, offset: 0, sessionId: other.context.guideSessionId })).rejects.toThrow();
    await expect(executeGuideHistoryTool(env, { projectId: f.context.projectId, userId: f.context.userId }, 'list_guide_turns', { offset: 0 })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
  it('keeps actual read quotes through encrypted continuation, checks them atomically and charges no extra AI call', async () => {
    const f = await fixture(), checkpointId = newId();
    const before = await env.DB.prepare('SELECT COUNT(*) count FROM ai_calls').first<{ count: number }>();
    const read = await executeGuideHistoryTool(env, f.context, 'read_guide_turn', { turnId: f.turnId, offset: 4000 });
    const references = referencesFromRead(read);
    await saveInvestigation(env, f.context, checkpointId, 'guide-test', { step: 1, exchanges: [], references, trace: [] }, true);
    const restored = (await loadInvestigation(env, checkpointId))!;
    expect(restored.references).toEqual(references);
    await validateReadReferences(env, f.context.projectId, restored.references);
    const atomic = () => env.DB.prepare(`SELECT ${projectReferenceGuard('?1', '?2')} valid`).bind(JSON.stringify(restored.references), f.context.projectId).first<{ valid: number }>();
    expect((await atomic())!.valid).toBe(1);
    await env.DB.prepare("UPDATE agent_turns SET payload_json='{}' WHERE id=?1").bind(f.turnId).run();
    await expect(validateReadReferences(env, f.context.projectId, restored.references)).rejects.toThrow('引用不符');
    expect((await atomic())!.valid).toBe(0);
    expect((await env.DB.prepare('SELECT COUNT(*) count FROM ai_calls').first<{ count: number }>())!.count).toBe(before!.count);
  });
});
