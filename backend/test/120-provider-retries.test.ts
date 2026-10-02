import { afterEach, expect, it, vi } from 'vitest';
import { gatewayChat } from '../src/ai/gateway';
import { aiModelConfigSchema } from '../src/ai/config';
import { invalidState } from '../src/core/errors';
import { z } from 'zod';
import { env } from './helpers/env';
import { seedProject, seedUser } from './helpers/seed';
import { loadAiConfig } from '../src/ai/config';
import { aiJsonCall } from '../src/services/agent';

const endpoint = { accountId: 'fixture', apiToken: 'fixture', gatewayId: 'fixture' };
const config = aiModelConfigSchema.parse({ provider: 'workers-ai', model: 'fixture', timeoutMs: 180000, maxInputChars: 48000, maxOutputTokens: 1000, supportsJson: true, supportsVision: false });
const input = { config, messages: [{ role: 'user' as const, content: 'fixture' }] };
const success = () => Response.json({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 2, completion_tokens: 1 } });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('uses exactly 1s, 5s, 15s before three extra requests and stops after four rejections', async () => {
  const fetch = vi.fn(async () => new Response('', { status: 503 }));
  const wait = vi.fn(async (_ms: number) => {});
  await expect(gatewayChat(endpoint, input, fetch, wait)).rejects.toMatchObject({ details: { status: 503 } });
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(wait.mock.calls.map(call => call[0])).toEqual([1000, 5000, 15000]);
});

it.each([429, 500, 502, 503, 504])('recovers from HTTP %i and reruns guards and fresh messages', async status => {
  const fetch = vi.fn().mockImplementationOnce(async () => new Response('', { status })).mockImplementationOnce(async () => success());
  const guard = vi.fn(async () => {});
  let revision = 0;
  const prepareMessages = vi.fn(async () => [{ role: 'user' as const, content: `r${++revision}` }]);
  const wait = vi.fn(async (_ms: number) => {});
  expect((await gatewayChat(endpoint, { ...input, beforeFetch: guard, prepareMessages }, fetch, wait)).content).toBe('ok');
  expect(guard).toHaveBeenCalledTimes(2);
  expect(prepareMessages).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string).messages[0].content).toBe('r2');
  expect(wait.mock.calls.map(call => call[0])).toEqual([1000]);
});

it.each([400, 401, 403, 404, 501])('does not retry permanent HTTP %i', async status => {
  const fetch = vi.fn(async () => new Response('', { status }));
  const wait = vi.fn(async (_ms: number) => {});
  await expect(gatewayChat(endpoint, input, fetch, wait)).rejects.toMatchObject({ details: { status } });
  expect(fetch).toHaveBeenCalledOnce(); expect(wait).not.toHaveBeenCalled();
});

it('does not replay a network failure or malformed successful response', async () => {
  for (const fetch of [vi.fn(async () => { throw new TypeError('network'); }), vi.fn(async () => new Response('not json'))]) {
    const wait = vi.fn(async (_ms: number) => {});
    await expect(gatewayChat(endpoint, input, fetch, wait)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce(); expect(wait).not.toHaveBeenCalled();
  }
});

it('stops before dispatch when retry permissions or budget guard fails', async () => {
  const fetch = vi.fn(async () => new Response('', { status: 503 }));
  const guard = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(invalidState('fixture changed'));
  await expect(gatewayChat(endpoint, { ...input, beforeFetch: guard }, fetch, async () => {})).rejects.toMatchObject({ code: 'INVALID_STATE' });
  expect(fetch).toHaveBeenCalledOnce(); expect(guard).toHaveBeenCalledTimes(2);
});

it('does not dispatch after the one-minute recovery window expires', async () => {
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const fetch = vi.fn(async () => new Response('', { status: 503 }));
  await expect(gatewayChat(endpoint, input, fetch, async () => { now += 60001; })).rejects.toMatchObject({ retryable: false });
  expect(fetch).toHaveBeenCalledOnce();
});

it('rechecks recovery deadline after slow preflight before sending another request', async () => {
  let now=1000, checks=0;
  vi.spyOn(Date,'now').mockImplementation(()=>now);
  const fetch=vi.fn(async()=>new Response('',{status:503}));
  await expect(gatewayChat(endpoint,{...input,beforeFetch:async()=>{if(++checks===2)now+=60001;}},fetch,async()=>{})).rejects.toMatchObject({retryable:false});
  expect(fetch).toHaveBeenCalledOnce();expect(checks).toBe(2);
});

it.each(['network', '503'])('does not restart transport recovery as a JSON repair for %s', async failure => {
  const user = await seedUser();
  const projectId = await seedProject(user.userId);
  const loaded = await loadAiConfig(env.DB);
  const fetch = vi.fn(async () => {
    if (failure === 'network') throw new TypeError('fixture network failure');
    return new Response('', { status: 503 });
  });
  vi.stubGlobal('fetch', fetch);
  await expect(aiJsonCall(env, { projectId, purpose: 'textEconomy', configVersionId: loaded!.id,
    model: config.model, modelConfig: config, promptVersion: 'retry-fixture', messages: input.messages,
    schema: z.object({ ok: z.boolean() }),
  })).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
  expect(fetch).toHaveBeenCalledTimes(failure === 'network' ? 1 : 4);
}, 30_000);
