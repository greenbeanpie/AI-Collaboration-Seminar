import { afterEach, expect, it, vi } from 'vitest';
import { uploadMultipartFile } from './document-import-client';
afterEach(() => vi.unstubAllGlobals());
it('propagates the original multipart failure reason and stops sending parts', async () => {
  const message = '分片大小不匹配或文件已变化\n原始详情';
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({data:{sessionId:'upload',partBytes:1}}))
    .mockResolvedValueOnce(Response.json({data:{status:'uploading',parts:[]}}))
    .mockResolvedValueOnce(Response.json({error:{code:'INVALID_STATE',message,retryable:false},requestId:'private-id'},{status:409}));
  vi.stubGlobal('fetch',fetchMock);
  await expect(uploadMultipartFile('project','file',new File(['abc'],'test.pdf'))).rejects.toMatchObject({message,code:'INVALID_STATE'});
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
