import type { AiModelConfig } from './config';
import type { ApiProtocol } from '../../../shared/ai-providers';
import { protocolForConfig, providerOptionErrors } from '../../../shared/ai-providers';
import { AppError } from '../core/errors';
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface ToolInvocation {
  id: string;
  name: string;
  args: unknown;
}
export interface WebCitation {
  url: string;
  title: string;
}
export interface ToolExchange {
  assistant: unknown;
  results: Array<{
    call: ToolInvocation;
    output: unknown;
  }>;
}
export interface ToolMode {
  definitions: ToolDefinition[];
  exchanges?: ToolExchange[];
  nativeSearch?: boolean;
  final?: boolean;
}
export interface ToolOutput {
  content: string;
  toolCalls: ToolInvocation[];
  assistant: unknown;
  citations: WebCitation[];
  searchUsage?: {
    provider: string;
    performed: boolean;
    queries: number | null;
  };
}
const object = (v: unknown): Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const array = (v: unknown): Record<string, any>[] => Array.isArray(v) ? v.map(object) : [];
const invalid = () => new AppError('AI_OUTPUT_INVALID', '模型工具响应未完成、拒绝或格式无效', 502, false);
export function nativeSearchCapability(config: AiModelConfig): {
  supported: boolean;
  reason: string;
} {
  const p = config.providerPreset, protocol = protocolForConfig(config);
  if (providerOptionErrors(config).length) {
    return {
      supported: false, reason: '供应商配置尚未通过校验'
    };
  }
  if (p === 'openai' && protocol === 'responses' && !['gpt-5-nano', 'gpt-4.1-nano'].includes(config.model)) {
    return {
      supported: true, reason: 'OpenAI Responses 内置 web_search，支持情况由模型服务核验'
    };
  }
  if (p === 'deepseek-anthropic' && protocol === 'messages') {
    return {
      supported: true, reason: 'DeepSeek Anthropic 兼容官方声明支持原生 Web Search；基础工具参数仅通过模拟响应验证，真实兼容性与来源格式待供应商核验，可能产生额外摘要 token 用量'
    };
  }
  if (p === 'anthropic' && protocol === 'messages' && /^claude-/.test(config.model)) {
    return {
      supported: true, reason: 'Anthropic basic web_search，最多一次搜索'
    };
  }
  if (p === 'gemini' && protocol === 'gemini' && /^(gemini-3[.\w-]*|gemini-2\.5-(flash|pro))$/.test(config.model)) {
    return {
      supported: true, reason: 'Google Search grounding，查询数由供应商决定'
    };
  }
  if (p === 'openrouter' && protocol === 'chat-completions' && /^(openai|anthropic|google)\//.test(config.model)) {
    return {
      supported: true, reason: 'OpenRouter 强制 native 引擎；不支持时返回错误，不回落第三方'
    };
  }
  return {
    supported: false, reason: '当前供应商/模型/协议没有已核实的原生互联网搜索；请由管理员选择支持的现有配置'
  };
}
export function applyToolMode(config: AiModelConfig, protocol: ApiProtocol, body: Record<string, unknown>, mode: ToolMode): void {
  const defs = mode.final ? [] : mode.definitions;
  const exchanges = mode.exchanges ?? [];
  if (protocol === 'responses') {
    body.tools = defs.map(d => ({
      type: 'function', ...d, strict: false
    }));
    if (mode.nativeSearch) {
      body.tools = [{
          type: 'web_search', search_context_size: 'low'
        }];
      body.include = ['web_search_call.action.sources'];
    }
    body.max_tool_calls = mode.nativeSearch ? 1 : 64;
    body.parallel_tool_calls = false;
    body.input = [...(body.input as unknown[]), ...exchanges.flatMap(e => [...(Array.isArray(e.assistant) ? e.assistant : []), ...e.results.map(r => ({
          type: 'function_call_output', call_id: r.call.id, output: JSON.stringify(r.output)
        }))])];
  }
  else if (protocol === 'messages') {
    body.tools = defs.map(d => ({
      name: d.name, description: d.description, input_schema: d.parameters
    }));
    if (mode.nativeSearch) {
      body.tools = [{
          type: 'web_search_20250305', name: 'web_search', max_uses: 1
        }];
    }
    body.messages = [...(body.messages as unknown[]), ...exchanges.flatMap(e => [{
          role: 'assistant', content: e.assistant
        }, {
          role: 'user', content: e.results.map(r => ({
            type: 'tool_result', tool_use_id: r.call.id, content: JSON.stringify(r.output)
          }))
        }])];
  }
  else if (protocol === 'gemini') {
    body.tools = defs.length ? [{
        functionDeclarations: defs
      }] : [];
    if (mode.nativeSearch) {
      body.tools = [{
          google_search: {}
        }];
      delete object(body.generationConfig).responseMimeType;
    }
    body.contents = [...(body.contents as unknown[]), ...exchanges.flatMap(e => [e.assistant, {
          role: 'user', parts: e.results.map(r => ({
            functionResponse: {
              name: r.call.name, id: r.call.id, response: r.output
            }
          }))
        }])];
  }
  else {
    body.tools = defs.map(d => ({
      type: 'function', function: d
    }));
    body.messages = [...(body.messages as unknown[]), ...exchanges.flatMap(e => [e.assistant, ...e.results.map(r => ({
          role: 'tool', tool_call_id: r.call.id, content: JSON.stringify(r.output)
        }))])];
    if (mode.nativeSearch) {
      delete body.tools;
      body.plugins = [{
          id: 'web', engine: 'native', max_results: 3
        }];
      body.web_search_options = {
        search_context_size: 'low'
      };
    }
  }
  if (!defs.length && !mode.nativeSearch) {
    delete body.tools;
  }
  if (mode.final) {
    delete body.tools;
  }
}
function args(v: unknown): unknown {
  if (typeof v !== 'string') {
    return v;
  }
  try {
    return JSON.parse(v);
  }
  catch {
    throw invalid();
  }
}
export function safeWebCitation(url: unknown, title: unknown): WebCitation | null {
  if (typeof url !== 'string' || url.length > 2000) {
    return null;
  }
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password || /^(localhost|.*\.local|.*\.internal|[0-9.]+)$/.test(u.hostname) || u.hostname.includes(':')) {
      return null;
    }
    return {
      url: u.href, title: typeof title === 'string' ? title.slice(0, 300) : u.hostname
    };
  }
  catch {
    return null;
  }
}
/** Safe response-shape diagnostics: never retain provider text, arguments, keys or reasoning. */
export function toolResponseShape(value:unknown) {
  const data=object(value),choice=object(array(data.choices)[0]),message=object(choice.message);
  const reason=typeof choice.finish_reason==='string'&&['stop','tool_calls','length','function_call','content_filter'].includes(choice.finish_reason)?choice.finish_reason:'unknown';
  return {choices:array(data.choices).length,finishReason:reason,toolCalls:array(message.tool_calls).length,answerChars:typeof message.content==='string'?message.content.length:0,providerError:Boolean(data.error),outputItems:array(data.output).length};
}
export function normalizeToolResponse(protocol: ApiProtocol, value: unknown, nativeSearch = false): ToolOutput & {
  promptTokens: number | null;
  completionTokens: number | null;
} {
  const d = object(value), usage = object(d.usage), calls: ToolInvocation[] = [], citations: WebCitation[] = [];
  let content = '', assistant: unknown, queries: number | null = 0, performed = false;
  let prompt: unknown, completion: unknown;
  const cite = (url: unknown, title: unknown) => {
    const c = safeWebCitation(url, title);
    if (c && !citations.some(x => x.url === c.url)) {
      citations.push(c);
    }
  };
  const call = (id: unknown, name: unknown, a: unknown) => {
    if (typeof id !== 'string' || !id || id.length > 200 || typeof name !== 'string' || name.length > 80) {
      throw invalid();
    }
    calls.push({
      id, name, args: args(a)
    });
  };
  if (d.error) {
    throw invalid();
  }
  if (protocol === 'responses') {
    if (d.status !== 'completed') {
      throw invalid();
    }
    assistant = d.output;
    for (const o of array(d.output)) {
      if (o.type === 'function_call') {
        call(o.call_id, o.name, o.arguments);
      }
      else if (o.type === 'web_search_call' && nativeSearch) {
        if (o.status !== 'completed') {
          throw invalid();
        }
        performed = true;
        queries = (queries ?? 0) + 1;
        for (const s of array(object(o.action).sources))
          cite(s.url, s.title);
      }
      else if (o.type === 'message') {
        if (o.role !== 'assistant') {
          throw invalid();
        }
        for (const part of array(o.content)) {
          if (part.type !== 'output_text') {
            throw invalid();
          }
          content += typeof part.text === 'string' ? part.text : '';
          for (const c of array(part.annotations))
            if (c.type === 'url_citation') {
              cite(c.url, c.title);
            }
        }
      }
      else if (o.type !== 'reasoning') {
        throw invalid();
      }
    }
    prompt = usage.input_tokens;
    completion = usage.output_tokens;
  }
  else if (protocol === 'messages') {
    if (!['end_turn', 'stop_sequence', 'tool_use'].includes(d.stop_reason)) {
      throw invalid();
    }
    assistant = d.content;
    for (const part of array(d.content)) {
      if (part.type === 'tool_use') {
        call(part.id, part.name, part.input);
      }
      else if (part.type === 'text') {
        content += typeof part.text === 'string' ? part.text : '';
        for (const c of array(part.citations))
          cite(c.url, c.title);
      }
      else if (nativeSearch && part.type === 'server_tool_use' && part.name === 'web_search') {
        performed = true;
      }
      else if (nativeSearch && part.type === 'web_search_tool_result') {
        if (!Array.isArray(part.content)) {
          throw new AppError('AI_UNAVAILABLE', '供应商原生搜索失败或额度不可用', 503, false);
        }
        for (const c of array(part.content))
          cite(c.url, c.title);
      }
      else if (!['thinking', 'redacted_thinking'].includes(part.type)) {
        throw invalid();
      }
    }
    prompt = typeof usage.input_tokens === 'number' ? usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) : null;
    completion = usage.output_tokens;
    queries = object(usage.server_tool_use).web_search_requests ?? (performed ? null : 0);
  }
  else if (protocol === 'gemini') {
    const c = array(d.candidates)[0];
    if (!c || c.finishReason !== 'STOP' || object(d.promptFeedback).blockReason) {
      throw invalid();
    }
    assistant = c.content;
    for (const part of array(object(c.content).parts)) {
      if (part.functionCall) {
        call(object(part.functionCall).id ?? `gemini-${calls.length}`, object(part.functionCall).name, object(part.functionCall).args);
      }
      else if (part.thought !== true && typeof part.text === 'string') {
        content += part.text;
      }
    }
    const g = object(c.groundingMetadata);
    for (const chunk of array(g.groundingChunks))
      cite(object(chunk.web).uri, object(chunk.web).title);
    performed = array(g.groundingChunks).length > 0 || (Array.isArray(g.webSearchQueries) && g.webSearchQueries.length > 0);
    queries = Array.isArray(g.webSearchQueries) ? g.webSearchQueries.length : performed ? null : 0;
    prompt = object(d.usageMetadata).promptTokenCount;
    completion = typeof object(d.usageMetadata).candidatesTokenCount === 'number' ? object(d.usageMetadata).candidatesTokenCount + (object(d.usageMetadata).thoughtsTokenCount ?? 0) : null;
  }
  else {
    const choice = array(d.choices)[0], m = object(choice?.message);
    if (!choice || m.refusal || !['stop', 'tool_calls', undefined].includes(choice.finish_reason)) {
      throw invalid();
    }
    assistant = {
      role: 'assistant', content: m.content ?? null, ...(m.tool_calls ? {
        tool_calls: m.tool_calls
      } : {})
    };
    content = typeof m.content === 'string' ? m.content : '';
    for (const t of array(m.tool_calls)) {
      if (t.type !== 'function') {
        throw invalid();
      }
      call(t.id, object(t.function).name, object(t.function).arguments);
    }
    for (const a of array(m.annotations)) {
      const c = object(a.url_citation);
      cite(c.url, c.title);
    }
    performed = nativeSearch && citations.length > 0;
    queries = performed ? null : 0;
    prompt = usage.prompt_tokens;
    completion = usage.completion_tokens;
  }
  if (calls.length > 64 || new Set(calls.map(c => c.id)).size !== calls.length || (!content.trim() && !calls.length)) {
    throw invalid();
  }
  const tokens = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
  return {
    content, toolCalls: calls, assistant, citations: citations.slice(0, 20), promptTokens: tokens(prompt), completionTokens: tokens(completion), ...(nativeSearch ? {
      searchUsage: {
        provider: protocol, performed, queries
      }
    } : {})
  };
}
