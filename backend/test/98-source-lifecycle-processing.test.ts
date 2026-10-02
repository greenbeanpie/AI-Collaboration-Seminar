import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from './helpers/env';
import { seedProject, seedUser } from './helpers/seed';
import { configureGoFixture } from './helpers/provider-config';
import { mockGatewayFetch } from './helpers/ai-mock';
import { changeSourceLifecycle, changeFileLifecycle } from '../src/services/file-lifecycle';
import { createJobAndDispatch, getJob, tryDispatchJob } from '../src/services/jobs';
import { extractSourceVersionText, ocrPendingPages, runParseJob } from '../src/services/parse';
import { enqueueSourceSummary, runSourceSummary, setSourceStage } from '../src/services/source-summary';
import type { Env } from '../src/env';

await configureGoFixture();
afterEach(() => vi.unstubAllGlobals());

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

async function fixture(origin: 'paste' | 'file' = 'paste') {
  const owner = await seedUser(); const projectId = await seedProject(owner.userId);
  const sourceId = crypto.randomUUID(); const sourceVersionId = crypto.randomUUID(); const now = new Date().toISOString();
  const text = '比赛通知：参赛作品提交截止日期为 2026 年 10 月 8 日，每支队伍人数不超过 5 人。';
  const fileId = origin === 'file' ? crypto.randomUUID() : null;
  const originalKey = origin === 'file' ? `files/${fileId}/original.txt` : `sources/${sourceVersionId}/paste.txt`;
  if (fileId) await env.DB.prepare("INSERT INTO files(id,project_id,uploader_user_id,r2_key,ext,status,mime_detected,created_at) VALUES (?1,?2,?3,?4,'.txt','available','text/plain',?5)").bind(fileId,projectId,owner.userId,originalKey,now).run();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sources(id,project_id,kind,title,current_version_id,created_by,created_at,updated_at) VALUES (?1,?2,?3,\'fixture\',?4,?5,?6,?6)').bind(sourceId,projectId,origin,sourceVersionId,owner.userId,now),
    env.DB.prepare('INSERT INTO source_versions(id,source_id,project_id,revision,origin,file_id,text_r2_key,status,created_at) VALUES (?1,?2,?3,1,?4,?5,?6,\'pending\',?7)').bind(sourceVersionId,sourceId,projectId,origin,fileId,origin === 'paste' ? originalKey : null,now),
  ]);
  await env.FILES.put(originalKey,text);
  return { owner,projectId,sourceId,sourceVersionId,fileId,originalKey };
}

const dispatch = () => vi.fn(async ({ id }: { id: string }) => ({ id }));
function quietEnv(create = dispatch()): Env { return { ...env, PARSE_WORKFLOW: { create } } as unknown as Env; }

async function recycle(f: Awaited<ReturnType<typeof fixture>>, restore: boolean) {
  if (f.fileId) {
    await changeFileLifecycle(env,{projectId:f.projectId,fileId:f.fileId,actorId:f.owner.userId,expectedLifecycleVersion:1,restore:false});
    if (restore) await changeFileLifecycle(env,{projectId:f.projectId,fileId:f.fileId,actorId:f.owner.userId,expectedLifecycleVersion:2,restore:true});
  } else {
    await changeSourceLifecycle(env,{projectId:f.projectId,sourceId:f.sourceId,actorId:f.owner.userId,expectedLifecycleVersion:1,restore:false});
    if (restore) await changeSourceLifecycle(env,{projectId:f.projectId,sourceId:f.sourceId,actorId:f.owner.userId,expectedLifecycleVersion:2,restore:true});
  }
}

async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    version: await env.DB.prepare('SELECT status,text_r2_key,char_count,page_count,parse_error FROM source_versions WHERE id=?1').bind(f.sourceVersionId).first(),
    processing: await env.DB.prepare('SELECT * FROM source_processing WHERE source_version_id=?1').bind(f.sourceVersionId).first(),
    pages: (await env.DB.prepare('SELECT * FROM source_pages WHERE source_version_id=?1 ORDER BY page_number').bind(f.sourceVersionId).all()).results,
    fragments: (await env.DB.prepare('SELECT * FROM source_fragments WHERE source_version_id=?1 ORDER BY seq').bind(f.sourceVersionId).all()).results,
  };
}

function heldProvider(options?: Parameters<typeof mockGatewayFetch>[0]) {
  const started = deferred(); const release = deferred(); const mock = mockGatewayFetch(options);
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => { started.resolve(); await release.promise; return mock(url,init); });
  vi.stubGlobal('fetch',fetch);
  return { started,release,fetch };
}

