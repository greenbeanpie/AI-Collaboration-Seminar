import { describe,it,expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { env,BASE } from './helpers/env';
import { seedUser,seedProject,authCookie } from './helpers/seed';

async function fixture(ext='.pdf') {
 const user=await seedUser(),project=await seedProject(user.userId),headers={cookie:authCookie(user.token),'content-type':'application/json'};
 const r=await SELF.fetch(`${BASE}/api/v1/projects/${project}/files`,{method:'POST',headers,body:JSON.stringify({fileName:'资料'+ext})});expect(r.status).toBe(201);
 const f=(await r.json() as {data:{fileId:string;upload:{url:string}}}).data;
 return {user,project,headers,file:f.fileId,url:f.upload.url};
}
describe('resumable document imports',()=>{
 it('streams multipart, resumes a part, completes idempotently and serves byte ranges',async()=>{
  const f=await fixture(),path=`${BASE}/api/v1/projects/${f.project}/files/${f.file}/uploads`,bytes=new TextEncoder().encode('%PDF-1.4 test document');
  const start=await SELF.fetch(path,{method:'POST',headers:f.headers,body:JSON.stringify({sizeBytes:bytes.length})});expect(start.status).toBe(201);
  const {sessionId}=(await start.json() as {data:{sessionId:string}}).data;
  const part=await SELF.fetch(`${path}/${sessionId}/parts/1`,{method:'PUT',headers:{cookie:f.headers.cookie,'x-part-size':String(bytes.length)},body:bytes});expect(part.status).toBe(201);
  const status=await SELF.fetch(`${path}/${sessionId}`,{headers:f.headers});expect((await status.json() as {data:{parts:unknown[]}}).data.parts).toHaveLength(1);
  expect((await SELF.fetch(`${path}/${sessionId}/complete`,{method:'POST',headers:f.headers})).status).toBe(200);
  expect((await SELF.fetch(`${path}/${sessionId}/complete`,{method:'POST',headers:f.headers})).status).toBe(200);
  const range=await SELF.fetch(`${BASE}${f.url}`,{headers:{cookie:f.headers.cookie,range:'bytes=0-4'}});expect(range.status).toBe(206);expect(new TextDecoder().decode(await range.arrayBuffer())).toBe('%PDF-');
 });
 it('binds import batches to version/lifecycle and rejects changed replay',async()=>{
  const f=await fixture();expect((await SELF.fetch(`${BASE}${f.url}`,{method:'PUT',headers:{cookie:f.headers.cookie},body:new TextEncoder().encode('%PDF-1.4 fixture')})).status).toBe(201);
  const src=await SELF.fetch(`${BASE}/api/v1/projects/${f.project}/sources`,{method:'POST',headers:f.headers,body:JSON.stringify({kind:'file',fileId:f.file})});
  const {sourceVersionId}=(await src.json() as {data:{sourceVersionId:string}}).data;
  const path=`${BASE}/api/v1/projects/${f.project}/document-imports`;
  const init=await SELF.fetch(path,{method:'POST',headers:f.headers,body:JSON.stringify({sourceVersionId,method:'browser-pdf'})});expect(init.status).toBe(200);
  const {sessionId}=(await init.json() as {data:{sessionId:string}}).data;
  const body={batchNumber:0,blocks:[{seq:0,pageNumber:1,text:'中文😀原文，截止时间为10月8日。'}]};
  for(let n=0;n<2;n++)expect((await SELF.fetch(`${path}/${sessionId}/batches`,{method:'POST',headers:f.headers,body:JSON.stringify(body)})).status).toBe(200);
  const count=await env.DB.prepare('SELECT COUNT(*) n FROM source_fragments WHERE source_version_id=?1').bind(sourceVersionId).first<{n:number}>();expect(count?.n).toBe(1);
  expect((await SELF.fetch(`${path}/${sessionId}/batches`,{method:'POST',headers:f.headers,body:JSON.stringify({...body,blocks:[{...body.blocks[0],text:'伪改正文'}]})})).status).toBe(409);
  const done=await SELF.fetch(`${path}/${sessionId}/complete`,{method:'POST',headers:f.headers,body:JSON.stringify({totalPages:1})});expect(done.status).toBe(200);expect((await done.json() as {data:{textReady:boolean}}).data.textReady).toBe(true);
 });
 it('removes application file/page limits',async()=>{
  const response=await SELF.fetch(BASE+'/api/v1/capabilities');const data=(await response.json() as {data:{limits:{maxFileBytes:null;maxPdfPages:null}}}).data;expect(data.limits.maxFileBytes).toBeNull();expect(data.limits.maxPdfPages).toBeNull();
 });
});
