export type AudioSettingsView = {
  audioFileTranscription: { provider: 'workers-ai'; model: '@cf/openai/whisper-large-v3-turbo' };
  realtimeAudioTranscription?: { provider: 'google-ai-studio'; model: 'gemini-3.5-transcribe-live'; gatewayId: string; languageCodes?: string[]; apiKey?: string; clearKey?: boolean; keyConfigured?: boolean; gatewayToken?: string; clearGatewayToken?: boolean; gatewayTokenConfigured?: boolean };
  processingStrategies: { audioFiles: 'whisper-first' | 'media-only' | 'mimo-only'; videoFiles?: 'gemini' | 'mimo'; rehearsal: 'text' | 'voice-with-text-fallback' };
  rehearsalSpeech: { provider: 'system-local'; lang: string; rate: number; volume: number };
};
export const blankAudioSettings = (): AudioSettingsView => ({
  audioFileTranscription: { provider: 'workers-ai', model: '@cf/openai/whisper-large-v3-turbo' },
  processingStrategies: { audioFiles: 'whisper-first', rehearsal: 'text' },
  rehearsalSpeech: { provider: 'system-local', lang: 'zh-CN', rate: 1, volume: 1 },
});

export function localSpeechSettings(value: unknown): AudioSettingsView['rehearsalSpeech'] {
  const candidate = value as Partial<AudioSettingsView['rehearsalSpeech']> | undefined;
  if (candidate?.provider !== 'system-local') return blankAudioSettings().rehearsalSpeech;
  return { provider: 'system-local', lang: candidate.lang ?? 'zh-CN', rate: candidate.rate ?? 1, volume: candidate.volume ?? 1 };
}
