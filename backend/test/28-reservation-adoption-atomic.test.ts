import { executeAiSlice, ensureInitialExecutionSlice } from '../src/services/ai-execution-slices';
import { readExecution } from '../src/services/ai-execution-control';
import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { loadAiConfig } from '../src/ai/config';
import { aiJsonCall } from '../src/services/agent';
import { markAiCallStarted, reserveAiSlot, settleReservation, withReservedAiJob } from '../src/services/ai-reservations';
import { gatewayChat } from '../src/ai/gateway';
import { recordAiCall } from '../src/ai/calls';
import type { Env } from '../src/env';

await env.DB.prepare('UPDATE ai_config_versions SET enabled = 1').run();
afterEach(() => vi.unstubAllGlobals());

async function projectFixture() {
  const owner = await seedUser();
  const pid = await seedProject(owner.userId);
  const cfg = (await loadAiConfig(env.DB))!;
  return { owner, pid, cfg };
}

async function reservation(jobId: string) {
  return env.DB.prepare('SELECT status, attempts_started FROM usage_reservations WHERE job_id = ?1 ORDER BY created_at DESC LIMIT 1').bind(jobId).first<{ status: string; attempts_started: number }>();
}

describe('AI admission, call tracking and bounded inputs', () => {
  it('creates an AI concurrency reservation without monetary checks', async () => {
    const { pid } = await projectFixture();
    await expect(reserveAiSlot(env, { projectId: pid, jobId: `reservation-${pid}`, purpose: 'agent_run' })).resolves.toBeUndefined();
  });

  it('freezes config before creation and releases only failed uncreated jobs', async () => {
    const { pid, cfg } = await projectFixture();
    let id = '';
    await expect(withReservedAiJob(env, { projectId: pid, purpose: 'agent_run' }, async (jobId, configId) => {
      id = jobId;
      expect(configId).toBe(cfg.id);
      expect((await reservation(id))?.status).toBe('reserved');
      throw new Error('create failed');
    })).rejects.toThrow('create failed');
    expect((await reservation(id))?.status).toBe('released');
  });

  it('records invalid and repaired calls with task and reservation attribution', async () => {
    const { pid, cfg } = await projectFixture();
    const jobId = crypto.randomUUID();
    await reserveAiSlot(env, { projectId: pid, jobId, purpose: 'agent_run', configVersionId: cfg.id });
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: calls++ ? '{"ok":true}' : 'invalid json' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))));
    const result = await aiJsonCall(env, { projectId: pid, jobId, configVersionId: cfg.id, model: cfg.config.textEconomy.model, modelConfig: cfg.config.textEconomy, purpose: 'textEconomy', promptVersion: 'test', messages: [{ role: 'user', content: '你好' }], schema: z.object({ ok: z.literal(true) }) });
    expect(result.repaired).toBe(true);
    await settleReservation(env, jobId, 'released');
    expect(await reservation(jobId)).toMatchObject({ status: 'settled', attempts_started: 2 });
    const rows = await env.DB.prepare('SELECT status, reservation_id, prompt_tokens, completion_tokens FROM ai_calls WHERE job_id = ?1 ORDER BY created_at').bind(jobId).all<{ status: string; reservation_id: string; prompt_tokens:number|null; completion_tokens:number|null }>();
    expect(rows.results.map(row => row.status).sort()).toEqual(['invalid', 'repaired']);
    expect(rows.results.every(row => row.reservation_id && row.prompt_tokens === 10 && row.completion_tokens === 5)).toBe(true);
  });

  it('protects a paused unknown request at the Workflow boundary without replaying it', async () => {
    const { pid, cfg } = await projectFixture();
    const jobId = crypto.randomUUID(),now=new Date().toISOString();
    await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_at,updated_at) VALUES(?1,?2,'agent_run','running','{}',?3,?3)").bind(jobId,pid,now).run();
    await ensureInitialExecutionSlice(env,jobId);
    await reserveAiSlot(env, { projectId: pid, jobId, purpose: 'agent_run' });
    const provider=vi.fn(async () => { throw new DOMException('timed out', 'TimeoutError'); });vi.stubGlobal('fetch', provider);
    const run=async()=>{await aiJsonCall(env, { projectId: pid, jobId, configVersionId: cfg.id, model: cfg.config.textEconomy.model, modelConfig: cfg.config.textEconomy, purpose: 'textEconomy', promptVersion: 'test', messages: [{ role: 'user', content: '你好' }], schema: z.object({ ok: z.literal(true) }) });};
    await executeAiSlice(env,jobId,0,run);await executeAiSlice(env,jobId,0,run);
    expect(provider).toHaveBeenCalledOnce();
    expect(await readExecution(env,{kind:'job',id:jobId})).toMatchObject({state:'paused',pauseReason:'request_uncertain',totalCalls:1});
    expect(await env.DB.prepare('SELECT status FROM jobs WHERE id=?1').bind(jobId).first()).toMatchObject({status:'waiting_input'});
    expect(await reservation(jobId)).toMatchObject({ status: 'reserved', attempts_started: 1 });
    const lost = crypto.randomUUID();
    await reserveAiSlot(env, { projectId: pid, jobId: lost, purpose: 'agent_run' });
    await markAiCallStarted(env, lost); // simulate crash before recording response
    await settleReservation(env, lost, 'released');
    expect((await reservation(lost))?.status).toBe('settled');
    // Completed requests do not occupy running concurrency slots.
    await expect(reserveAiSlot(env, { projectId: pid, jobId: crypto.randomUUID(), purpose: 'agent_run' })).resolves.toBeUndefined();
  });

  it('stage reservations cannot charge earlier calls again, and same-job concurrent reservation is unique', async () => {
    const { pid, cfg } = await projectFixture(); const jobId = crypto.randomUUID();
    await Promise.all([reserveAiSlot(env, { projectId: pid, jobId, purpose: 'agent_run' }), reserveAiSlot(env, { projectId: pid, jobId, purpose: 'agent_run' })]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_reservations WHERE job_id = ?1 AND status = 'reserved'").bind(jobId).first<{ n: number }>())?.n).toBe(1);
    for (let stage = 0; stage < 2; stage++) {
      if (stage) await reserveAiSlot(env, { projectId: pid, jobId, purpose: 'requirement_extract' });
      await markAiCallStarted(env, jobId);
      await recordAiCall(env, { projectId: pid, jobId, purpose: 'textEconomy', configVersionId: cfg.id, promptVersion: 'test', model: cfg.config.textEconomy.model, input: {}, output: {}, promptTokens: 1, completionTokens: 2, latencyMs: 1, status: 'ok' });
      await settleReservation(env, jobId, 'settled');
    }
    const rows = await env.DB.prepare('SELECT status, attempts_started FROM usage_reservations WHERE job_id = ?1').bind(jobId).all<{ status:string; attempts_started:number }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results.map(row => row.status)).toEqual(['settled', 'settled']);
    expect(rows.results.map(row => row.attempts_started)).toEqual([1, 1]);
  });

  it('call ledger storage failure preserves the attempt marker and sends no repair request', async () => {
    const { pid, cfg } = await projectFixture(); const jobId = crypto.randomUUID();
    await reserveAiSlot(env, { projectId: pid, jobId, purpose: 'agent_run' });
    const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })));
    vi.stubGlobal('fetch', fetch);
    const broken = { ...env, FILES: { put: async () => { throw new Error('R2 write failed'); } } } as unknown as Env;
    await expect(aiJsonCall(broken, { projectId: pid, jobId, configVersionId: cfg.id, model: cfg.config.textEconomy.model, modelConfig: cfg.config.textEconomy, purpose: 'textEconomy', promptVersion: 'test', messages: [{ role: 'user', content: '你好' }], schema: z.object({ ok: z.literal(true) }) })).rejects.toThrow('R2 write failed');
    expect(fetch).toHaveBeenCalledTimes(1);
    await settleReservation(env, jobId, 'released');
    expect(await reservation(jobId)).toMatchObject({ status: 'settled', attempts_started: 1 });
  });

  it('invalid upstream token numbers are omitted from call usage', async () => {
    const { pid, cfg } = await projectFixture(); const jobId = crypto.randomUUID();
    await reserveAiSlot(env, { projectId: pid, jobId, purpose: 'agent_run' });
    for (const promptTokens of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await recordAiCall(env, { projectId: pid, jobId, purpose: 'textEconomy', configVersionId: cfg.id, promptVersion: 'test', model: cfg.config.textEconomy.model, input: {}, output: {}, promptTokens, completionTokens: 1, latencyMs: 1, status: 'invalid' });
    }
    const calls = await env.DB.prepare('SELECT prompt_tokens, completion_tokens FROM ai_calls WHERE job_id = ?1').bind(jobId).all();
    expect(calls.results).toHaveLength(4);
    expect(calls.results.every(row => row.prompt_tokens === null && row.completion_tokens === 1)).toBe(true);
    await settleReservation(env, jobId, 'released');
    expect((await reservation(jobId))?.status).toBe('released');
  });

  it('enforces message/input bounds before request', async () => {
    const { cfg } = await projectFixture();
    const model = { ...cfg.config.textEconomy, maxInputChars: 2 };
    const fetch = vi.fn(); const beforeFetch = vi.fn();
    await expect(gatewayChat({ accountId: 'a', apiToken: 't', gatewayId: 'g' }, { config: model, messages: [{ role: 'user', content: '中文超限' }], beforeFetch }, fetch)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(fetch).not.toHaveBeenCalled(); expect(beforeFetch).not.toHaveBeenCalled();
  });
});

