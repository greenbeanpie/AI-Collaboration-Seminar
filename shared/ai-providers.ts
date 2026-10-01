/** Provider-specific transport policy. Keep UI and server policy identical. See docs/AI-PROVIDERS.md. */
export const PROVIDER_PRESETS = ['custom', 'openai', 'anthropic', 'gemini', 'deepseek', 'openrouter', 'opencode-zen', 'opencode-go'] as const;
export type ProviderPreset = typeof PROVIDER_PRESETS[number];
export const API_PROTOCOLS = ['chat-completions', 'responses', 'messages', 'gemini'] as const;
export type ApiProtocol = typeof API_PROTOCOLS[number];
const goResponses = ['grok-4.7', 'grok-4.6', 'gpt-6-luna', 'gpt-5.6-luna', 'muse-spark-1.3-contributor', 'muse-spark-1.2-contributor'];
const goMessages = ['minimax-m3', 'minimax-m2.7', 'qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus'];
const zenResponses = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-pro', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2', 'gpt-5.2-codex', 'gpt-5.1', 'gpt-5.1-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini', 'gpt-5', 'gpt-5-codex', 'gpt-5-nano', 'grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-build-0.1', 'muse-spark-1.3', 'muse-spark-1.2'];
const zenMessages = ['claude-fable-5-1', 'claude-fable-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'qwen3.8-flash', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus', 'qwen3.5-plus'];
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];
export const GO_USAGE_NOTICE = 'OpenCode Go 面向编码代理请求。本应用含项目写作、分工和验收等非编码任务；请求头适配不代表套餐适用或获得官方认证。请先确认你的套餐允许此用途；供应商可能拒绝请求。';
const goModels = ['glm-5.3-flash', 'glm-5.3', 'glm-5.2', 'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6', 'longcat-2.0', 'deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.5', 'mimo-v2.5-pro', 'hy4-preview', 'hy3'];
const zenModels = ['glm-5.3-flash', 'glm-5.3', 'glm-5.2', 'glm-5.1', 'glm-5', 'kimi-k2.5', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k3', 'deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'minimax-m3', 'minimax-m2.7', 'minimax-m2.5', 'qwen3.8-max'];
export const providerPresets: Record<ProviderPreset, { label: string; apiUrl: string; models: readonly string[]; supportsJson: boolean }> = {
  custom: { label: '自定义 OpenAI 兼容接口', apiUrl: '', models: [], supportsJson: true },
  openai: { label: 'OpenAI', apiUrl: 'https://api.openai.com/v1/chat/completions', models: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5.1', 'gpt-5.2', 'gpt-5.4', 'o3', 'o4-mini'], supportsJson: true },
  anthropic: { label: 'Anthropic Claude', apiUrl: 'https://api.anthropic.com/v1/messages', models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-sonnet-4-6'], supportsJson: false },
  gemini: { label: 'Google Gemini', apiUrl: '', models: ['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'], supportsJson: true },
  deepseek: { label: 'DeepSeek', apiUrl: 'https://api.deepseek.com/chat/completions', models: ['deepseek-flash', 'deepseek-v4-pro'], supportsJson: true },
  openrouter: { label: 'OpenRouter', apiUrl: 'https://openrouter.ai/api/v1/chat/completions', models: ['openai/gpt-4.1-mini', 'openai/gpt-5', 'openai/o3', 'openai/o4-mini'], supportsJson: false },
  'opencode-zen': { label: 'OpenCode Zen', apiUrl: 'https://opencode.ai/zen/v1/chat/completions', models: [...zenModels, ...zenResponses, ...zenMessages], supportsJson: false },
  'opencode-go': { label: 'OpenCode Go（需确认用途）', apiUrl: 'https://opencode.ai/zen/go/v1/chat/completions', models: [...goModels, ...goResponses, ...goMessages], supportsJson: false },
};
export interface ProviderOptions {
  provider: string;
  providerPreset?: ProviderPreset;
  apiUrl?: string;
  apiProtocol?: ApiProtocol;
  supportsJson?: boolean;
  model: string;
  reasoningEffort?: ReasoningEffort;
  temperature?: number;
  topP?: number;
  goUsageAcknowledged?: boolean;
  goHeaders?: { userAgent?: string; sessionPrefix?: string };
}
export interface ModelCapabilities {
  reasoning: readonly ReasoningEffort[];
  temperature: boolean;
  topP: boolean;
  minTopP: number;
  tokenField: 'max_tokens' | 'max_completion_tokens';
}
/** Explicit known families only; no option support is inferred from an arbitrary provider/model string. */
export function modelCapabilities(config: ProviderOptions): ModelCapabilities {
  const base: ModelCapabilities = { reasoning: [], temperature: true, topP: true, minTopP: 0, tokenField: 'max_tokens' };
  const preset = config.providerPreset ?? 'custom';
  if (preset === 'anthropic') return { ...base, reasoning: config.model === 'claude-sonnet-5-5' ? ['low', 'medium', 'high', 'xhigh', 'max'] : [], temperature: false, topP: false };
  if (preset === 'gemini') return { ...base, reasoning: config.model === 'gemini-3.8-flash' ? ['low', 'medium', 'high'] : [], temperature: false, topP: false };
  if (preset === 'custom') return { ...base, topP: config.provider !== 'workers-ai' };
  if (preset === 'opencode-go' || preset === 'opencode-zen') return { ...base, temperature: false, topP: false };
  if (preset === 'deepseek') {
    if (!providerPresets.deepseek.models.includes(config.model)) return { ...base, temperature: false, topP: false };
    const thinking = config.reasoningEffort !== 'none';
    return { ...base, reasoning: ['none', 'low', 'high', 'max'], temperature: !thinking, topP: thinking, minTopP: 0.95 };
  }
  if (preset === 'openrouter' && config.model !== 'openai/gpt-5') {
    const sampling = ['openai/gpt-4.1-mini', 'openai/gpt-4.1', 'openai/gpt-4o-mini'].includes(config.model);
    return { ...base, temperature: sampling, topP: sampling };
  }
  const model = preset === 'openrouter' ? config.model.replace(/^openai\//, '') : config.model;
  const isOpenAi = preset === 'openai' || (preset === 'openrouter' && config.model.startsWith('openai/'));
  const originalGpt5 = ['gpt-5', 'gpt-5-mini', 'gpt-5-nano'].includes(model);
  const laterGpt5 = ['gpt-5.1', 'gpt-5.2', 'gpt-5.4'].includes(model);
  const oModel = ['o3', 'o4-mini'].includes(model);
  if (isOpenAi && (originalGpt5 || laterGpt5 || oModel)) {
    const reasoning: readonly ReasoningEffort[] = originalGpt5 ? ['minimal', 'low', 'medium', 'high'] : oModel ? ['low', 'medium', 'high'] : model === 'gpt-5.1' ? ['none', 'low', 'medium', 'high'] : ['none', 'low', 'medium', 'high', 'xhigh'];
    return { ...base, reasoning, temperature: laterGpt5 && config.reasoningEffort === 'none', topP: laterGpt5 && config.reasoningEffort === 'none', tokenField: preset === 'openai' ? 'max_completion_tokens' : 'max_tokens' };
  }
  // Unknown standard providers can still run baseline Chat requests, but do not claim sampling support.
  const knownSampling = isOpenAi && ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'gpt-4o-mini'].includes(model);
  return { ...base, temperature: knownSampling, topP: knownSampling, tokenField: preset === 'openai' ? 'max_completion_tokens' : 'max_tokens' };
}
export function providerOptionErrors(config: ProviderOptions): string[] {
  const errors: string[] = [];
  const preset = config.providerPreset ?? 'custom';
  if (config.provider === 'workers-ai' && config.apiProtocol && config.apiProtocol !== 'chat-completions') errors.push('Workers AI 固定使用 Chat Completions 协议');
  if (config.provider === 'workers-ai' && preset !== 'custom') errors.push('Workers AI 不能同时使用第三方供应商预设');
  if (preset !== 'custom' && config.apiUrl !== presetEndpoint(preset, config.model, config.apiProtocol)) errors.push('预设必须使用对应模型的完整官方 API URL；代理地址请选择自定义');
  if ((preset === 'opencode-go' || preset === 'opencode-zen') && config.apiProtocol === 'gemini') errors.push('此 OpenCode 预设仅支持已接入的 Chat、Responses 和 Messages 协议');
  const knownModel = preset !== 'custom' && providerPresets[preset].models.includes(config.model);
  if (config.apiProtocol && config.apiProtocol !== protocolForConfig({ ...config, apiProtocol: undefined }) && preset !== 'custom' && preset !== 'openai' && (knownModel || ['anthropic', 'gemini', 'deepseek', 'openrouter'].includes(preset))) errors.push('协议与已核实的供应商/模型不匹配；代理接口请选择自定义');
  if (preset === 'openai' && config.apiProtocol && !['responses', 'chat-completions'].includes(config.apiProtocol)) errors.push('OpenAI 仅支持 Responses 或 Chat Completions 协议');
  if (protocolForConfig(config) === 'messages' && config.supportsJson) errors.push('Messages 协议请取消 JSON response_format；仍会使用 JSON 提示和输出校验');
  if ((preset === 'opencode-zen' || preset === 'opencode-go') && config.model && !providerPresets[preset].models.includes(config.model) && !config.apiProtocol) errors.push('该 OpenCode 模型尚未核实，请显式选择协议；思考参数保持默认');
  if (preset === 'opencode-go' && !config.goUsageAcknowledged) errors.push('请先确认 OpenCode Go 套餐适用于本应用用途');
  if (preset === 'opencode-go' && config.goHeaders?.userAgent !== undefined && !isSafeGoUserAgent(config.goHeaders.userAgent)) errors.push('Go User-Agent 需为真实应用名/版本，不能模拟 OpenCode、Codex 或 Claude 客户端');
  if (preset === 'opencode-go' && config.goHeaders?.sessionPrefix !== undefined && !/^[A-Za-z0-9_.-]{0,32}$/.test(config.goHeaders.sessionPrefix)) errors.push('Go 会话前缀只能含字母、数字、点、下划线或连字符，最多32位');
  const caps = modelCapabilities(config);
  if (config.reasoningEffort !== undefined && !caps.reasoning.includes(config.reasoningEffort)) errors.push('此供应商/模型不支持所选思考强度，请使用默认（不发送）');
  if (config.temperature !== undefined && !caps.temperature) errors.push(preset === 'gemini' ? 'Gemini 按官方建议使用默认采样，请将 temperature 留空' : '此供应商/模型/思考模式不支持 temperature，请留空');
  if (config.topP !== undefined && (!caps.topP || config.topP < caps.minTopP)) errors.push(preset === 'gemini' ? 'Gemini 按官方建议使用默认采样，请将 top_p 留空' : `此供应商/模型/思考模式不支持所选 top_p${caps.topP ? `（最小 ${caps.minTopP}）` : ''}，请留空或修正`);
  return errors;
}

/** Model-specific protocol differences are important: Go MiniMax/Qwen differ from Zen. */
export function protocolForConfig(config: ProviderOptions): ApiProtocol {
  if (config.apiProtocol) return config.apiProtocol;
  const preset = config.providerPreset ?? 'custom';
  if (preset === 'opencode-go') return goResponses.includes(config.model) ? 'responses' : goMessages.includes(config.model) ? 'messages' : 'chat-completions';
  if (preset === 'opencode-zen') return zenResponses.includes(config.model) ? 'responses' : zenMessages.includes(config.model) ? 'messages' : 'chat-completions';
  if (preset === 'anthropic') return 'messages';
  if (preset === 'gemini') return 'gemini';
  if (preset === 'openai') return config.apiProtocol ?? (['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'gpt-4o-mini'].includes(config.model) ? 'chat-completions' : 'responses');
  return config.apiProtocol ?? 'chat-completions';
}
export function presetEndpoint(preset: ProviderPreset, model: string, protocol?: ApiProtocol): string {
  const style = protocolForConfig({ provider: 'openai-compatible', providerPreset: preset, model, apiProtocol: protocol });
  const suffix = style === 'chat-completions' ? 'chat/completions' : style;
  if (preset === 'gemini') return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  if (preset === 'openai') return `https://api.openai.com/v1/${suffix}`;
  if (preset === 'opencode-go') return `https://opencode.ai/zen/go/v1/${suffix}`;
  if (preset === 'opencode-zen') return `https://opencode.ai/zen/v1/${suffix}`;
  return providerPresets[preset].apiUrl;
}

export function sameCredentialDestination(a: ProviderOptions, b: ProviderOptions): boolean {
  if (a.provider !== b.provider) return false;
  if (a.apiUrl === b.apiUrl) return true;
  // Model-specific paths/protocols on the same verified preset share that provider's key.
  return Boolean(a.providerPreset && a.providerPreset !== 'custom' && a.providerPreset === b.providerPreset && a.apiUrl === presetEndpoint(a.providerPreset, a.model, a.apiProtocol) && b.apiUrl === presetEndpoint(b.providerPreset!, b.model, b.apiProtocol));
}

export const GO_DEFAULT_USER_AGENT = 'AI-Collaboration-Seminar/1.0';
export function isSafeGoUserAgent(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9._-]{1,63}\/[A-Za-z0-9._-]{1,32}$/.test(value) && !/^(?:opencode|codex|claude(?:-code)?|curl|python|axios|node-fetch)(?:[./_-]|$)/i.test(value);
}
