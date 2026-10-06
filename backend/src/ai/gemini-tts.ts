import { AppError, aiUnavailable, validationFailed } from '../core/errors';

export const TTS_MODELS = ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts'] as const;
export const TTS_VOICES = ['Kore', 'Aoede', 'Puck'] as const;
const JSON_LIMIT = 20 * 1024 * 1024;
export const TTS_AUDIO_LIMIT = 10 * 1024 * 1024;
export interface GeminiSpeechRequest {
  accountId: string; gatewayId: string; gatewayToken: string;
  model: typeof TTS_MODELS[number]; voice: typeof TTS_VOICES[number]; text: string;
}
export interface GeminiSpeechOutput { bytes: Uint8Array; mime: 'audio/wav'; durationSeconds: number; usage: unknown; }
const invalid = (message: string) => new AppError('AI_OUTPUT_INVALID', message, 502, false);

/** Strict WAV inspection; never reinterpret compressed or unknown output as PCM. */
export function inspectSpeechWav(bytes: Uint8Array): number {
  if (bytes.length < 44 || bytes.length > TTS_AUDIO_LIMIT) throw invalid('TTS 音频为空或超过 10 MiB');
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || view.getUint32(4, true) + 8 !== bytes.length) throw invalid('TTS 音频不是完整 WAV');
  let offset = 12, rate = 0, alignment = 0, dataBytes = 0, formatSeen = false, dataSeen = false;
  while (offset + 8 <= bytes.length) {
    const size = view.getUint32(offset + 4, true), next = offset + 8 + size;
    if (next > bytes.length) throw invalid('TTS WAV 分块不完整');
    if (tag(offset) === 'fmt ') {
      if (formatSeen || size < 16) throw invalid('TTS WAV 格式无效');
      const format = view.getUint16(offset + 8, true), channels = view.getUint16(offset + 10, true);
      const sampleRate = view.getUint32(offset + 12, true), blockAlign = view.getUint16(offset + 20, true), bits = view.getUint16(offset + 22, true);
      rate = view.getUint32(offset + 16, true);
      if (format !== 1 || channels < 1 || channels > 2 || sampleRate < 8000 || sampleRate > 96000 || ![8,16,24,32].includes(bits) || blockAlign !== channels * bits / 8 || rate !== sampleRate * blockAlign) throw invalid('TTS WAV 编码不受支持');
      formatSeen = true;
      alignment = blockAlign;
    } else if (tag(offset) === 'data') {
      if (dataSeen) throw invalid('TTS WAV 重复音频分块');
      dataBytes = size; dataSeen = true;
    }
    offset = next + (size % 2);
  }
  const duration = dataBytes / rate;
  if (offset !== bytes.length || !formatSeen || !dataSeen || !dataBytes || dataBytes % alignment !== 0 || !Number.isFinite(duration) || duration <= 0 || duration > 600) throw invalid('TTS WAV 缺少有效音频或超过十分钟');
  return duration;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > JSON_LIMIT) { await response.body?.cancel(); throw invalid('TTS 响应超过大小限制'); }
  if (!response.body) throw invalid('TTS 未返回内容');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.length; if (total > JSON_LIMIT) { await reader.cancel(); throw invalid('TTS 响应超过大小限制'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw invalid('TTS 返回了无效 JSON'); }
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** One attempt only. Durable job retries own the recovery policy. */
export async function geminiSpeech(input: GeminiSpeechRequest, request: typeof fetch = fetch): Promise<GeminiSpeechOutput> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.accountId) || !/^[a-z0-9-]{1,64}$/.test(input.gatewayId) || !TTS_MODELS.includes(input.model) || !TTS_VOICES.includes(input.voice)) throw validationFailed('TTS Gateway 或模型配置无效');
  if (!input.text.trim() || input.text.length > 8000) throw validationFailed('朗读正文必须为 1 至 8000 字符，不会截断');
  if (!input.gatewayToken || /[\x00-\x20\x7f]/.test(input.gatewayToken)) throw validationFailed('TTS Gateway 认证配置无效');
  const url = `https://gateway.ai.cloudflare.com/v1/${input.accountId}/${input.gatewayId}/google-ai-studio/v1beta/interactions`;
  let response: Response;
  try {
    response = await request(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(90_000),
      headers: { 'content-type': 'application/json', 'cf-aig-authorization': `Bearer ${input.gatewayToken}`, 'cf-aig-skip-cache': 'true', 'cf-aig-collect-log': 'false' },
      body: JSON.stringify({ model: input.model, input: [{ type: 'user_input', content: [{ type: 'text', text: input.text }] }], response_format: { type: 'audio', mime_type: 'audio/wav' }, generation_config: { speech_config: [{ voice: input.voice }] } }),
    });
  } catch { throw aiUnavailable('TTS Gateway 请求失败或超时；本次结果未知', { cause: 'network_error' }); }
  if (!response.ok) { await response.body?.cancel(); throw new AppError('AI_UNAVAILABLE', `TTS Gateway 请求失败（HTTP ${response.status}）`, 502, [429,500,502,503,504].includes(response.status), { status: response.status }); }
  const data = object(await boundedJson(response));
  if (data.status !== 'completed' || !Array.isArray(data.steps)) throw invalid('TTS 未完整生成音频');
  const audio = data.steps.flatMap(step => { const value = object(step); return value.type === 'model_output' && Array.isArray(value.content) ? value.content : []; }).filter(part => object(part).type === 'audio');
  if (audio.length !== 1) throw invalid('TTS 必须返回一个完整音频');
  const part = object(audio[0]);
  if (part.mime_type !== 'audio/wav' || typeof part.data !== 'string' || !part.data || part.data.length > Math.ceil(TTS_AUDIO_LIMIT / 3) * 4 || part.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(part.data)) throw invalid('TTS 音频格式或编码无效');
  let decoded: string; try { decoded = atob(part.data); } catch { throw invalid('TTS 音频编码无效'); }
  const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
  return { bytes, mime: 'audio/wav', durationSeconds: inspectSpeechWav(bytes), usage: data.usage ?? null };
}
