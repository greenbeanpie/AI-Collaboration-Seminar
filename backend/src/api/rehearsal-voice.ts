import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { requireUser, requireProjectMember, loadSessionUser, parseCookies, SESSION_COOKIE } from '../core/auth';
import { requireAllowedOrigin } from '../core/origin';
import { permissionDenied, unauthenticated, validationFailed } from '../core/errors';
import { createRehearsalVoiceSession, readRehearsalVoice, closeRehearsalVoiceSession, openRehearsalVoiceStream } from '../services/rehearsal-voice';
import { enqueueRehearsalSpeech, readRehearsalSpeech, readRehearsalSpeechAudio } from '../services/rehearsal-speech';

const params=z.object({projectId:z.string().uuid(),rehearsalId:z.string().uuid()});
const sessionParams=params.extend({sessionId:z.string().uuid()});
const speechParams=params.extend({speechId:z.string().uuid()});
const prefix='/api/v1/projects/{projectId}/rehearsals/{rehearsalId}';
const voiceRoute=createRoute({method:'get',path:prefix+'/voice',tags:['rehearsals'],summary:'语音答辩准备状态（配置与权限，不代表已付费连通验证）',request:{params},responses:{200:{description:'语音准备状态',content:{'application/json':{schema:apiEnvelope(z.object({configured:z.boolean(),ready:z.boolean(),mode:z.enum(['text','voice-with-text-fallback']),reason:z.string().nullable(),speech:z.object({model:z.string(),voice:z.string()})}),'RehearsalVoiceReadiness')}}}}});
const createVoiceRoute=createRoute({method:'post',path:prefix+'/voice-sessions',tags:['rehearsals'],summary:'创建逐题转录会话（原答案仍由用户提交）',request:{params,body:{required:true,content:{'application/json':{schema:z.object({sequence:z.number().int().min(1),retryOfSessionId:z.string().uuid().optional()}).strict()}}}},responses:{201:{description:'语音会话',content:{'application/json':{schema:apiEnvelope(z.object({sessionId:z.string().uuid(),webSocketPath:z.string(),expiresAt:z.string()}),'RehearsalVoiceSession')}}}}});
const closeVoiceRoute=createRoute({method:'post',path:prefix+'/voice-sessions/{sessionId}/close',tags:['rehearsals'],summary:'幂等关闭语音会话',request:{params:sessionParams,body:{required:true,content:{'application/json':{schema:z.object({}).strict()}}}},responses:{200:{description:'已关闭',content:{'application/json':{schema:apiEnvelope(z.object({sessionId:z.string().uuid(),status:z.literal('closed')}),'RehearsalVoiceClosed')}}}}});
const speechCreateRoute=createRoute({method:'post',path:prefix+'/turns/{sequence}/speech',tags:['rehearsals'],summary:'朗读已生成的评委文字（仅语音合成）',request:{params:params.extend({sequence:z.coerce.number().int().min(1)}),body:{required:true,content:{'application/json':{schema:z.object({}).strict()}}}},responses:{202:{description:'朗读已排队',content:{'application/json':{schema:apiEnvelope(z.object({jobId:z.string().uuid(),speechId:z.string().uuid(),status:z.string()}),'RehearsalSpeechQueued')}}}}});
const speechGetRoute=createRoute({method:'get',path:prefix+'/speech/{speechId}',tags:['rehearsals'],summary:'查询私有评委朗读',request:{params:speechParams},responses:{200:{description:'朗读状态',content:{'application/json':{schema:apiEnvelope(z.object({speechId:z.string().uuid(),status:z.string(),audioPath:z.string().optional(),error:z.string().optional()}),'RehearsalSpeechState')}}}}});

export function registerRehearsalVoiceRoutes(app:OpenAPIHono<AppEnv>):void {
  app.use('/api/v1/projects/:projectId/rehearsals/*',requireUser,requireProjectMember(),requireAllowedOrigin);
  app.openapi(voiceRoute,async c=>c.json(apiData(c,await readRehearsalVoice(c.env,{...c.req.valid('param'),actorId:c.get('user')!.id})),200));
  app.openapi(createVoiceRoute,async c=>c.json(apiData(c,await createRehearsalVoiceSession(c.env,{...c.req.valid('param'),actorId:c.get('user')!.id},c.req.valid('json'))),201));
  app.openapi(closeVoiceRoute,async c=>{const {sessionId,...binding}=c.req.valid('param');return c.json(apiData(c,await closeRehearsalVoiceSession(c.env,{...binding,actorId:c.get('user')!.id},sessionId)),200);});
  app.get('/api/v1/projects/:projectId/rehearsals/:rehearsalId/voice-sessions/:sessionId/stream',async c=>{
    const parsed=sessionParams.safeParse(c.req.param());if(!parsed.success)throw validationFailed('语音会话路径无效');
    if(c.req.header('upgrade')?.toLowerCase()!=='websocket')throw validationFailed('需要WebSocket升级');
    const origin=c.req.header('origin'),allowed=(c.env.ALLOWED_ORIGINS??'').split(',').map(x=>x.trim());
    if(!origin || (!allowed.includes(origin) && !(c.env.ENV_NAME==='local' && /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin))))throw permissionDenied('语音连接来源不在允许列表');
    const {sessionId,...binding}=parsed.data,actorId=c.get('user')!.id,token=parseCookies(c.req.header('cookie'))[SESSION_COOKIE];
    return openRehearsalVoiceStream(c.env,{...binding,actorId},sessionId,{authenticate:async()=>{if((await loadSessionUser(c.env,token))?.id!==actorId)throw unauthenticated('语音登录已失效');},waitUntil:promise=>c.executionCtx.waitUntil(promise)});
  });
  app.openapi(speechCreateRoute,async c=>c.json(apiData(c,await enqueueRehearsalSpeech(c.env,{...c.req.valid('param'),actorId:c.get('user')!.id})),202));
  app.openapi(speechGetRoute,async c=>c.json(apiData(c,await readRehearsalSpeech(c.env,{...c.req.valid('param'),actorId:c.get('user')!.id})),200));
  app.get('/api/v1/projects/:projectId/rehearsals/:rehearsalId/speech/:speechId/audio',async c=>{
    const parsed=speechParams.safeParse(c.req.param());if(!parsed.success)throw validationFailed('朗读音频路径无效');
    const response=await readRehearsalSpeechAudio(c.env,{...parsed.data,actorId:c.get('user')!.id});response.headers.set('Cache-Control','private, no-store');return response;
  });
}
