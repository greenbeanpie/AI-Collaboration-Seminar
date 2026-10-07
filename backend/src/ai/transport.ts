import type { AiModelConfig } from './config';
import type { ChatMessage } from './gateway';
import { AppError } from '../core/errors';
import { normalizeTokenUsage, type AiTokenUsage } from './usage';
import { FIXED_MAX_OUTPUT_TOKENS, modelCapabilities, protocolForConfig, usesDeepSeekThinkingToggle, type ApiProtocol } from '../../../shared/ai-providers';

const invalid = (message: string, details?: Record<string, unknown>) => new AppError('AI_OUTPUT_INVALID', message, 502, false, details);
const inputError = (message: string) => new AppError('AI_UNAVAILABLE', message, 503, false);
function dataImage(url: string) {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (!match) throw inputError('此协议的图片输入需要 PNG/JPEG/WebP/GIF base64 data URL');
  return { mimeType: match[1]!, data: match[2]! };
}
function textContent(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (message.content.some(part => part.type !== 'text')) throw inputError('系统消息不能包含图片');
  return message.content.map(part => part.type === 'text' ? part.text : '').join('\n');
}

/** No arbitrary headers/body passthrough. Authentication is constructed after validation. */
export function buildProviderRequest(config: AiModelConfig, messages: ChatMessage[], token: string, jsonMode: boolean): { protocol: ApiProtocol; headers: Record<string, string>; body: Record<string, unknown> } {
  const protocol = protocolForConfig(config);
  const caps = modelCapabilities(config);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  let body: Record<string, unknown>;
  if (protocol === 'messages') {
    if (token) headers['x-api-key'] = token;
    headers['anthropic-version'] = '2023-06-01';
    body = {
      model: config.model, max_tokens: FIXED_MAX_OUTPUT_TOKENS,
      messages: messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.map(part => {
        if (part.type === 'text') return part;
        const image = dataImage(part.image_url.url);
        return { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } };
      }) })),
    };
    const system = messages.filter(m => m.role === 'system').map(textContent).join('\n\n');
    if (system) body.system = system;
    if (config.reasoningEffort !== undefined) body.output_config = { effort: config.reasoningEffort };
  } else if (protocol === 'gemini') {
    if (token) headers['x-goog-api-key'] = token;
    const generationConfig: Record<string, unknown> = { maxOutputTokens: FIXED_MAX_OUTPUT_TOKENS };
    if (jsonMode && config.supportsJson) generationConfig.responseMimeType = 'application/json';
    if (config.reasoningEffort !== undefined) generationConfig.thinkingConfig = { thinkingLevel: config.reasoningEffort };
    if (config.temperature !== undefined) generationConfig.temperature = config.temperature;
    if (config.topP !== undefined) generationConfig.topP = config.topP;
    body = {
      contents: messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: typeof m.content === 'string' ? [{ text: m.content }] : m.content.map(part => part.type === 'text' ? { text: part.text } : { inlineData: dataImage(part.image_url.url) }) })),
      generationConfig,
    };
    const system = messages.filter(m => m.role === 'system').map(textContent).join('\n\n');
    if (system) body.systemInstruction = { parts: [{ text: system }] };
  } else {
    if (token) headers.authorization = `Bearer ${token}`;
    if (protocol === 'responses') {
      body = { model: config.model, max_output_tokens: FIXED_MAX_OUTPUT_TOKENS, store: false, input: messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.map(part => part.type === 'text' ? { type: 'input_text', text: part.text } : { type: 'input_image', image_url: part.image_url.url }) })) };
      if (jsonMode && config.supportsJson) body.text = { format: { type: 'json_object' } };
      if (config.reasoningEffort !== undefined) body.reasoning = { effort: config.reasoningEffort };
    } else {
      body = { model: config.model, messages, [caps.tokenField]: FIXED_MAX_OUTPUT_TOKENS };
      if (jsonMode && config.supportsJson) body.response_format = { type: 'json_object' };
      if (config.reasoningEffort !== undefined) {
        // DeepSeek Chat toggles thinking separately; "none" is not a Chat effort.
        if (usesDeepSeekThinkingToggle(config) && config.reasoningEffort === 'none') body.thinking = { type: 'disabled' };
        else if (config.providerPreset === 'openrouter') body.reasoning = { effort: config.reasoningEffort };
        else body.reasoning_effort = config.reasoningEffort;
      }
      if (config.providerPreset === 'openrouter') body.provider = { require_parameters: true };
    }
  }
  if (protocol !== 'gemini') {
    if (config.temperature !== undefined) body.temperature = config.temperature;
    if (config.topP !== undefined) body.top_p = config.topP;
  }
  return { protocol, headers, body };
}

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const items = (value: unknown): Obj[] => Array.isArray(value) ? value.map(obj) : [];
/** Extract only answer text. Thought/reasoning blocks are never returned as the user answer. */
export function normalizeProviderResponse(protocol: ApiProtocol, value: unknown): { content: string } & AiTokenUsage {
  const data = obj(value);
  if (data.error) throw invalid('模型返回错误响应');
  let content: string;
  if (protocol === 'responses') {
    if (data.status !== 'completed' || items(data.output).some(item => !['message', 'reasoning'].includes(String(item.type)) || (item.type === 'message' && (item.role !== 'assistant' || (item.status !== undefined && item.status !== 'completed') || items(item.content).some(part => part.type !== 'output_text'))))) throw invalid('模型 Responses 输出未完成、拒绝或需要工具执行');
    content = items(data.output).filter(item => item.type === 'message').flatMap(item => items(item.content)).filter(part => part.type === 'output_text' && typeof part.text === 'string').map(part => part.text).join('');
  } else if (protocol === 'messages') {
    if (!['end_turn', 'stop_sequence'].includes(String(data.stop_reason)) || items(data.content).some(part => ['tool_use', 'server_tool_use', 'refusal'].includes(String(part.type)))) throw invalid('模型 Messages 输出被截断、拒绝或需要工具执行');
    content = items(data.content).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('');
  } else if (protocol === 'gemini') {
    const candidate = items(data.candidates)[0];
    if (obj(data.promptFeedback).blockReason || candidate?.finishReason !== 'STOP' || items(obj(candidate?.content).parts).some(part => part.functionCall)) throw invalid('模型 Gemini 输出未完成、被安全过滤或需要工具执行');
    content = items(obj(candidate?.content).parts).filter(part => part.thought !== true && typeof part.text === 'string').map(part => part.text).join('');
  } else {
    const choice = items(data.choices)[0];
    if (choice?.finish_reason === 'length') throw invalid(`模型输出被截断：达到系统固定的 ${FIXED_MAX_OUTPUT_TOKENS} token 上限；请缩短任务内容或降低思考强度后重试`, { cause: 'output_limit', finishReason: 'length' });
    if ((choice?.finish_reason !== undefined && choice.finish_reason !== 'stop') || obj(choice?.message).refusal || obj(choice?.message).tool_calls || obj(choice?.message).function_call) throw invalid('模型 Chat 输出被截断、过滤或需要工具执行');
    const text = obj(choice?.message).content;
    content = typeof text === 'string' ? text : '';
  }
  if (!content.trim()) throw invalid('模型响应缺少文本内容');
  return { content, ...normalizeTokenUsage(protocol, data) };
}
