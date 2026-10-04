import { afterEach, describe, expect, it, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { env, BASE } from './helpers/env';
import { seedProject, seedUser, authCookie } from './helpers/seed';
import { configureGoFixture } from './helpers/provider-config';
import { extractSourceVersionText, ocrPendingPages } from '../src/services/parse';
import { ocrBatchSize, ocrContext, parseOcrBatch, removeOcrDuplicates, summaryBoundaryContext } from '../src/services/ocr-batches';
import { gatewayChat } from '../src/ai/gateway';
import { aiModelConfigSchema } from '../src/ai/config';

await configureGoFixture();
afterEach(()=>vi.unstubAllGlobals());
const response = (data: unknown) => Response.json({choices:[{message:{content:JSON.stringify(data)}}],usage:{prompt_tokens:50,completion_tokens:30}});
async function fixture(count=3) {
  const configRow=await env.DB.prepare('SELECT id,config_json FROM ai_config_versions ORDER BY version DESC LIMIT 1').first<{id:string;config_json:string}>();
  const config=JSON.parse(configRow!.config_json);config.visionEconomy.maxOutputTokens=6000;
  await env.DB.prepare('UPDATE ai_config_versions SET config_json=?2 WHERE id=?1').bind(configRow!.id,JSON.stringify(config)).run();
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
  return {sourceVersionId};
}
describe('bounded OCR batches',()=>{
  it('groups consecutive pages while respecting image/output budget',()=>{
    expect(ocrBatchSize([1,2,3,4].map(page_number=>({page_number,size_bytes:100})),48000,6000)).toBe(3);
    expect(ocrBatchSize([{page_number:1,size_bytes:100},{page_number:3,size_bytes:100}],48000,6000)).toBe(1);
    expect(ocrBatchSize([1,2,3].map(page_number=>({page_number,size_bytes:100})),48000,2000)).toBe(1);
    expect(()=>ocrBatchSize([{page_number:1,size_bytes:2000000}],1000,6000)).toThrow();
    expect(ocrContext('文'.repeat(3000),10000)).toHaveLength(1000);
    expect(ocrContext('全文',1)).toBe('');
    expect(ocrContext('文😀',10)).toBe('');
  });
  it('rejects duplicate, foreign and malformed pages without discarding valid neighbours',()=>{
    expect(parseOcrBatch({pages:[{pageNumber:1,text:'甲'},{pageNumber:1,text:'乙'},{pageNumber:2,text:'有效'},{pageNumber:3,text:''},{pageNumber:8,text:'外部'}]},[1,2,3])).toEqual([{pageNumber:2,text:'有效',confidence:null,unrecognizedRegions:[]}]);
    expect(removeOcrDuplicates('已有文字\n新文字',['已有 文字'])).toBe('新文字');
    expect(summaryBoundaryContext([[{id:'a',page_number:1,content:'abcd'}],[{id:'b',page_number:2,content:'efgh'}]],1,2)[0]?.content).toBe('cd');
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
    const config=aiModelConfigSchema.parse({provider:'workers-ai',model:'test',timeoutMs:1000,maxInputChars:1000,maxOutputTokens:100,supportsVision:true,supportsJson:true});
    const fetch=vi.fn(async()=>Response.json({error:{message:'Invalid parameter'}},{status:400}));
    await expect(gatewayChat({accountId:'x',apiToken:'x',gatewayId:'x'},{config,messages:[{role:'user',content:'test'}]},fetch)).rejects.toMatchObject({details:{status:400}});
    expect(fetch).toHaveBeenCalledOnce();
  });
});