describe('source lifecycle processing fences', () => {
  it('freezes the source lifecycle with the job/outbox and never redispatches cancelled work after restore', async () => {
    const f = await fixture(); const create = dispatch(); const e = quietEnv(create);
    const jobId = await createJobAndDispatch(e,{projectId:f.projectId,kind:'parse_source',createdBy:f.owner.userId,input:{sourceId:f.sourceId,sourceVersionId:f.sourceVersionId,phase:'extract'}});
    expect(JSON.parse((await getJob(env,jobId)).input_json).sourceLifecycleVersion).toBe(1);
    expect(create).toHaveBeenCalledOnce();
    await recycle(f,true);
    const fetch = vi.fn(); vi.stubGlobal('fetch',fetch);
    expect(await tryDispatchJob(e,jobId)).toBe('deferred');
    expect((await runParseJob(env,jobId)).status).toBe('cancelled');
    expect(create).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT status FROM job_outbox WHERE job_id=?1').bind(jobId).first()).toEqual({status:'failed'});
  });

  it('atomically rejects an enqueue that races deletion and restoration, without an orphan job or outbox', async () => {
    const f = await fixture('file'); const entered = deferred(); const release = deferred(); const create = dispatch();
    const e = { ...quietEnv(create), DB: { prepare: env.DB.prepare.bind(env.DB), batch: async (statements: D1PreparedStatement[]) => { entered.resolve(); await release.promise; return env.DB.batch(statements); } } } as unknown as Env;
    const jobId = crypto.randomUUID();
    const pending = createJobAndDispatch(e,{jobId,projectId:f.projectId,kind:'parse_source',createdBy:f.owner.userId,input:{sourceId:f.sourceId,sourceVersionId:f.sourceVersionId,phase:'extract'}}).catch(error => error);
    await entered.promise; await recycle(f,true); release.resolve();
    expect((await pending).code).toBe('INVALID_STATE');
    expect(await env.DB.prepare('SELECT id FROM jobs WHERE id=?1').bind(jobId).first()).toBeNull();
    expect(await env.DB.prepare('SELECT id FROM job_outbox WHERE job_id=?1').bind(jobId).first()).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it.each([false,true])('drops a late requirement response after deletion (restore=%s), preserving audit costs and cancelled state', async restore => {
    const f = await fixture(); const jobId = await createJobAndDispatch(quietEnv(),{projectId:f.projectId,kind:'parse_source',createdBy:f.owner.userId,input:{sourceId:f.sourceId,sourceVersionId:f.sourceVersionId,phase:'extract'}});
    const provider = heldProvider(); const pending = runParseJob(env,jobId);
    await provider.started.promise; await recycle(f,restore); const preserved = await snapshot(f); provider.release.resolve();
    expect((await pending).status).toBe('cancelled'); expect(await snapshot(f)).toEqual(preserved);
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM requirement_sets WHERE source_version_id=?1').bind(f.sourceVersionId).first()).toEqual({n:0});
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM ai_calls WHERE job_id=?1').bind(jobId).first()).toEqual({n:1});
    expect(await env.DB.prepare('SELECT status FROM usage_reservations WHERE job_id=?1').bind(jobId).first()).toEqual({status:'pending_reconcile'});
    expect((await runParseJob(env,jobId)).status).toBe('cancelled'); expect(provider.fetch).toHaveBeenCalledOnce();
  });

  it('drops a late summary after delete+restore without changing the cancellation revision or making a repair request', async () => {
    const f = await fixture(); await extractSourceVersionText(env,f.sourceVersionId); await setSourceStage(env,f.sourceVersionId,'text','ready');
    const summary = await enqueueSourceSummary(quietEnv(),f.sourceVersionId,f.owner.userId,0);
    const started = deferred(); const release = deferred();
    const fetch = vi.fn(async () => { started.resolve(); await release.promise; return new Response(JSON.stringify({choices:[{message:{content:'invalid JSON'}}],usage:{prompt_tokens:42,completion_tokens:17}}),{status:200,headers:{'content-type':'application/json'}}); });
    vi.stubGlobal('fetch',fetch); const pending = runSourceSummary(env,summary.jobId);
    await started.promise; await recycle(f,true); const preserved = await snapshot(f); release.resolve();
    expect((await pending).status).toBe('cancelled'); expect(await snapshot(f)).toEqual(preserved); expect(fetch).toHaveBeenCalledOnce();
    expect(await env.DB.prepare('SELECT summary_status,summary_json,summary_revision FROM source_processing WHERE source_version_id=?1').bind(f.sourceVersionId).first()).toEqual({summary_status:'cancelled',summary_json:null,summary_revision:2});
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM ai_calls WHERE job_id=?1').bind(summary.jobId).first()).toEqual({n:1});
  });

  it('drops a valid summary response after restoration and leaves the cancelled summary unchanged', async () => {
    const f = await fixture(); await extractSourceVersionText(env,f.sourceVersionId); await setSourceStage(env,f.sourceVersionId,'text','ready');
    const summary = await enqueueSourceSummary(quietEnv(),f.sourceVersionId,f.owner.userId,0);
    const provider = heldProvider(); const pending = runSourceSummary(env,summary.jobId);
    await provider.started.promise; await recycle(f,true); const preserved = await snapshot(f); provider.release.resolve();
    expect((await pending).status).toBe('cancelled'); expect(await snapshot(f)).toEqual(preserved); expect(provider.fetch).toHaveBeenCalledOnce();
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM ai_calls WHERE job_id=?1').bind(summary.jobId).first()).toEqual({n:1});
    expect((await runSourceSummary(env,summary.jobId)).status).toBe('cancelled'); expect(provider.fetch).toHaveBeenCalledOnce();
  });

  it('keeps queued, running and waiting-input source jobs cancelled after restore', async () => {
    const f = await fixture(); const ids: string[] = []; const now = new Date().toISOString();
    for (const status of ['queued','running','waiting_input']) {
      const id = crypto.randomUUID(); ids.push(id);
      await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,attempts,created_by,created_at,updated_at) VALUES (?1,?2,'parse_source',?3,?4,0,?5,?6,?6)").bind(id,f.projectId,status,JSON.stringify({sourceId:f.sourceId,sourceVersionId:f.sourceVersionId,sourceLifecycleVersion:1,phase:'extract'}),f.owner.userId,now).run();
    }
    await recycle(f,true); const create = dispatch(); const fetch = vi.fn(); vi.stubGlobal('fetch',fetch);
    for (const id of ids) { expect(await tryDispatchJob(quietEnv(create),id)).toBe('deferred'); expect((await runParseJob(env,id)).status).toBe('cancelled'); }
    expect(fetch).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });

  it('guards stale parse page/fragments batches and isolates old R2 output from restored lifecycle text', async () => {
    const f = await fixture(); const entered = deferred(); const release = deferred(); let firstBatch = true;
    const e = { ...env, DB: { prepare: env.DB.prepare.bind(env.DB), batch: async (statements: D1PreparedStatement[]) => { if(firstBatch) { firstBatch=false; entered.resolve(); await release.promise; } return env.DB.batch(statements); } } } as unknown as Env;
    const stale = extractSourceVersionText(e,f.sourceVersionId).catch(error => error);
    await entered.promise; expect(await env.FILES.get(`sources/${f.sourceVersionId}/lifecycle-1/text.txt`)).not.toBeNull();
    await recycle(f,true); await env.FILES.put(f.originalKey,'恢复后的新内容，必须保留且不能被旧片段覆盖。');
    await extractSourceVersionText(env,f.sourceVersionId); const preserved = await snapshot(f); release.resolve();
    expect((await stale).code).toBe('NOT_FOUND'); expect(await snapshot(f)).toEqual(preserved);
    expect(preserved.version).toMatchObject({text_r2_key:`sources/${f.sourceVersionId}/lifecycle-3/text.txt`});
    expect((preserved.fragments[0] as {content:string}).content).toContain('恢复后的新内容');
    expect(await env.FILES.get(`sources/${f.sourceVersionId}/text.txt`)).toBeNull();
  });

  it('captures lifecycle for direct OCR without a job ID and discards its late response after restore', async () => {
    const f = await fixture(); const imageId = crypto.randomUUID(); const key = `files/${imageId}/page.png`; const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO files(id,project_id,uploader_user_id,r2_key,ext,status,mime_detected,created_at) VALUES (?1,?2,?3,?4,'.png','available','image/png',?5)").bind(imageId,f.projectId,f.owner.userId,key,now),
      env.DB.prepare("INSERT INTO source_pages(id,source_version_id,project_id,page_number,text_status,image_file_id,image_status,ocr_status,updated_at) VALUES (?1,?2,?3,1,'none',?4,'uploaded','pending',?5)").bind(crypto.randomUUID(),f.sourceVersionId,f.projectId,imageId,now),
    ]);
    await env.FILES.put(key,new Uint8Array([1,2,3]));
    const provider = heldProvider(); const pending = ocrPendingPages(env,f.sourceVersionId).catch(error => error);
    await provider.started.promise; await recycle(f,true); const preserved = await snapshot(f); provider.release.resolve();
    expect((await pending).code).toBe('NOT_FOUND'); expect(await snapshot(f)).toEqual(preserved); expect(provider.fetch).toHaveBeenCalledOnce();
    expect(await env.FILES.get(`sources/${f.sourceVersionId}/lifecycle-1/ocr-page-1.txt`)).toBeNull();
    expect(await env.FILES.get(`sources/${f.sourceVersionId}/ocr-page-1.txt`)).toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM ai_calls WHERE project_id=?1 AND purpose='visionEconomy'").bind(f.projectId).first()).toEqual({n:1});
  });
});
