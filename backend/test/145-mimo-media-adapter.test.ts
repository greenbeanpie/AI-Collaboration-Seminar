import { describe, expect, it, vi } from 'vitest';
import type { AiModelConfig } from '../src/ai/config';
import { MIMO_MEDIA_ENDPOINT, MIMO_MEDIA_MODEL, MimoMediaClient, mimoMediaCost, validateMimoMediaMime, validateMimoMediaModel } from '../src/ai/mimo-media';

const model: AiModelConfig = { provider: 'xiaomi-mimo', model: MIMO_MEDIA_MODEL, apiUrl: MIMO_MEDIA_ENDPOINT, timeoutMs: 10000, maxInputChars: 10000, enabledOutputLimit: true, maxOutputTokens: 4096, supportsJson: true, supportsVision: true, pricePerMTokens: [2, 5] };
const summary = { title: '音频摘要', summary: '讨论实验计划', keyPoints: ['实验'], conclusions: [], actionItems: [], timestamps: [{ seconds: 2, description: '实验' }], caveats: [], complete: true, durationSeconds: 30 };
function response(output: unknown = summary, usage: unknown = { prompt_tokens: 100, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 20, audio_tokens: 60, video_tokens: 0 } }, finish = 'stop') {
  return Response.json({ choices: [{ finish_reason: finish, message: { content: JSON.stringify(output), reasoning_content: 'untrusted reasoning is ignored' } }], usage });
}
const mediaUrl = 'https://backend.example/media/file?token=private';
function client(output: unknown = summary, usage?: unknown, finish?: string) {
  const request = vi.fn<typeof fetch>().mockResolvedValue(response(output, usage, finish));
  return { client: new MimoMediaClient(model, 'private-key', request), request };
}

