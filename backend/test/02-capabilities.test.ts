import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('GET /api/v1/capabilities', () => {
  it('返回限制、功能开关与比赛模板，不暴露密钥', async () => {
    const res = await SELF.fetch('https://example.com/api/v1/capabilities');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        apiVersion: string;
        environment: string;
        features: { aiEnabled: boolean; webFetch: boolean; emailMode: string };
        limits: Record<string, number>;
        competitionTemplate: { teamSizeLimit: number | null };
      };
    };
    expect(body.data.apiVersion).toBe('v1');
    expect(body.data.environment).toBe('local');
    expect(typeof body.data.features.aiEnabled).toBe('boolean');
    expect(['echo', 'resend']).toContain(body.data.features.emailMode);
    expect(body.data.limits.maxFileBytes).toBe(10 * 1024 * 1024);
    expect(body.data.limits.maxPdfPages).toBe(30);
    expect(body.data.limits.pageImageMaxBytes).toBe(2 * 1024 * 1024);
    expect(body.data.limits.listMaxPageSize).toBe(100);
    expect(body.data.limits.concurrentAiTasksPerProject).toBe(2);
    // 五人限制是模板建议值，不硬编码为所有限制
    expect([5, null]).toContain(body.data.competitionTemplate.teamSizeLimit);
    const raw = JSON.stringify(body);
    expect(raw.toLowerCase()).not.toContain('secret');
    expect(raw.toLowerCase()).not.toContain('token');
  });
});
