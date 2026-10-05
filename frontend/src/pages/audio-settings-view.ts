export type AudioSettingsView = {
  audioFileTranscription: { provider: 'workers-ai'; model: '@cf/openai/whisper-large-v3-turbo' };
  realtimeAudioTranscription?: { provider: 'google-ai-studio'; model: 'gemini-3.5-transcribe-live'; gatewayId: string; languageCodes?: string[]; apiKey?: string; clearKey?: boolean; keyConfigured?: boolean; gatewayToken?: string; clearGatewayToken?: boolean; gatewayTokenConfigured?: boolean };
  processingStrategies: { audioFiles: 'whisper-first' | 'media-only'; rehearsal: 'text' | 'voice-with-text-fallback' };
  rehearsalSpeech: { model: 'gemini-3.8-flash-lite-tts' | 'gemini-3.8-flash-tts'; voice: 'Kore' | 'Aoede' | 'Puck' };
};
export const blankAudioSettings = (): AudioSettingsView => ({
  audioFileTranscription: { provider: 'workers-ai', model: '@cf/openai/whisper-large-v3-turbo' },
  processingStrategies: { audioFiles: 'whisper-first', rehearsal: 'text' },
  rehearsalSpeech: { model: 'gemini-3.8-flash-lite-tts', voice: 'Kore' },
});
