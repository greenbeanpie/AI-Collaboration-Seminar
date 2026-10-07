import { describe, it, expect, vi } from 'vitest';
import { env } from './helpers/env';
import { configureGoFixture } from './helpers/provider-config';
import { loadAiConfig } from '../src/ai/config';
import { gatewayChat, type GatewayCallInput } from '../src/ai/gateway';
import { readExecution, ensureExecution, pauseExecution, resumeExecution, cancelExecution, saveExecutionPolicy } from '../src/services/ai-execution-control';
import { InvestigationContinuation } from '../src/services/project-investigation';

async function fixture() {
  await configureGoFixture();
  const jobId = crypto.randomUUID();
  const target = { kind: 'job' as const, id: jobId };
  const endpoint = { accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN, gatewayId: env.AI_GATEWAY_ID, authSecret: env.AUTH_SECRET, envName: env.ENV_NAME, executionEnv: env };
  const input: GatewayCallInput = { jobId, config: (await loadAiConfig(env.DB))!.config.textEconomy, messages: [{ role: 'user', content: 'fixture' }] };
  return { target, endpoint, input };
}
const ok = () => Response.json({ choices: [{ message: { content: '{"answer":"ready"}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });

describe('gateway execution dispatch boundary', () => {
  it('counts provider rejections and successful retry as separate calls', async () => {
    const f = await fixture();
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ error: { message: 'temporary' } }, { status: 429 })).mockImplementationOnce(ok);
    await gatewayChat(f.endpoint, f.input, fetcher, async () => {});
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await readExecution(env, f.target)).toMatchObject({ totalCalls: 2, windowCalls: 2, state: 'running' });
  });
  it('does not send the next request once the window is exhausted', async () => {
    const f = await fixture();
    const current = await env.DB.prepare("SELECT version FROM ai_execution_policy WHERE id='global'").first<{version:number}>();
    await saveExecutionPolicy(env, current!.version, 1, null);
    const fetcher = vi.fn(ok);
    await gatewayChat(f.endpoint, f.input, fetcher);
    await expect(gatewayChat(f.endpoint, f.input, fetcher)).rejects.toMatchObject({ details: { executionPause: true } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await readExecution(env, f.target)).toMatchObject({ totalCalls: 1, state: 'paused', pauseReason: 'round_limit' });
  });
  it('refunds a request rejected by the final permission guard before dispatch', async () => {
    const f = await fixture();
    const fetcher = vi.fn(ok);
    await expect(gatewayChat(f.endpoint, { ...f.input, beforeFetch: async () => { throw new Error('permission changed'); } }, fetcher)).rejects.toThrow('permission changed');
    expect(fetcher).not.toHaveBeenCalled();
    expect(await readExecution(env, f.target)).toMatchObject({ totalCalls: 0, windowCalls: 0 });
  });
  it('pauses unknown network results without automatic paid replay', async () => {
    const f = await fixture();
    const fetcher = vi.fn(async () => { throw new TypeError('network unavailable'); });
    await expect(gatewayChat(f.endpoint, f.input, fetcher, async () => {})).rejects.toMatchObject({ details: { executionPause: true } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await readExecution(env, f.target)).toMatchObject({ totalCalls: 1, state: 'paused', pauseReason: 'request_uncertain' });
  });
  it('yields after one new request in the current Workflow invocation', async () => {
    const f = await fixture();
    const local = { ...env, AI_EXECUTION_CONTEXT: { modelCalls: 0 } };
    const endpoint = { ...f.endpoint, executionEnv: local };
    const fetcher = vi.fn(ok);
    await gatewayChat(endpoint, f.input, fetcher);
    await expect(gatewayChat(endpoint, f.input, fetcher)).rejects.toBeInstanceOf(InvestigationContinuation);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await readExecution(env, f.target)).toMatchObject({ totalCalls: 1 });
  });
  it('rejects late output after a cancellation', async () => {
    const f = await fixture();
    const fetcher = vi.fn(async () => { await cancelExecution(env, f.target, 1); return ok(); });
    await expect(gatewayChat(f.endpoint, f.input, fetcher)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await readExecution(env, f.target)).toMatchObject({ state: 'cancelled', totalCalls: 1 });
  });
  it('permits one user-requested final call without reopening automatic processing', async () => {
    const f = await fixture();
    await ensureExecution(env, f.target);
    await pauseExecution(env, f.target, 'round_limit');
    await resumeExecution(env, f.target, 1, 'output');
    const fetcher = vi.fn(ok);
    await gatewayChat(f.endpoint, f.input, fetcher);
    await expect(gatewayChat(f.endpoint, f.input, fetcher)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await readExecution(env, f.target)).toMatchObject({ totalCalls: 1 });
  });
  it('excludes model probes without a background execution target', async () => {
    const f = await fixture();
    await gatewayChat(f.endpoint, { config: f.input.config, messages: f.input.messages }, vi.fn(ok));
    expect(await readExecution(env, f.target)).toBeNull();
  });
});
