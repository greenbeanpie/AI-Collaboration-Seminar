import { expect } from 'vitest';
import { env } from './env';
import { loadAiConfig } from '../../src/ai/config';
import { seal } from '../../src/ai/secrets';

/** Test-only per-file D1 fixture. Does not read credentials or contact any provider. */
export async function configureGoFixture(): Promise<void> {
  const loaded = (await loadAiConfig(env.DB))!;
  const apiKeyEncrypted = await seal('fixture-go-job-key', env.AUTH_SECRET);
  for (const purpose of ['textEconomy','visionEconomy','review','unified','mediaUnderstanding'] as const) {
    const model=loaded.config[purpose];
    if(!model) continue;
    Object.assign(model, {
    provider: 'openai-compatible', providerPreset: 'opencode-go', model: 'glm-5.2',
    apiUrl: 'https://opencode.ai/zen/go/v1/chat/completions', apiKeyEncrypted,
    goUsageAcknowledged: true, supportsJson: false,
    goHeaders: { userAgent: 'AI-Collaboration-Seminar/1.0', sessionPrefix: 'integration' },
  });
  }
  await env.DB.prepare('UPDATE ai_config_versions SET config_json=?2,enabled=1 WHERE id=?1').bind(loaded.id, JSON.stringify(loaded.config)).run();
}
export function assertGoRequest(url: RequestInfo | URL, init?: RequestInit, outputLimitEnabled = true): void {
  expect(String(url)).toBe('https://opencode.ai/zen/go/v1/chat/completions');
  const headers = new Headers(init?.headers);
  expect(headers.get('authorization')).toBe('Bearer fixture-go-job-key');
  expect(headers.get('user-agent')).toBe('AI-Collaboration-Seminar/1.0');
  expect(headers.get('x-opencode-session')).toMatch(/^integration:[A-Za-z0-9_.:-]+$/);
  expect(headers.has('cf-aig-gateway-id')).toBe(false);
  const body = JSON.parse(String(init?.body));
  expect(body.model).toBe('glm-5.2'); expect(body.messages.length).toBeGreaterThan(0);
  if (outputLimitEnabled) expect(body.max_tokens).toBeGreaterThan(0);
  else expect(body).not.toHaveProperty('max_tokens');
  expect(body.response_format).toBeUndefined(); expect(body.reasoning_effort).toBeUndefined(); expect(body.temperature).toBeUndefined();
}
