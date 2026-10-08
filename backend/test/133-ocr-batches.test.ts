import { ensureExecution, readExecution, resumeExecution } from '../src/services/ai-execution-control';
import { BackgroundContinuation } from '../src/services/ai-execution-slices';
import { reserveAiSlot } from '../src/services/ai-reservations';
import { getJob } from '../src/services/jobs';
import { loadResponseCheckpoint } from '../src/services/ai-checkpoints';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { env, BASE } from './helpers/env';
import { seedProject, seedUser, authCookie } from './helpers/seed';
import { configureGoFixture } from './helpers/provider-config';
import { extractSourceVersionText, ocrPendingPages } from '../src/services/parse';
import { ocrBatchSize, ocrContext, parseOcrBatch, removeOcrDuplicates } from '../src/services/ocr-batches';
import { gatewayChat } from '../src/ai/gateway';
import { aiModelConfigSchema } from '../src/ai/config';

await configureGoFixture();
afterEach(()=>vi.unstubAllGlobals());
const response = (data: unknown) => Response.json({choices:[{message:{content:JSON.stringify(data)}}],usage:{prompt_tokens:50,completion_tokens:30}});
async function fixture(count=3) {
  const configRow=await env.DB.prepare('SELECT id,config_json FROM ai_config_versions ORDER BY version DESC LIMIT 1').first<{id:string;config_json:string}>();
  const owner=await seedUser();const projectId=await seedProject(owner.userId);
  const res=await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/sources`,{method:'POST',headers:{cookie:authCookie(owner.token),'content-type':'application/json'},body:JSON.stringify({kind:'paste',text:'前文截止时间'})});
  const {sourceVersionId}= (await res.json() as {data:{sourceVersionId:string}}).data;
  await extractSourceVersionText(env,sourceVersionId);
  await env.DB.prepare('UPDATE source_fragments SET page_number=1 WHERE source_version_id=?1').bind(sourceVersionId).run();
  const now=new Date().toISOString();
  for(let n=2;n<count+2;n++) {
    const fileId=crypto.randomUUID();const key=`ocr-test/${fileId}`;
    await env.FILES.put(key,new Uint8Array([1,2,3]));
    await env.DB.prepare("INSERT INTO files(id,project_id,uploader_user_id,r2_key,mime_detected,ext,size_bytes,status,created_at) VALUES(?1,?2,?3,?4,'image/png','.png',3,'available',?5)").bind(fileId,projectId,owner.userId,key,now).run();
    await env.DB.prepare("INSERT INTO source_pages(id,source_version_id,project_id,page_number,text_status,image_file_id,image_status,ocr_status,updated_at) VALUES(?1,?2,?3,?4,'none',?5,'uploaded','pending',?6)").bind(crypto.randomUUID(),sourceVersionId,projectId,n,fileId,now).run();
  }
  return {sourceVersionId,projectId,owner,configVersionId:configRow!.id};
}
async function jobFixture(count=3){
 const f=await fixture(count),jobId=crypto.randomUUID(),now=new Date().toISOString();
 await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_by,created_at,updated_at) VALUES(?1,?2,'ocr_pages','running',?3,?4,?5,?5)").bind(jobId,f.projectId,JSON.stringify({sourceVersionId:f.sourceVersionId,sourceLifecycleVersion:1,configVersionId:f.configVersionId,phase:'ocr',operation:'source.ocr'}),f.owner.userId,now).run();
 await ensureExecution(env,{kind:'job',id:jobId});await reserveAiSlot(env,{projectId:f.projectId,jobId,purpose:'ocr_pages'});return {...f,jobId};
}
const sliceEnv=()=>({...env,AI_EXECUTION_SLICE:true as const,AI_EXECUTION_CONTEXT:{modelCalls:0}});
describe('bounded OCR batches',()=>{
  it('groups consecutive pages while respecting the fixed request and image budgets',()=>{
    expect(ocrBatchSize([1,2,3,4].map(page_number=>({page_number,size_bytes:100})))).toBe(3);
    expect(ocrBatchSize([{page_number:1,size_bytes:100},{page_number:3,size_bytes:100}])).toBe(1);
    expect(ocrBatchSize([{page_number:1,size_bytes:2000000}])).toBe(1);
    expect(()=>ocrBatchSize([{page_number:1,size_bytes:3*1024*1024}])).toThrow();
    expect(ocrContext('文'.repeat(3000),10000)).toHaveLength(1000);
    expect(ocrContext('全文',1)).toBe('');
    expect(ocrContext('文😀',10)).toBe('');
  });
  it('rejects duplicate, foreign and malformed pages without discarding valid neighbours',()=>{
    expect(parseOcrBatch({pages:[{pageNumber:1,text:'甲'},{pageNumber:1,text:'乙'},{pageNumber:2,text:'有效'},{pageNumber:3,text:''},{pageNumber:8,text:'外部'}]},[1,2,3])).toEqual([{pageNumber:2,text:'有效',confidence:null,unrecognizedRegions:[]}]);
    expect(removeOcrDuplicates('已有文字\n新文字',['已有 文字'])).toBe('新文字');
  });
  it('uploads three images in one request with bounded previous-page context and audit',async()=>{
    const f=await fixture();const fetch=vi.fn(async(_input: RequestInfo | URL, _init?: RequestInit)=>response({pages:[2,3,4].map(pageNumber=>({pageNumber,text:`第${pageNumber}页内容`,confidence:.9}))}));vi.stubGlobal('fetch',fetch);
    expect(await ocrPendingPages(env,f.sourceVersionId)).toEqual({ocred:3,failed:0,stillMissing:0});
    expect(fetch).toHaveBeenCalledOnce();
    const body=JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body.messages[0].content.filter((p:{type:string})=>p.type==='image_url')).toHaveLength(3);
    expect(JSON.stringify(body)).toContain('前文截止时间');
    expect(await env.DB.prepare('SELECT status,page_numbers_json,context_chars FROM source_ocr_batches WHERE source_version_id=?1').bind(f.sourceVersionId).first()).toMatchObject({status:'ok',page_numbers_json:'[2,3,4]',context_chars:6});
  });
  it('preserves partial success and does not automatically repeat omitted pages',async()=>{
    const f=await fixture();const fetch=vi.fn(async()=>response({pages:[{pageNumber:2,text:'成功页面'}]}));vi.stubGlobal('fetch',fetch);
    expect(await ocrPendingPages(env,f.sourceVersionId)).toEqual({ocred:1,failed:2,stillMissing:0});
    await ocrPendingPages(env,f.sourceVersionId);expect(fetch).toHaveBeenCalledOnce();
  });
  it('does not replay uncertain network dispatch on recovery',async()=>{
    const f=await fixture();const fetch=vi.fn(async()=>{throw new TypeError('network');});vi.stubGlobal('fetch',fetch);
    expect(await ocrPendingPages(env,f.sourceVersionId)).toMatchObject({ocred:0,failed:3});
    await ocrPendingPages(env,f.sourceVersionId);expect(fetch).toHaveBeenCalledOnce();
  });
  it('persists single-image fallback only after an explicit multi-image rejection',async()=>{
    const f=await fixture();let call=0;const fetch=vi.fn(async()=>{call++;return call===1?Response.json({error:{message:'Only one image is supported'}},{status:400}):response({text:`第${call}页`,confidence:.8});});vi.stubGlobal('fetch',fetch);
    expect(await ocrPendingPages(env,f.sourceVersionId)).toMatchObject({ocred:3,failed:0});expect(fetch).toHaveBeenCalledTimes(4);
    expect(await env.DB.prepare('SELECT single_image_only FROM ocr_model_capabilities').first()).toEqual({single_image_only:1});
  });
  it('does not classify generic 400 as a safe multi-image fallback',async()=>{
    const config=aiModelConfigSchema.parse({provider:'workers-ai',model:'test',timeoutMs:1000,maxInputChars:1000,supportsVision:true,supportsJson:true});
    const fetch=vi.fn(async()=>Response.json({error:{message:'Invalid parameter'}},{status:400}));
    await expect(gatewayChat({accountId:'x',apiToken:'x',gatewayId:'x'},{config,messages:[{role:'user',content:'test'}]},fetch)).rejects.toMatchObject({details:{status:400}});
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('reads actual R2 image sizes for legacy rows with missing size metadata',async()=>{
    await env.DB.prepare('DELETE FROM ocr_model_capabilities').run();
    const f=await fixture();await env.DB.prepare('UPDATE files SET size_bytes=NULL WHERE id IN (SELECT image_file_id FROM source_pages WHERE source_version_id=?1)').bind(f.sourceVersionId).run();
    const row=await env.DB.prepare('SELECT id,config_json FROM ai_config_versions ORDER BY version DESC LIMIT 1').first<{id:string;config_json:string}>();
    const config=JSON.parse(row!.config_json);config.visionEconomy.maxInputChars=12000;
    await env.DB.prepare('UPDATE ai_config_versions SET config_json=?2 WHERE id=?1').bind(row!.id,JSON.stringify(config)).run();
    const fetch=vi.fn(async()=>response({pages:[2,3,4].map(pageNumber=>({pageNumber,text:'有效正文'}))}));vi.stubGlobal('fetch',fetch);
    expect(await ocrPendingPages(env,f.sourceVersionId)).toMatchObject({ocred:3,failed:0});expect(fetch).toHaveBeenCalledOnce();
  });

  it('retains a rejected OCR batch across 429 and a new slice without dropping claimed pages',async()=>{
    const f=await jobFixture(),fetch=vi.fn().mockResolvedValueOnce(Response.json({error:{message:'rate limit'}},{status:429})).mockImplementation(async()=>response({pages:[2,3,4].map(pageNumber=>({pageNumber,text:'完整第'+pageNumber+'页'}))}));vi.stubGlobal('fetch',fetch);
    await expect(ocrPendingPages(sliceEnv(),f.sourceVersionId,f.configVersionId,f.jobId,1)).rejects.toBeInstanceOf(BackgroundContinuation);
    const pointer=JSON.parse((await getJob(env,f.jobId)).input_json).ocrCheckpoint;expect(await loadResponseCheckpoint<{phase:string;providerRetry:{attempt:number}}>(env,pointer)).toMatchObject({phase:'safe',providerRetry:{attempt:1}});
    await expect(ocrPendingPages(sliceEnv(),f.sourceVersionId,f.configVersionId,f.jobId,1)).rejects.toBeInstanceOf(BackgroundContinuation);
    expect(await ocrPendingPages(sliceEnv(),f.sourceVersionId,f.configVersionId,f.jobId,1)).toMatchObject({failed:0});expect(fetch).toHaveBeenCalledTimes(2);expect(await readExecution(env,{kind:'job',id:f.jobId})).toMatchObject({totalCalls:2});
    expect((await env.DB.prepare('SELECT ocr_status FROM source_pages WHERE source_version_id=?1 AND page_number IN (2,3,4)').bind(f.sourceVersionId).all<{ocr_status:string}>()).results.every(p=>p.ocr_status==='ok')).toBe(true);
  });
  it('publishes already paid OCR responses after a database interruption without repeating the provider',async()=>{
    const f=await jobFixture(),fetch=vi.fn(async()=>response({pages:[2,3,4].map(pageNumber=>({pageNumber,text:'缓存第'+pageNumber+'页'}))}));vi.stubGlobal('fetch',fetch);
    await env.DB.exec("CREATE TRIGGER fail_ocr_publish BEFORE INSERT ON source_fragments WHEN NEW.kind='ocr' BEGIN SELECT RAISE(FAIL,'fixture publish interruption'); END");
    await expect(ocrPendingPages(sliceEnv(),f.sourceVersionId,f.configVersionId,f.jobId,1)).rejects.toBeInstanceOf(BackgroundContinuation);await env.DB.exec('DROP TRIGGER fail_ocr_publish');
    expect(await ocrPendingPages(sliceEnv(),f.sourceVersionId,f.configVersionId,f.jobId,1)).toMatchObject({ocred:3,failed:0});expect(fetch).toHaveBeenCalledOnce();expect(await readExecution(env,{kind:'job',id:f.jobId})).toMatchObject({totalCalls:1});
    expect((await env.DB.prepare("SELECT content FROM source_fragments WHERE source_version_id=?1 AND kind='ocr'").bind(f.sourceVersionId).all()).results).toHaveLength(3);
  });
  it('does not replay an unknown OCR batch until explicit continuation, then retries the same page IDs',async()=>{
    const f=await jobFixture(),failed=vi.fn(async()=>{throw new Error('network');});vi.stubGlobal('fetch',failed);
    await expect(ocrPendingPages(sliceEnv(),f.sourceVersionId,f.configVersionId,f.jobId,1)).rejects.toMatchObject({details:{executionPause:true}});
    await expect(ocrPendingPages(sliceEnv(),f.sourceVersionId,f.configVersionId,f.jobId,1)).rejects.toThrow();expect(failed).toHaveBeenCalledOnce();
    await resumeExecution(env,{kind:'job',id:f.jobId},1,'continue',{allowUncertainDispatch:true});await env.DB.prepare("UPDATE jobs SET status='running',input_json=json_set(input_json,'$.allowUncertainCheckpointRetry',json('true')) WHERE id=?1").bind(f.jobId).run();
    const fixed=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>response({pages:[2,3,4].map(pageNumber=>({pageNumber,text:'第'+pageNumber+'页原文'}))}));vi.stubGlobal('fetch',fixed);await expect(ocrPendingPages(sliceEnv(),f.sourceVersionId,f.configVersionId,f.jobId,1)).rejects.toBeInstanceOf(BackgroundContinuation);
    await ocrPendingPages(sliceEnv(),f.sourceVersionId,f.configVersionId,f.jobId,1);expect(fixed).toHaveBeenCalledOnce();expect(JSON.stringify(JSON.parse(String(fixed.mock.calls[0]?.[1]?.body)))).toContain('当前图片页码：4');expect(JSON.parse((await getJob(env,f.jobId)).input_json).allowUncertainCheckpointRetry).toBe(false);
  });

  it('recovers the stable paid response even when updating the response cursor is interrupted',async()=>{
    const f=await jobFixture();const fetch=vi.fn(async()=>{await env.DB.exec("CREATE TRIGGER fail_ocr_pointer BEFORE UPDATE OF input_json ON jobs BEGIN SELECT RAISE(FAIL,'fixture cursor interruption'); END");return response({pages:[2,3,4].map(pageNumber=>({pageNumber,text:'指针恢复第'+pageNumber+'页'}))});});vi.stubGlobal('fetch',fetch);
    await expect(ocrPendingPages(sliceEnv(),f.sourceVersionId,f.configVersionId,f.jobId,1)).rejects.toBeInstanceOf(BackgroundContinuation);await env.DB.exec('DROP TRIGGER fail_ocr_pointer');
    expect(await ocrPendingPages(sliceEnv(),f.sourceVersionId,f.configVersionId,f.jobId,1)).toMatchObject({ocred:3,failed:0});expect(fetch).toHaveBeenCalledOnce();expect(await readExecution(env,{kind:'job',id:f.jobId})).toMatchObject({totalCalls:1});
  });

  it('keeps missing OCR pages for explicit correction and never repeats validated neighbours',async()=>{
    const f=await jobFixture(),partial=vi.fn(async()=>response({pages:[{pageNumber:2,text:'已验证页2'}]}));vi.stubGlobal('fetch',partial);await expect(ocrPendingPages(sliceEnv(),f.sourceVersionId,f.configVersionId,f.jobId,1)).rejects.toMatchObject({details:{executionPause:true}});
    expect(await readExecution(env,{kind:'job',id:f.jobId})).toMatchObject({pauseReason:'output_invalid'});await resumeExecution(env,{kind:'job',id:f.jobId},1,'continue');await env.DB.prepare("UPDATE jobs SET status='running' WHERE id=?1").bind(f.jobId).run();
    const corrected=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>response({pages:[3,4].map(pageNumber=>({pageNumber,text:'已修正第'+pageNumber+'页'}))}));vi.stubGlobal('fetch',corrected);await expect(ocrPendingPages(sliceEnv(),f.sourceVersionId,f.configVersionId,f.jobId,1)).rejects.toBeInstanceOf(BackgroundContinuation);
    await ocrPendingPages(sliceEnv(),f.sourceVersionId,f.configVersionId,f.jobId,1);expect(corrected).toHaveBeenCalledOnce();const payload=JSON.stringify(JSON.parse(String(corrected.mock.calls[0]?.[1]?.body)));expect(payload).toContain('修正上次输出错误');expect(payload).toContain('当前图片页码：3');expect(payload).not.toContain('当前图片页码：2');expect(await readExecution(env,{kind:'job',id:f.jobId})).toMatchObject({totalCalls:2});
  });

});
