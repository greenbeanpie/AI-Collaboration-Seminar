/** Audio roles remain independent of general text/vision model routing. */
export const FILE_TRANSCRIPTION_PROVIDER = 'workers-ai' as const;
export const FILE_TRANSCRIPTION_MODEL = '@cf/openai/whisper-large-v3-turbo' as const;
export const REALTIME_TRANSCRIPTION_PROVIDER = 'google-ai-studio' as const;
export const REALTIME_TRANSCRIPTION_MODEL = 'gemini-3.5-transcribe-live' as const;
export const REHEARSAL_TTS_MODELS = ['gemini-3.8-flash-lite-tts','gemini-3.8-flash-tts'] as const;
export const REHEARSAL_TTS_VOICES = ['Kore','Aoede','Puck'] as const;
export interface RehearsalSpeechConfig { model:typeof REHEARSAL_TTS_MODELS[number];voice:typeof REHEARSAL_TTS_VOICES[number] }
export const DEFAULT_REHEARSAL_SPEECH:RehearsalSpeechConfig={model:'gemini-3.8-flash-lite-tts',voice:'Kore'};
export interface AudioFileTranscription { provider:typeof FILE_TRANSCRIPTION_PROVIDER;model:typeof FILE_TRANSCRIPTION_MODEL }
export interface ProcessingStrategies { audioFiles:'whisper-first'|'media-only';rehearsal:'text'|'voice-with-text-fallback' }
export interface RealtimeAudioTranscription { provider:typeof REALTIME_TRANSCRIPTION_PROVIDER;model:typeof REALTIME_TRANSCRIPTION_MODEL;gatewayId:string;languageCodes?:string[];apiKeyEncrypted?:string;gatewayTokenEncrypted?:string }
export const DEFAULT_AUDIO_FILE_TRANSCRIPTION:AudioFileTranscription={provider:FILE_TRANSCRIPTION_PROVIDER,model:FILE_TRANSCRIPTION_MODEL};
export function normalizeProcessingStrategies(value?:ProcessingStrategies,legacy?:'whisper-first'|'gemini-only'):ProcessingStrategies {
 return value??{audioFiles:legacy==='gemini-only'?'media-only':'whisper-first',rehearsal:'text'};
}
/** Only Cloudflare's authenticated Google provider route; no endpoint override. */
export function realtimeTranscriptionGatewayUrl(accountId:string,gatewayId:string):string {
 if(!/^[a-zA-Z0-9_-]+$/.test(accountId)||!gatewayId||gatewayId.length>64||!/^[a-z0-9-]+$/.test(gatewayId))throw new Error('Invalid Cloudflare gateway binding');
 return `wss://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/google`;
}