describe('official MiMo media adapter (mock provider only)', () => {
  it('pins provider, model and official endpoint and accepts supported MIME aliases', () => {
    expect(() => validateMimoMediaModel(model)).not.toThrow();
    for (const change of [{ provider: 'openai-compatible' }, { model: 'mimo-v2.5' }, { apiUrl: 'https://proxy.example/v1' }]) expect(() => validateMimoMediaModel({ ...model, ...change })).toThrow();
    for (const mime of ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/x-m4a', 'audio/flac', 'audio/ogg', 'video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/x-ms-wmv']) expect(() => validateMimoMediaMime(mime)).not.toThrow();
    expect(() => validateMimoMediaMime('video/webm')).toThrow(/Whisper／Gemini/);
  });
  it('sends URL audio with official authentication, JSON mode and disabled thinking', async () => {
    const f = client();
    const result = await f.client.summarize(mediaUrl, 'audio/wav');
    const [url, init] = f.request.mock.calls[0]!;
    expect(url).toBe(MIMO_MEDIA_ENDPOINT + '/chat/completions');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('api-key')).toBe('private-key');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: MIMO_MEDIA_MODEL, response_format: { type: 'json_object' }, thinking: { type: 'disabled' }, max_completion_tokens: 4096, stream: false });
    expect(body.messages[1].content[0]).toEqual({ type: 'input_audio', input_audio: { data: mediaUrl } });
    expect(result).toMatchObject({ summary, promptTokens: 100, completionTokens: 40, cachedTokens: 20, audioTokens: 60, videoTokens: 0 });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('constructs official video sampling fields and includes an unavoidable coverage caveat', async () => {
    const f = client();
    const result = await f.client.summarize(mediaUrl, 'video/mp4');
    const body = JSON.parse(String(f.request.mock.calls[0]![1]?.body));
    expect(body.messages[1].content[0]).toEqual({ type: 'video_url', video_url: { url: mediaUrl }, fps: 2, media_resolution: 'default' });
    expect(result.summary.caveats.join('')).toContain('每秒 2 帧');
  });
  it('probes model metadata without a generation call', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ id: MIMO_MEDIA_MODEL }] }));
    expect(await new MimoMediaClient(model, 'private-key', request).probe()).toBe(true);
    expect(request.mock.calls[0]![0]).toBe(MIMO_MEDIA_ENDPOINT + '/models');
    expect(request.mock.calls[0]![1]?.method).toBe('GET');
  });
  it.each([
    { ...summary, durationSeconds: undefined }, { ...summary, durationSeconds: 14401 },
    { ...summary, durationSeconds: 0 }, { ...summary, timestamps: [{ seconds: 31, description: 'past end' }] },
    { ...summary, timestamps: [{ seconds: -1, description: 'negative' }] }, { ...summary, summary: 'x'.repeat(24001) },
  ])('rejects invalid duration, timestamps or oversized output', async output => {
    await expect(client(output).client.summarize(mediaUrl, 'audio/wav')).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
  });
  it('preserves validated partial content and explains incompleteness', async () => {
    const result = await client({ ...summary, complete: false }).client.summarize(mediaUrl, 'audio/wav');
    expect(result.summary.complete).toBe(false);
    expect(result.summary.summary).toBe(summary.summary);
    expect(result.summary.caveats.length).toBeGreaterThan(0);
  });
  it('does not parse reasoning content as output or accept a truncated response', async () => {
    await expect(client(summary, undefined, 'length').client.summarize(mediaUrl, 'audio/wav')).rejects.toThrow(/截断/);
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ choices: [{ finish_reason: 'stop', message: { content: null, reasoning_content: JSON.stringify(summary) } }] }));
    await expect(new MimoMediaClient(model, 'key', request).summarize(mediaUrl, 'audio/wav')).rejects.toThrow(/格式/);
  });
  it('never retries unknown network failures and redacts keys and signed URLs', async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error(mediaUrl + ' private-key'));
    await expect(new MimoMediaClient(model, 'private-key', request).summarize(mediaUrl, 'audio/wav')).rejects.toThrow(/受理状态未知/);
    expect(request).toHaveBeenCalledTimes(1);
    try { await new MimoMediaClient(model, 'private-key', request).summarize(mediaUrl, 'audio/wav'); } catch (error) { expect(String(error)).not.toMatch(/private-key|token=private|backend.example/); }
  });
  it.each([302, 400, 429, 500])('does not replay HTTP %s or expose provider error bodies', async status => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('private-key ' + mediaUrl, { status }));
    await expect(new MimoMediaClient(model, 'private-key', request).summarize(mediaUrl, 'audio/wav')).rejects.toThrow('HTTP ' + status);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid signed URL input before sending', async () => {
    const f = client();
    for (const url of ['http://backend.example/file', 'https://user:pass@backend.example/file', 'https://backend.example/file#secret', 'not a URL']) await expect(f.client.summarize(url, 'audio/wav')).rejects.toThrow(/HTTPS/);
    expect(f.request).not.toHaveBeenCalled();
  });
  it('bounds declared and streamed response bytes', async () => {
    const requests = [
      vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } })),
      vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(2 * 1024 * 1024 + 1))),
    ];
    for (const request of requests) await expect(new MimoMediaClient(model, 'key', request).summarize(mediaUrl, 'audio/wav')).rejects.toThrow(/大小限制/);
  });
  it('treats missing, fractional and negative usage as unknown', async () => {
    const result = await client(summary, { prompt_tokens: 1.5, completion_tokens: -1, prompt_tokens_details: { cached_tokens: '0' } }).client.summarize(mediaUrl, 'audio/wav');
    expect(result).toMatchObject({ promptTokens: null, completionTokens: null, cachedTokens: null, audioTokens: null, videoTokens: null });
    expect(mimoMediaCost(model, result)).toBeNull();
  });
  it('uses exact USD counts, requires cache pricing only for cache hits and never estimates missing usage', async () => {
    const result = await client().client.summarize(mediaUrl, 'audio/wav');
    expect(mimoMediaCost({ ...model, cachedInputPricePerMTokens: 1 }, result)).toBeCloseTo(0.00038);
    expect(mimoMediaCost(model, result)).toBeNull();
    expect(mimoMediaCost(model, { ...result, cachedTokens: 0 })).toBeCloseTo(0.0004);
    for (const usage of [{ ...result, cachedTokens: 101 }, { ...result, cachedTokens: null }, { ...result, completionTokens: null }, { ...result, promptTokens: 1.5 }]) expect(mimoMediaCost(model, usage)).toBeNull();
    expect(mimoMediaCost({ ...model, pricePerMTokens: null }, result)).toBeNull();
    expect(mimoMediaCost({ ...model, cachedInputPricePerMTokens: Number.NaN }, result)).toBeNull();
  });
});
