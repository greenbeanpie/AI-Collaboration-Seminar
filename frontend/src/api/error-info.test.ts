import { describe, expect, it } from 'vitest';
import { ApiError } from './client';
import { errorMessage } from './error-info';
describe('verbatim backend reasons', () => {
  it.each(['INTERNAL','AI_UNAVAILABLE','EMAIL_UNAVAILABLE','SOURCE_PARSE_FAILED','INVALID_STATE','NETWORK_ERROR'])('preserves every character for %s', code => {
    const message = '  项目人数已满、权限已变化或对方已经加入\n模型返回：<script>raw detail</script>  ';
    const error = new ApiError(500, {requestId:'internal-correlation', error:{code,message,retryable:false,stage:'state',action:'refresh_state'}});
    expect(error.message).toBe(message); expect(error.diagnosticMessage).toBe(message);
    expect(error.code).toBe(code); expect(error.requestId).toBe('internal-correlation'); expect(error.retryable).toBe(false);
    expect(errorMessage(error)).toBe(message);
  });
  it('accepts job error objects and nested envelopes without stringifying metadata', () => {
    expect(errorMessage({error:{message:'具体失败原因\n第二行',code:'INTERNAL'}})).toBe('具体失败原因\n第二行');
    expect(errorMessage({message:''})).toBe('');
    expect(errorMessage('原始原因')).toBe('原始原因');
    expect(errorMessage(null,'本机操作失败')).toBe('本机操作失败');
  });
});
