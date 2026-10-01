import {describe,expect,it,vi} from 'vitest';
import {failureBody} from '../src/core/http';
import {createApp} from '../src/app';
import {apiErrorEnvelope} from '../src/core/openapi';
import type {Env} from '../src/env';
const requestId='328b10e3-f7fd-4e08-9a9e-218a12384041';
describe('safe detailed errors',()=>{
  it.each([
    ['VALIDATION_FAILED','validation','correct_input'],['UNAUTHENTICATED','authentication','sign_in'],
    ['PERMISSION_DENIED','authorization','check_access'],['VERSION_CONFLICT','state','refresh_state'],
    ['FILE_TOO_LARGE','upload','check_file'],['SOURCE_PARSE_FAILED','source_parse','check_source'],
    ['AI_UNAVAILABLE','model_configuration','configure_ai'],['INTERNAL','internal','contact_admin'],
  ])('adds fixed guidance for %s and keeps one request ID',(code,stage,action)=>{
    const body=failureBody(code,'应用提示',false,requestId);
    expect(body).toMatchObject({requestId,error:{code,stage,action,requestId,retryable:false}});
    expect(apiErrorEnvelope.safeParse(body).success).toBe(true);
  });
  it.each(['INTERNAL','AI_UNAVAILABLE','EMAIL_UNAVAILABLE','SOURCE_PARSE_FAILED'])('removes dependency body, stack and details from %s',code=>{
    const body=failureBody(code,'fixture-secret raw body stack',true,requestId,{apiKey:'fixture-secret',rawBody:'fixture-secret',stack:'fixture-secret'});
    expect(JSON.stringify(body)).not.toContain('fixture-secret');expect(body.error.details).toBeUndefined();
  });
  it('preserves safe conflict data and replaces an invalid correlation value',()=>{
    const body=failureBody('VERSION_CONFLICT','内容已更新',false,'fixture-secret',{currentRevision:2});
    expect(body.error.details).toEqual({currentRevision:2});expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);expect(JSON.stringify(body)).not.toContain('fixture-secret');
  });
  it('logs only fixed fields for an unhandled server exception and returns matching guidance',async()=>{
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    try{
      const app=createApp();app.get('/api/v1/fixture-throw',()=>{throw new Error('fixture-secret stack raw provider body');});
      const response=await app.request('http://fixture.test/api/v1/fixture-throw',{headers:{'X-Request-Id':requestId}},{ALLOWED_ORIGINS:'http://fixture.test',ENV_NAME:'local'} as Env);
      const body=await response.json();expect(response.status).toBe(500);expect(body).toMatchObject({requestId,error:{code:'INTERNAL',stage:'internal',action:'contact_admin',requestId,retryable:false}});
      expect(response.headers.get('X-Request-Id')).toBe(requestId);expect(JSON.stringify([body,log.mock.calls])).not.toContain('fixture-secret');
    }finally{log.mockRestore();}
  });
});
