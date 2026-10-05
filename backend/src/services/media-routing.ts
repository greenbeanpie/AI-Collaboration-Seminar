import type { LoadedAiConfig } from '../ai/config';
import type { Env } from '../env';
import { normalizeProcessingStrategies } from '../../../shared/audio-settings';
import { validateMimoMediaMime } from '../ai/mimo-media';

export function selectedMediaProvider(config:LoadedAiConfig,mime:string):'gemini'|'mimo' {
  const strategies=normalizeProcessingStrategies(config.config.processingStrategies,config.config.audioProcessingStrategy);
  return (mime.startsWith('audio/')?strategies.audioFiles==='mimo-only':strategies.videoFiles==='mimo')?'mimo':'gemini';
}

export function mediaRouteError(env:Env,config:LoadedAiConfig,mime:string):string|null {
  if(!config.enabled)return 'AI 尚未启用；原文件已保留';
  if(selectedMediaProvider(config,mime)==='mimo'){
    try{validateMimoMediaMime(mime);}catch{return 'MiMo 暂不支持此文件格式，请切换旧路径处理；原文件已保留';}
    if(!config.config.mimoMediaUnderstanding?.apiKeyEncrypted)return '请先配置小米官方 MiMo 音视频模型及密钥；原文件已保留';
    if(!env.MEDIA_FETCH_BASE_URL)return 'MiMo 临时文件读取地址尚未配置；原文件已保留';
    return null;
  }
  const strategies=normalizeProcessingStrategies(config.config.processingStrategies,config.config.audioProcessingStrategy);
  if(mime.startsWith('audio/')&&strategies.audioFiles==='whisper-first'&&env.AI)return null;
  return config.config.mediaUnderstanding?.apiKeyEncrypted?null:'音视频 Gemini 模型尚未配置；原文件已保留';
}
