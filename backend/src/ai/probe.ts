import type { Env } from '../env';
import { AppError } from '../core/errors';
import { gatewayChat, type ChatMessage, type GatewayCallOutput } from './gateway';
import { configForPurpose, loadAiConfig, type AiModelConfig, type AiPurpose, type LoadedAiConfig } from './config';
import { recordAiCall } from './calls';

export type ProbeCheckName = 'chinese_text' | 'json_output' | 'vision_accept' | 'usage_fields';

export interface ProbeCheck {
  name: ProbeCheckName;
  passed: boolean;
  detail: string;
}

export interface ProbeReport {
  purpose: AiPurpose;
  model: string;
  configVersion: number;
  checks: ProbeCheck[];
  /** 检查均通过时记为诊断通过；探测结果不作为启用门槛。 */
  passed: boolean;
}

/** 1x1 红色 PNG（固定 fixture，仅验证图片链路可通；中文 OCR 质量由真实样本人工复核） */
const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const PROMPT_VERSION = 'probe-v1';

const hasCjk = (s: string): boolean => /[\u4e00-\u9fff]/.test(s);

function extractJson(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('响应中未找到 JSON 对象');
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}

/**
 * 可选能力诊断：
 * 1. chinese_text  中文短文生成
 * 2. json_output   JSON 输出（supportsJson 时走 response_format，否则靠提示词 + 解析）
 * 3. vision_accept 图片输入链路（仅 visionEconomy 必须通过；其余用途跳过记为通过）
 * 4. usage_fields  用量字段完整性
 *
 * 探测允许在 enabled=0 时运行，不修改配置版本或启用状态。
 * 探测调用同样计入 ai_calls 与 token 用量。
 */
export async function probeModel(env: Env, purpose: AiPurpose = 'textEconomy', frozen?: LoadedAiConfig, diagnosticRequestId?: string): Promise<ProbeReport> {
  const loaded = frozen ?? await loadAiConfig(env.DB);
  if (!loaded) throw new AppError('AI_UNAVAILABLE', 'AI 配置缺失，请先通过 /admin/ai-config 写入种子配置', 503, false);
  const cfg = configForPurpose(loaded, purpose);
  if (purpose === 'visionEconomy' && !cfg.supportsVision) return finish(purpose, cfg.model, loaded.version, [{ name: 'vision_accept', passed: false, detail: '当前模型不支持图像；未发送图像，也不会回落到其他端点' }]);
  const endpoint = {
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
    gatewayId: env.AI_GATEWAY_ID,
    authSecret: env.AUTH_SECRET,
    envName: env.ENV_NAME,
    diagnostics: env,
  };

  const sessionId = `probe-${crypto.randomUUID()}`;
  async function callAndRecord(messages: ChatMessage[], jsonMode: boolean): Promise<GatewayCallOutput> {
    try {
      const out = await gatewayChat(endpoint, { config: cfg, messages, jsonMode, sessionId, diagnosticRequestId });
      await recordAiCall(env, {
        diagnosticRequestId,
        purpose,
        configVersionId: loaded!.id,
        promptVersion: PROMPT_VERSION,
        model: cfg.model,
        input: { messages },
        output: out.content,
        promptTokens: out.promptTokens,
        completionTokens: out.completionTokens,
        latencyMs: out.latencyMs,
        status: 'ok',
      });
      return out;
    } catch (err) {
      await recordAiCall(env, {
        diagnosticRequestId,
        purpose,
        configVersionId: loaded!.id,
        promptVersion: PROMPT_VERSION,
        model: cfg.model,
        input: { messages },
        output: { error: err instanceof Error ? err.message : String(err) },
        promptTokens: null,
        completionTokens: null,
        latencyMs: 0,
        status: 'failed',
      });
      throw err;
    }
  }

  const checks: ProbeCheck[] = [];
  let usageOk = false;

  // 1. 中文短文
  const chineseMessages: ChatMessage[] = [
    { role: 'user', content: '请用一句中文回复，内容必须以「你好」开头。' },
  ];
  try {
    const out = await callAndRecord(chineseMessages, false);
    const ok = out.content.length > 0 && hasCjk(out.content);
    checks.push({
      name: 'chinese_text',
      passed: ok,
      detail: ok ? out.content.slice(0, 80) : `无中文输出: ${out.content.slice(0, 80)}`,
    });
    usageOk = out.promptTokens !== null && out.completionTokens !== null;
  } catch (err) {
    checks.push({ name: 'chinese_text', passed: false, detail: err instanceof Error ? err.message : String(err) });
    checks.push({ name: 'usage_fields', passed: false, detail: '前置调用失败，无法校验用量' });
    return finish(purpose, cfg.model, loaded.version, checks);
  }

  // 2. JSON 输出
  try {
    const out = await callAndRecord(
      [{ role: 'user', content: '请只输出一个 JSON 对象：{"ok": true, "n": 1}，不要其他文字。' }],
      true,
    );
    const parsed = extractJson(out.content);
    const ok = parsed.ok === true;
    checks.push({ name: 'json_output', passed: ok, detail: ok ? 'JSON 解析通过' : out.content.slice(0, 120) });
  } catch (err) {
    checks.push({ name: 'json_output', passed: false, detail: err instanceof Error ? err.message : String(err) });
  }

  // 3. 图片链路（vision 用途必须通过；非视觉配置跳过记为通过）
  if (purpose === 'visionEconomy') {
    try {
      const out = await callAndRecord(
        [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: TINY_PNG_DATA_URL } },
              { type: 'text', text: '请描述这张图片，只输出 JSON：{"seen": true}' },
            ],
          },
        ],
        true,
      );
      const parsed = extractJson(out.content);
      checks.push({ name: 'vision_accept', passed: parsed.seen === true, detail: out.content.slice(0, 120) });
    } catch (err) {
      checks.push({ name: 'vision_accept', passed: false, detail: err instanceof Error ? err.message : String(err) });
    }
  } else {
    checks.push({ name: 'vision_accept', passed: true, detail: '非视觉用途，跳过' });
  }

  // 4. 用量字段
  checks.push({
    name: 'usage_fields',
    passed: usageOk,
    detail: usageOk ? 'prompt/completion tokens 均存在' : '响应中缺少 prompt/completion 用量字段',
  });

  return finish(purpose, cfg.model, loaded.version, checks);
}

function finish(purpose: AiPurpose, model: string, configVersion: number, checks: ProbeCheck[]): ProbeReport {
  const passed = checks.every((c) => c.passed);
  return { purpose, model, configVersion, checks, passed };
}

export type { AiModelConfig };
