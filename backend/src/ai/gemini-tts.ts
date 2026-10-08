import { AppError } from '../core/errors';

export const TTS_MODELS = ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts'] as const;
export const TTS_VOICES = ['Kore', 'Aoede', 'Puck'] as const;
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