describe('A08 contested adoption has no orphan version or event', () => {
  it('two different idempotency keys cannot adopt one run into two materials', async () => {
    const owner = await seedUser(); const pid = await seedProject(owner.userId); const cookie = authCookie(owner.token);
    const materialIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/materials`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ title: `材料${i}` }) });
      materialIds.push((await res.json() as { data: { materialId: string } }).data.materialId);
    }
    const runId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO agent_runs (id, project_id, capability, mode, status, inputs_json, output_json, prompt_version, created_at) VALUES (?1, ?2, 'do', 'do', 'succeeded', '{}', '{\"markdown\":\"草稿\"}', 'test', ?3)").bind(runId, pid, new Date().toISOString()).run();
    const responses = await Promise.all(materialIds.map(materialId => SELF.fetch(`${BASE}/api/v1/projects/${pid}/agent-runs/${runId}/adopt`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ materialId, expectedRevision: 1, reviewed: true, doc: { type: 'doc', content: [] } }) })));
    expect(responses.map(res => res.status).sort()).toEqual([201, 409]);
    const version = await env.DB.prepare('SELECT id FROM material_versions WHERE ai_run_id = ?1').bind(runId).all<{ id: string }>();
    expect(version.results).toHaveLength(1);
    const events = await env.DB.prepare("SELECT entity_id FROM events WHERE project_id = ?1 AND type = 'material.adopted'").bind(pid).all<{ entity_id: string }>();
    expect(events.results).toEqual([{ entity_id: version.results[0]!.id }]);
    const run = await env.DB.prepare('SELECT status, adoption_material_version_id FROM agent_runs WHERE id = ?1').bind(runId).first();
    expect(run).toMatchObject({ status: 'adopted', adoption_material_version_id: version.results[0]!.id });
    // 两个独立运行争抢同一材料 revision：失败者不改运行状态，也不留事件。
    const untouched = await env.DB.prepare('SELECT id FROM materials WHERE project_id = ?1 AND revision = 1').bind(pid).first<{ id: string }>();
    const competingRuns = [crypto.randomUUID(), crypto.randomUUID()];
    for (const id of competingRuns) await env.DB.prepare("INSERT INTO agent_runs (id, project_id, capability, mode, status, inputs_json, output_json, prompt_version, created_at) VALUES (?1, ?2, 'do', 'do', 'succeeded', '{}', '{\"markdown\":\"草稿\"}', 'test', ?3)").bind(id, pid, new Date().toISOString()).run();
    const competing = await Promise.all(competingRuns.map(id => SELF.fetch(`${BASE}/api/v1/projects/${pid}/agent-runs/${id}/adopt`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ materialId: untouched!.id, expectedRevision: 1, reviewed: true, doc: { type: 'doc', content: [] } }) })));
    expect(competing.map(res => res.status).sort()).toEqual([201, 409]);
    const statuses = await env.DB.prepare('SELECT status FROM agent_runs WHERE id IN (?1, ?2)').bind(...competingRuns).all<{ status: string }>();
    expect(statuses.results.map(row => row.status).sort()).toEqual(['adopted', 'succeeded']);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE project_id = ?1 AND type = 'material.adopted'").bind(pid).first<{ n: number }>())?.n).toBe(2);
    const dangling = await env.DB.prepare("SELECT e.id FROM events e LEFT JOIN material_versions v ON v.id = e.entity_id WHERE e.project_id = ?1 AND e.type = 'material.adopted' AND v.id IS NULL").bind(pid).all();
    expect(dangling.results).toHaveLength(0);

  });
});
