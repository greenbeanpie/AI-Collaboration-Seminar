import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadSourcePdf, readTrackedSourceJobs, writeTrackedSourceJobs, sourceFileId, rememberSourceFile } from './source-workflows';
import { rememberAccount, forgetAccount } from '../offline/store';
import type { User } from '../api/types';

afterEach(() => { vi.unstubAllGlobals(); forgetAccount(); sessionStorage.clear(); });

it('preserves binary download failure reasons even without correlation metadata', async () => {
  const message = '来源不存在或无权读取\n原始详情';
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({error:{message,code:'INTERNAL',retryable:false}},{status:500})));
  await expect(downloadSourcePdf('project','file')).rejects.toMatchObject({message,code:'INTERNAL',status:500});
});


describe('account-isolated source tracking', () => {
  const job = { jobId: 'j', sourceId: 's', sourceVersionId: 'v', sourceTitle: '私有资料', fileId: 'f' };
  it('never reads another account jobs or source-file associations in the same project', () => {
    rememberAccount({ id: 'account-a' } as User);
    writeTrackedSourceJobs('project', [job]);
    rememberSourceFile('project', 'v', 'f');
    expect(sessionStorage.getItem('ai-office:source-jobs:account-a:project')).not.toBeNull();
    expect(sessionStorage.getItem('ai-office:source-files:account-a:project')).not.toBeNull();
    rememberAccount({ id: 'account-b' } as User);
    expect(readTrackedSourceJobs('project')).toEqual([]);
    expect(sourceFileId('project', 'v')).toBeNull();
    writeTrackedSourceJobs('project', [{ ...job, jobId: 'b-job' }]);
    rememberSourceFile('project', 'v', 'b-file');
    rememberAccount({ id: 'account-a' } as User);
    expect(readTrackedSourceJobs('project')).toEqual([job]);
    expect(sourceFileId('project', 'v')).toBe('f');
  });
  it('ignores legacy cache entries with unknown owners and separates anonymous tracking', () => {
    sessionStorage.setItem('ai-office:v1:project:source-jobs', JSON.stringify([job]));
    sessionStorage.setItem('ai-office:v1:project:source-files', JSON.stringify({ v: 'f' }));
    forgetAccount();
    expect(readTrackedSourceJobs('project')).toEqual([]);
    expect(sourceFileId('project', 'v')).toBeNull();
    writeTrackedSourceJobs('project', [job]);
    rememberSourceFile('project', 'v', 'anonymous-file');
    expect(sessionStorage.getItem('ai-office:source-jobs:anonymous:project')).not.toBeNull();
    rememberAccount({ id: 'account-a' } as User);
    expect(readTrackedSourceJobs('project')).toEqual([]);
    expect(sourceFileId('project', 'v')).toBeNull();
  });
});
