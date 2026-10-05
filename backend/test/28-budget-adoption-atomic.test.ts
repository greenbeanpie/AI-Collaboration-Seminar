import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { loadAiConfig } from '../src/ai/config';
import { aiJsonCall } from '../src/services/agent';
import { estimateCostUsd, markAiCallStarted, reserveAiSlot, settleReservation, withReservedAiJob } from '../src/services/budget';
import { gatewayChat } from '../src/ai/gateway';
import { recordAiCall } from '../src/ai/calls';
import type { Env } from '../src/env';

await env.DB.prepare('UPDATE ai_config_versions SET enabled = 1').run();
afterEach(() => vi.unstubAllGlobals());

async function pricedProject() {
  const owner = await seedUser();
  const pid = await seedProject(owner.userId);
  const cfg = (await loadAiConfig(env.DB))!;
  for (const model of [cfg.config.textEconomy, cfg.config.visionEconomy, cfg.config.review]) model.pricePerMTokens = [1_000_000, 1_000_000];
  await env.DB.prepare('UPDATE ai_config_versions SET config_json = ?2 WHERE id = ?1').bind(cfg.id, JSON.stringify(cfg.config)).run();
  return { owner, pid, cfg };
}

async function reservation(jobId: string) {
  return env.DB.prepare('SELECT status, settled_cost, attempts_started FROM usage_reservations WHERE job_id = ?1 ORDER BY created_at DESC LIMIT 1').bind(jobId).first<{ status: string; settled_cost: number | null; attempts_started: number }>();
}

