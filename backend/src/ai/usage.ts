import type { ApiProtocol } from '../../../shared/ai-providers';

export interface AiTokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
  cacheMissTokens: number | null;
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const tokenCount = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
function sum(base: unknown, ...optional: unknown[]): number | null {
  const first = tokenCount(base);
  const counts = optional.map(value => value === undefined ? 0 : tokenCount(value));
  return first === null || counts.includes(null) ? null : tokenCount(first + counts.reduce<number>((total, value) => total + (value ?? 0), 0));
}

/** Provider input totals include cache reads; Messages reports them separately. */
export function normalizeTokenUsage(protocol: ApiProtocol, response: unknown): AiTokenUsage {
  const data = object(response), usage = object(data.usage);
  let promptTokens: number | null, completionTokens: number | null, cachedTokens: number | null, cacheMissTokens: number | null;
  if (protocol === 'messages') {
    promptTokens = sum(usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens);
    completionTokens = tokenCount(usage.output_tokens);
    cachedTokens = tokenCount(usage.cache_read_input_tokens);
    cacheMissTokens = cachedTokens === null ? null : sum(usage.input_tokens, usage.cache_creation_input_tokens);
  } else if (protocol === 'gemini') {
    const metadata = object(data.usageMetadata);
    promptTokens = tokenCount(metadata.promptTokenCount);
    completionTokens = sum(metadata.candidatesTokenCount, metadata.thoughtsTokenCount);
    cachedTokens = tokenCount(metadata.cachedContentTokenCount);
    cacheMissTokens = null;
  } else if (protocol === 'responses') {
    promptTokens = tokenCount(usage.input_tokens);
    completionTokens = tokenCount(usage.output_tokens);
    cachedTokens = tokenCount(object(usage.input_tokens_details).cached_tokens);
    cacheMissTokens = null;
  } else {
    promptTokens = tokenCount(usage.prompt_tokens);
    completionTokens = tokenCount(usage.completion_tokens);
    // DeepSeek's explicit field takes precedence; the detail is an alternate field.
    cachedTokens = tokenCount(usage.prompt_cache_hit_tokens === undefined ? object(usage.prompt_tokens_details).cached_tokens : usage.prompt_cache_hit_tokens);
    cacheMissTokens = tokenCount(usage.prompt_cache_miss_tokens);
  }
  if (promptTokens !== null && cachedTokens !== null && cachedTokens > promptTokens) cachedTokens = null;
  if (promptTokens !== null && cacheMissTokens !== null && cacheMissTokens > promptTokens) cacheMissTokens = null;
  if (promptTokens !== null && cachedTokens !== null) {
    if (cacheMissTokens !== null && cachedTokens + cacheMissTokens !== promptTokens) cacheMissTokens = null;
    else if (cacheMissTokens === null && (protocol === 'responses' || protocol === 'gemini')) cacheMissTokens = promptTokens - cachedTokens;
    else if (protocol === 'chat-completions' && usage.prompt_cache_miss_tokens === undefined) cacheMissTokens = promptTokens - cachedTokens;
  }
  return { promptTokens, completionTokens, cachedTokens, cacheMissTokens };
}
