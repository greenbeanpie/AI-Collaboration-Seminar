import {describe,expect,it} from 'vitest';
import {ApiError} from './client';
import {errorInfo} from './error-info';
const requestId='328b10e3-f7fd-4e08-9a9e-218a12384041';
describe('public error guidance',()=>{
  it('shows version recovery and a correlatable request without enabling automatic retries',()=>{
    const error=new ApiError(409,{error:{code:'VERSION_CONFLICT',message:'内容已更新',retryable:false,stage:'state',action:'refresh_state'},requestId});
    expect(error.message).toContain('先刷新并核对操作是否已完成');expect(error.message).toContain('VERSION_CONFLICT');expect(error.message).toContain('阶段：state');expect(error.message).toContain(requestId);expect(error.retryable).toBe(false);
  });
  it.each(['INTERNAL','AI_UNAVAILABLE','EMAIL_UNAVAILABLE','SOURCE_PARSE_FAILED'])('does not expose dependency details in %s',code=>{
    const error=new ApiError(500,{error:{code,message:'fixture-secret raw provider body stack',retryable:false,stage:'fixture-secret',action:'fixture-secret'},requestId});
    expect(error.message).not.toContain('fixture-secret');expect(error.message).not.toContain('raw provider');expect(error.message).toContain(requestId);
  });
  it('ignores unrecognized metadata and non-UUID identifiers',()=>{
    expect(errorInfo({code:'fixture-secret',stage:'fixture-secret',action:'fixture-secret'},'fixture-secret')).toBe('');
  });
});