describe('A03 admission, call accounting and bounded inputs', () => {
  it('budget refusal happens before AI job/business creation and before any model request', async () => {
    const { owner, pid } = await pricedProject();
    await env.DB.prepare('UPDATE projects SET ai_budget_usd = 0 WHERE id = ?1').bind(pid).run();
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const res = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/agent-sessions`, {
      method: 'POST', headers: { cookie: authCookie(owner.token), 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ mode: 'do', instruction: '编写介绍' }),
    });
    expect(res.status).toBe(429);
    expect(fetch).not.toHaveBeenCalled();
    for (const table of ['jobs', 'agent_runs', 'usage_reservations']) {
      expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?1`).bind(pid).first<{ n: number }>())?.n).toBe(0);
    }
  });

  it('freezes config before creation and releases only failed uncreated jobs', async () => {
    const { pid, cfg } = await pricedProject();
    let id = '';
    await expect(withReservedAiJob(env, { projectId: pid, purpose: 'agent_run' }, async (jobId, configId) => {
      id = jobId;
      expect(configId).toBe(cfg.id);
      expect((await reservation(id))?.status).toBe('reserved');
      throw new Error('create failed');
    })).rejects.toThrow('create failed');
    expect((await reservation(id))?.status).toBe('released');
  });

  it('charges invalid JSON and repaired response, with task and reservation attribution', async () => {
    const { pid, cfg } = await pricedProject();
    const jobId = crypto.randomUUID();
    await reserveAiSlot(env, { projectId: pid, jobId, purpose: 'agent_run', configVersionId: cfg.id });
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: calls++ ? '{"ok":true}' : 'invalid json' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))));
    const result = await aiJsonCall(env, { projectId: pid, jobId, configVersionId: cfg.id, model: cfg.config.textEconomy.model, modelConfig: cfg.config.textEconomy, purpose: 'textEconomy', promptVersion: 'test', messages: [{ role: 'user', content: '你好' }], schema: z.object({ ok: z.literal(true) }) });
    expect(result.repaired).toBe(true);
    await settleReservation(env, jobId, 'released'); // business failure after response still costs money
    expect(await reservation(jobId)).toMatchObject({ status: 'settled', settled_cost: 30, attempts_started: 2 });
    const rows = await env.DB.prepare('SELECT status, cost_status, reservation_id FROM ai_calls WHERE job_id = ?1 ORDER BY created_at').bind(jobId).all<{ status: string; cost_status: string; reservation_id: string }>();
    expect(rows.results.map(row => row.status).sort()).toEqual(['invalid', 'repaired']);
    expect(rows.results.every(row => row.cost_status === 'known' && row.reservation_id)).toBe(true);
  });

  it('timeout or missing call ledger remains pending, never a free release', async () => {
    const { pid, cfg } = await pricedProject();
    const jobId = crypto.randomUUID();
    await reserveAiSlot(env, { projectId: pid, jobId, purpose: 'agent_run' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('timed out', 'TimeoutError'); }));
    await expect(aiJsonCall(env, { projectId: pid, jobId, configVersionId: cfg.id, model: cfg.config.textEconomy.model, modelConfig: cfg.config.textEconomy, purpose: 'textEconomy', promptVersion: 'test', messages: [{ role: 'user', content: '你好' }], schema: z.object({ ok: z.literal(true) }) })).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
    await settleReservation(env, jobId, 'released');
    expect(await reservation(jobId)).toMatchObject({ status: 'pending_reconcile', settled_cost: null, attempts_started: 1 });
    const lost = crypto.randomUUID();
    await reserveAiSlot(env, { projectId: pid, jobId: lost, purpose: 'agent_run' });
    await markAiCallStarted(env, lost); // simulate crash before recording response
    await settleReservation(env, lost, 'released');
    expect((await reservation(lost))?.status).toBe('pending_reconcile');
    // completed unknown-cost requests do not occupy running concurrency slots
    await expect(reserveAiSlot(env, { projectId: pid, jobId: crypto.randomUUID(), purpose: 'agent_run' })).resolves.toBeUndefined();
  });

  it('finite budget refuses images and unknown pricing before requests', async () => {
    const { pid, cfg } = await pricedProject();
    await env.DB.prepare('UPDATE projects SET ai_budget_usd = 100000000 WHERE id = ?1').bind(pid).run();
    await expect(reserveAiSlot(env, { projectId: pid, jobId: crypto.randomUUID(), purpose: 'ocr_pages' })).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    cfg.config.textEconomy.pricePerMTokens = null;
    await env.DB.prepare('UPDATE ai_config_versions SET config_json = ?2 WHERE id = ?1').bind(cfg.id, JSON.stringify(cfg.config)).run();
    await expect(reserveAiSlot(env, { projectId: pid, jobId: crypto.randomUUID(), purpose: 'agent_run' })).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it('stage reservations cannot charge earlier calls again, and same-job concurrent reservation is unique', async () => {
    const { pid, cfg } = await pricedProject(); const jobId = crypto.randomUUID();
    await Promise.all([reserveAiSlot(env, { projectId: pid, jobId, purpose: 'agent_run' }), reserveAiSlot(env, { projectId: pid, jobId, purpose: 'agent_run' })]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_reservations WHERE job_id = ?1 AND status = 'reserved'").bind(jobId).first<{ n: number }>())?.n).toBe(1);
    for (let stage = 0; stage < 2; stage++) {
      if (stage) await reserveAiSlot(env, { projectId: pid, jobId, purpose: 'requirement_extract' });
      await markAiCallStarted(env, jobId);
      await recordAiCall(env, { projectId: pid, jobId, purpose: 'textEconomy', configVersionId: cfg.id, promptVersion: 'test', model: cfg.config.textEconomy.model, input: {}, output: {}, promptTokens: 1, completionTokens: 2, latencyMs: 1, status: 'ok' });
      await settleReservation(env, jobId, 'settled');
    }
    const rows = await env.DB.prepare('SELECT settled_cost FROM usage_reservations WHERE job_id = ?1').bind(jobId).all<{ settled_cost: number }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results.map(row => row.settled_cost)).toEqual([3, 3]);
  });

  it('call ledger storage failure preserves attempt liability and sends no repair request', async () => {
    const { pid, cfg } = await pricedProject(); const jobId = crypto.randomUUID();
    await reserveAiSlot(env, { projectId: pid, jobId, purpose: 'agent_run' });
    const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })));
    vi.stubGlobal('fetch', fetch);
    const broken = { ...env, FILES: { put: async () => { throw new Error('R2 write failed'); } } } as unknown as Env;
    await expect(aiJsonCall(broken, { projectId: pid, jobId, configVersionId: cfg.id, model: cfg.config.textEconomy.model, modelConfig: cfg.config.textEconomy, purpose: 'textEconomy', promptVersion: 'test', messages: [{ role: 'user', content: '你好' }], schema: z.object({ ok: z.literal(true) }) })).rejects.toThrow('R2 write failed');
    expect(fetch).toHaveBeenCalledTimes(1);
    await settleReservation(env, jobId, 'released');
    expect(await reservation(jobId)).toMatchObject({ status: 'pending_reconcile', attempts_started: 1 });
  });

  it('invalid upstream token numbers are stored as unknown and never a zero bill', async () => {
    const { pid, cfg } = await pricedProject(); const jobId = crypto.randomUUID();
    await reserveAiSlot(env, { projectId: pid, jobId, purpose: 'agent_run' });
    for (const promptTokens of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await recordAiCall(env, { projectId: pid, jobId, purpose: 'textEconomy', configVersionId: cfg.id, promptVersion: 'test', model: cfg.config.textEconomy.model, input: {}, output: {}, promptTokens, completionTokens: 1, latencyMs: 1, status: 'invalid' });
    }
    const calls = await env.DB.prepare('SELECT cost_status, cost_usd, prompt_tokens FROM ai_calls WHERE job_id = ?1').bind(jobId).all();
    expect(calls.results).toHaveLength(4);
    expect(calls.results.every(row => row.cost_status === 'unknown' && row.cost_usd === null && row.prompt_tokens === null)).toBe(true);
    await settleReservation(env, jobId, 'released');
    expect((await reservation(jobId))?.status).toBe('pending_reconcile');
  });

  it('enforces message/output bounds before request and accounts for two byte-bounded text calls', async () => {
    const { cfg } = await pricedProject();
    const model = { ...cfg.config.textEconomy, maxInputChars: 2 };
    expect(estimateCostUsd({ ...cfg, config: { ...cfg.config, textEconomy: model } }, 'textEconomy')).toBe(2 * (2 * 6 + 4096 + 65535));
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
