import { expect } from 'vitest';
import { env } from './env';
import { loadAiConfig } from '../../src/ai/config';
import { FIXED_MAX_OUTPUT_TOKENS } from '../../../shared/ai-providers';

/** Test-only per-file D1 fixture. Does not read credentials or contact any provider. */
export async function configureGoFixture(): Promise<void> {
  const loaded = (await loadAiConfig(env.DB))!;
  for (const purpose of ['textEconomy','visionEconomy','review','unified','mediaUnderstanding'] as const) {
    const model=loaded.config[purpose];
    if(!model) continue;
    Object.assign(model, {
    provider: 'openai-compatible', providerPreset: 'opencode-go', model: 'glm-5.2',
    apiUrl: 'https://opencode.ai/zen/go/v1/chat/completions', apiKeyEncrypted:undefined,
    goUsageAcknowledged: true, supportsJson: false,
    goHeaders: { userAgent: 'AI-Collaboration-Seminar/1.0', sessionPrefix: 'integration' },
  });
  }
  await env.DB.prepare('UPDATE ai_config_versions SET config_json=?2,enabled=1 WHERE id=?1').bind(loaded.id, JSON.stringify(loaded.config)).run();
}
export function assertGoRequest(url: RequestInfo | URL, init?: RequestInit): void {
  expect(String(url)).toBe('https://gateway.ai.cloudflare.com/v1/test-account-id/test-gateway-id/custom-opencode-go/zen/go/v1/chat/completions');
  const headers = new Headers(init?.headers);
  expect(headers.get('cf-aig-authorization')).toBe('Bearer test-cf-token');
  expect(headers.has('authorization')).toBe(false);
  expect(headers.get('user-agent')).toBe('AI-Collaboration-Seminar/1.0');
  expect(headers.get('x-opencode-session')).toMatch(/^integration:[A-Za-z0-9_.:-]+$/);
  expect(headers.has('cf-aig-gateway-id')).toBe(false);
  const body = JSON.parse(String(init?.body));
  expect(body.model).toBe('custom-opencode-go/glm-5.2'); expect(body.messages.length).toBeGreaterThan(0);
  expect(body.max_tokens).toBe(FIXED_MAX_OUTPUT_TOKENS);
  expect(body.response_format).toBeUndefined(); expect(body.reasoning_effort).toBeUndefined(); expect(body.temperature).toBeUndefined();
}
