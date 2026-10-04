import { describe,it,expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { env,BASE } from './helpers/env';
import { seedUser,seedProject,authCookie } from './helpers/seed';

import { validateDocx } from '../src/services/docx-validation';
async function fixture(ext='.pdf') {
 const user=await seedUser(),project=await seedProject(user.userId),headers={cookie:authCookie(user.token),'content-type':'application/json'};
 const r=await SELF.fetch(`${BASE}/api/v1/projects/${project}/files`,{method:'POST',headers,body:JSON.stringify({fileName:'资料'+ext})});expect(r.status).toBe(201);
 const f=(await r.json() as {data:{fileId:string;upload:{url:string}}}).data;
 return {user,project,headers,file:f.fileId,url:f.upload.url};
}
describe('resumable document imports',()=>{
 it('validates DOCX package rather than ZIP magic',async()=>{
  const bytes=Uint8Array.from(atob('UEsDBAoAAAAAAMcJRF1Rl+gEFAEAABQBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDxUeXBlcyB4bWxucz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3BhY2thZ2UvMjAwNi9jb250ZW50LXR5cGVzIj48RGVmYXVsdCBFeHRlbnNpb249InhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3dvcmQvZG9jdW1lbnQueG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50LndvcmRwcm9jZXNzaW5nbWwuZG9jdW1lbnQubWFpbit4bWwiLz48L1R5cGVzPlBLAwQKAAAAAADHCURdAAAAAAAAAAAAAAAABQAAAHdvcmQvUEsDBAoAAAAAAMcJRF0X6uHulAEAAJQBAAARAAAAd29yZC9kb2N1bWVudC54bWw8dzpkb2N1bWVudCB4bWxuczp3PSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvd29yZHByb2Nlc3NpbmdtbC8yMDA2L21haW4iPjx3OmJvZHk+PHc6cD48dzpwUHI+PHc6cFN0eWxlIHc6dmFsPSJIZWFkaW5nMSIvPjwvdzpwUHI+PHc6cj48dzp0PkNoYXB0ZXI8L3c6dD48L3c6cj48L3c6cD48dzp0Ymw+PHc6dHI+PHc6dGM+PHc6cD48dzpyPjx3OnQ+TmFtZTwvdzp0PjwvdzpyPjwvdzpwPjwvdzp0Yz48dzp0Yz48dzpwPjx3OnI+PHc6dD5BbGljZTwvdzp0PjwvdzpyPjwvdzpwPjwvdzp0Yz48L3c6dHI+PC93OnRibD48dzpwPjx3OnI+PHc6dD4mbHQ7c2NyaXB0Jmd0O2xpdGVyYWwmbHQ7L3NjcmlwdCZndDs8L3c6dD48L3c6cj48dzpvTWF0aC8+PC93OnA+PC93OmJvZHk+PC93OmRvY3VtZW50PlBLAwQKAAAAAADHCURdJaYQaLIAAACyAAAADwAAAHdvcmQvc3R5bGVzLnhtbDx3OnN0eWxlcyB4bWxuczp3PSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvd29yZHByb2Nlc3NpbmdtbC8yMDA2L21haW4iPjx3OnN0eWxlIHc6dHlwZT0icGFyYWdyYXBoIiB3OnN0eWxlSWQ9IkhlYWRpbmcxIj48dzpuYW1lIHc6dmFsPSJIZWFkaW5nIDEiLz48L3c6c3R5bGU+PC93OnN0eWxlcz5QSwECFAAKAAAAAADHCURdUZfoBBQBAAAUAQAAEwAAAAAAAAAAAAAAAAAAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAAoAAAAAAMcJRF0AAAAAAAAAAAAAAAAFAAAAAAAAAAAAEAAAAEUBAAB3b3JkL1BLAQIUAAoAAAAAAMcJRF0X6uHulAEAAJQBAAARAAAAAAAAAAAAAAAAAGgBAAB3b3JkL2RvY3VtZW50LnhtbFBLAQIUAAoAAAAAAMcJRF0lphBosgAAALIAAAAPAAAAAAAAAAAAAAAAACsDAAB3b3JkL3N0eWxlcy54bWxQSwUGAAAAAAQABADwAAAACgQAAAAA'),c=>c.charCodeAt(0));
  expect(await validateDocx(bytes.length,async(o,n)=>bytes.slice(o,o+n))).toContain('wordprocessingml');
  await expect(validateDocx(24,async()=>new Uint8Array(24))).rejects.toThrow();
 });
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
