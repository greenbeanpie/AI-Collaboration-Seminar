import { describe, expect, it } from 'vitest';
import { env } from './helpers/env';
import { aiConfigSchema, loadAiConfig } from '../src/ai/config';
import { isAllowedModelEndpoint } from '../src/ai/gateway';

describe('模型端点地址策略（A15）', () => {
  it('云端只允许公网 HTTPS；local 额外允许回环地址', () => {
    expect(isAllowedModelEndpoint('https://model.example.com/v1/chat/completions', 'production')).toBe(true);
    expect(isAllowedModelEndpoint('http://model.example.com/v1', 'production')).toBe(false);
    expect(isAllowedModelEndpoint('https://127.0.0.1:8080/v1', 'production')).toBe(false);
    expect(isAllowedModelEndpoint('https://localhost:8080/v1', 'staging')).toBe(false);
    expect(isAllowedModelEndpoint('https://169.254.169.254/v1', 'production')).toBe(false);
    expect(isAllowedModelEndpoint('https://user:pass@model.example.com/v1', 'production')).toBe(false);
    expect(isAllowedModelEndpoint('https://model.example.com/v1?key=1', 'production')).toBe(false);
    expect(isAllowedModelEndpoint('not-a-url', 'local')).toBe(false);

    // local 允许回环（零费用本地联调），但不放行内网地址
    expect(isAllowedModelEndpoint('http://127.0.0.1:8788/v1/chat/completions', 'local')).toBe(true);
    expect(isAllowedModelEndpoint('http://localhost:8788/v1', 'local')).toBe(true);
    expect(isAllowedModelEndpoint('http://10.0.0.5/v1', 'local')).toBe(false);
    expect(isAllowedModelEndpoint('http://127.0.0.1:8788/v1', 'production')).toBe(false);
  });
});

describe('任务冻结模型配置（A05）', () => {
  it('按 configVersionId 读取时不受后续新版本影响', async () => {
    const latest = await loadAiConfig(env.DB);
    expect(latest).not.toBeNull();
    const frozenId = latest!.id;
    const frozenModel = latest!.config.textEconomy.model;

    const changed = JSON.parse(JSON.stringify(latest!.config)) as Record<string, { model: string }>;
    for (const purpose of Object.keys(changed)) changed[purpose]!.model = `changed-${purpose}`;
    await env.DB.prepare(
      'INSERT INTO ai_config_versions (id, version, config_json, enabled, notes, created_by, created_at) VALUES (?1, ?2, ?3, 0, null, ?4, ?5)',
    )
      .bind('cfg-frozen-test', latest!.version + 1, JSON.stringify(aiConfigSchema.parse(changed)), 'test', new Date().toISOString())
      .run();

    try {
      const frozen = await loadAiConfig(env.DB, frozenId);
      expect(frozen?.id).toBe(frozenId);
      expect(frozen?.config.textEconomy.model).toBe(frozenModel);

      const newest = await loadAiConfig(env.DB);
      expect(newest?.config.textEconomy.model).toBe('changed-textEconomy');
    } finally {
      await env.DB.prepare('DELETE FROM ai_config_versions WHERE id = ?1').bind('cfg-frozen-test').run();
    }
  });
});
