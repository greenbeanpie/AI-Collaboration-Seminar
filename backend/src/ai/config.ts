import { z } from 'zod';
import type { D1Database } from '@cloudflare/workers-types';
import { AppError, aiUnavailable } from '../core/errors';

export type AiPurpose = 'textEconomy' | 'visionEconomy' | 'review';

export const aiModelConfigSchema = z.object({
  provider: z.string().min(1),
  model: z.string(),
  apiUrl: z.string().default(''),
  apiKeyEncrypted: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(600000),
  maxInputChars: z.number().int().min(1),
  maxOutputTokens: z.number().int().min(1).max(32768),
  supportsJson: z.boolean(),
  supportsVision: z.boolean(),
  temperature: z.number().min(0).max(2).optional(),
  /** 每百万 token 价格 [输入 USD, 输出 USD]；null 表示未配置 → 费用记未知，不填零 */
  pricePerMTokens: z.tuple([z.number().nonnegative(), z.number().nonnegative()]).nullable().default(null),
});

export const aiConfigSchema = z.object({
  textEconomy: aiModelConfigSchema,
  visionEconomy: aiModelConfigSchema,
  review: aiModelConfigSchema,
});

export type AiModelConfig = z.infer<typeof aiModelConfigSchema>;
export type AiConfig = z.infer<typeof aiConfigSchema>;

export interface LoadedAiConfig {
  id: string;
  version: number;
  enabled: boolean;
  config: AiConfig;
}

/** 读取最新 AI 配置版本；调用方任务固定使用创建时的版本 */
export async function loadAiConfig(db: D1Database, configVersionId?: string): Promise<LoadedAiConfig | null> {
  const row = await db
    .prepare(configVersionId ? 'SELECT id, version, config_json, enabled FROM ai_config_versions WHERE id = ?1' : 'SELECT id, version, config_json, enabled FROM ai_config_versions ORDER BY version DESC LIMIT 1')
    .bind(...(configVersionId ? [configVersionId] : []))
    .first<{ id: string; version: number; config_json: string; enabled: number }>();
  if (!row) return null;
  return {
    id: row.id,
    version: row.version,
    enabled: row.enabled === 1,
    config: aiConfigSchema.parse(JSON.parse(row.config_json)),
  };
}

/** 要求已启用的配置；未启用时按不可用处理（不自动切换更贵模型） */
export async function requireEnabledAiConfig(db: D1Database): Promise<LoadedAiConfig> {
  const loaded = await loadAiConfig(db);
  if (!loaded) throw aiUnavailable('AI 配置缺失');
  if (!loaded.enabled) {
    throw new AppError('AI_UNAVAILABLE', 'AI 功能未启用（模型未通过能力验证或未配置）', 503, false);
  }
  return loaded;
}

export function configForPurpose(loaded: LoadedAiConfig, purpose: AiPurpose): AiModelConfig {
  return loaded.config[purpose];
}
