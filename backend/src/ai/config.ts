import { z } from 'zod';
import type { D1Database } from '@cloudflare/workers-types';
import { AppError, aiUnavailable } from '../core/errors';
import { API_PROTOCOLS, PROVIDER_PRESETS, REASONING_EFFORTS } from '../../../shared/ai-providers';

import { FILE_TRANSCRIPTION_PROVIDER, FILE_TRANSCRIPTION_MODEL, REALTIME_TRANSCRIPTION_PROVIDER, REALTIME_TRANSCRIPTION_MODEL, normalizeProcessingStrategies, DEFAULT_AUDIO_FILE_TRANSCRIPTION, DEFAULT_REHEARSAL_SPEECH } from '../../../shared/audio-settings';

export const audioFileTranscriptionSchema = z.object({provider:z.literal(FILE_TRANSCRIPTION_PROVIDER),model:z.literal(FILE_TRANSCRIPTION_MODEL)}).strict();
export const realtimeAudioTranscriptionSchema = z.object({provider:z.literal(REALTIME_TRANSCRIPTION_PROVIDER),model:z.literal(REALTIME_TRANSCRIPTION_MODEL),gatewayId:z.string().max(64).refine(value=>value===''||/^[a-z0-9-]+$/.test(value),'Gateway ID must use lowercase letters, digits and hyphens'),apiKeyEncrypted:z.string().optional(),gatewayTokenEncrypted:z.string().optional(),languageCodes:z.array(z.string().max(64).regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)).max(8).optional()}).strict();
export const rehearsalSpeechSchema = z.object({provider:z.literal('system-local'),lang:z.string().max(64).regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/).default('zh-CN'),rate:z.number().min(0.5).max(2).default(1),volume:z.number().min(0).max(1).default(1)}).strict();
// Frozen cloud configuration remains readable for accounting and historical artifacts.
const historicalRehearsalSpeechSchema=z.object({model:z.enum(['gemini-3.8-flash-lite-tts','gemini-3.8-flash-tts']),voice:z.enum(['Kore','Aoede','Puck'])}).strict().transform(()=>({...DEFAULT_REHEARSAL_SPEECH}));
export const processingStrategiesSchema = z.object({audioFiles:z.enum(['whisper-first','media-only','mimo-only']),videoFiles:z.enum(['gemini','mimo']).optional(),rehearsal:z.enum(['text','voice-with-text-fallback'])}).strict();

export type AiPurpose = 'textEconomy' | 'visionEconomy' | 'review';

export const aiModelConfigSchema = z.object({
  provider: z.string().min(1),
  // Optional so old saved/frozen configurations retain their original adapter semantics.
  providerPreset: z.enum(PROVIDER_PRESETS).optional(),
  apiProtocol: z.enum(API_PROTOCOLS).optional(),
  model: z.string(),
  apiUrl: z.string().default(''),
  apiKeyEncrypted: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(600000),
  maxInputChars: z.number().int().min(1),
  supportsJson: z.boolean(),
  supportsVision: z.boolean(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
  goUsageAcknowledged: z.boolean().optional(),
  goHeaders: z.object({ userAgent: z.string().max(100).optional(), sessionPrefix: z.string().max(32).optional() }).strict().optional(),
});

export const aiConfigSchema = z.object({
  rehearsalSpeech:z.union([rehearsalSpeechSchema,historicalRehearsalSpeechSchema]).default(DEFAULT_REHEARSAL_SPEECH),
  audioFileTranscription: audioFileTranscriptionSchema.default(DEFAULT_AUDIO_FILE_TRANSCRIPTION),
  realtimeAudioTranscription: realtimeAudioTranscriptionSchema.optional(),
  processingStrategies: processingStrategiesSchema.optional(),
  audioProcessingStrategy: z.enum(['whisper-first', 'gemini-only']).optional(),
  searchEnabled: z.boolean().optional(),
  routingMode: z.enum(['advanced', 'unified']).optional(),
  unified: aiModelConfigSchema.optional(),
  textEconomy: aiModelConfigSchema,
  visionEconomy: aiModelConfigSchema,
  review: aiModelConfigSchema,
  // Native Google media processing is independent of text/image routing.
  mediaUnderstanding: aiModelConfigSchema.optional(),
  mimoMediaUnderstanding: aiModelConfigSchema.optional(),
}).refine(c => c.routingMode !== 'unified' || Boolean(c.unified), { message: 'Unified mode requires a model', path: ['unified'] });

export type AiModelConfig = z.infer<typeof aiModelConfigSchema>;
export type AiConfig = z.infer<typeof aiConfigSchema>;

export interface LoadedAiConfig {
  id: string;
  version: number;
  enabled: boolean;
  config: AiConfig;
}

/** 读取最新 AI 配置版本；调用方任务固定使用创建时的版本 */
export async function loadAiConfig(db: D1Database, configVersionId?: string, resolve = true): Promise<LoadedAiConfig | null> {
  const row = await db
    .prepare(configVersionId ? 'SELECT id, version, config_json, enabled FROM ai_config_versions WHERE id = ?1' : 'SELECT id, version, config_json, enabled FROM ai_config_versions ORDER BY version DESC LIMIT 1')
    .bind(...(configVersionId ? [configVersionId] : []))
    .first<{ id: string; version: number; config_json: string; enabled: number }>();
  if (!row) return null;
  return {
    id: row.id,
    version: row.version,
    enabled: row.enabled === 1,
    config: resolve ? resolveAiConfig(normalizeAudioConfig(aiConfigSchema.parse(JSON.parse(row.config_json)))) : normalizeAudioConfig(aiConfigSchema.parse(JSON.parse(row.config_json))),
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
  return resolveAiConfig(loaded.config)[purpose];
}

export function normalizeAudioConfig(config:AiConfig):AiConfig { return {...config,audioFileTranscription:config.audioFileTranscription??DEFAULT_AUDIO_FILE_TRANSCRIPTION,processingStrategies:normalizeProcessingStrategies(config.processingStrategies,config.audioProcessingStrategy)}; }

/** Resolve once at the frozen version boundary, including every pricing and legacy purpose reader. */
export function resolveAiConfig(config: AiConfig): AiConfig {
  if (config.routingMode !== 'unified') return config;
  if (!config.unified) throw new AppError('AI_UNAVAILABLE', '统一模型尚未配置', 503, false);
  return { ...config, textEconomy: config.unified, visionEconomy: config.unified, review: config.unified };
}
