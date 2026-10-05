import { afterEach, expect, it, vi } from 'vitest';
import { authenticatedVoicePath, voiceRequest } from './rehearsalVoiceApi';
afterEach(()=>vi.unstubAllGlobals());
it('private voice operations include cookies and bypass offline cache',async()=>{
 const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({data:{ready:true},requestId:'fixture'}),{status:200}));vi.stubGlobal('fetch',fetch);
 expect(await voiceRequest('/api/v1/projects/p/rehearsals/r/voice')).toEqual({ready:true});expect(fetch.mock.calls[0][1]).toMatchObject({credentials:'include',cache:'no-store',method:'GET'});
});
it('propagates API failures instead of creating simulated success',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{code:'VOICE_UNAVAILABLE',message:'不可用',retryable:true},requestId:'fixture'}),{status:503})));
 await expect(voiceRequest('/api/v1/projects/p/rehearsals/r/voice')).rejects.toMatchObject({status:503,code:'VOICE_UNAVAILABLE'});
});
it('rejects external or mismatched websocket paths',()=>{
 const prefix='/api/v1/projects/p/rehearsals/r';expect(authenticatedVoicePath(`${prefix}/voice-sessions/s/stream`,prefix)).toBe(`${prefix}/voice-sessions/s/stream`);
 for(const path of ['https://generativelanguage.googleapis.com/live','//external/live','/api/v1/projects/other/rehearsals/r/audio',`${prefix}/../audio`,`${prefix}/audio?key=secret`])expect(()=>authenticatedVoicePath(path,prefix)).toThrow();
});
