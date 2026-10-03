import { SELF } from 'cloudflare:test';
import { expect,it } from 'vitest';
import { env,BASE } from './helpers/env';
import { seedUser,authCookie } from './helpers/seed';
import { previewDraft,commitDraft } from '../src/services/creation-drafts';
import { newId } from '../src/core/db';
import type { Env } from '../src/env';

async function fixture() {
  const owner=await seedUser();const response=await SELF.fetch(`${BASE}/api/v1/creation-drafts`,{method:'POST',headers:{cookie:authCookie(owner.token),'content-type':'application/json','idempotency-key':newId()},body:JSON.stringify({name:'单设备创建验收'})});
  const draft=(await response.json() as {data:{id:string;revision:number}}).data;
  return {owner,...draft};
}
it('keeps a published preview ready when reading its response fails after the successful write',async()=>{
  const f=await fixture();let published=false,failed=false;
  const db=new Proxy(env.DB,{get(target,key){
    if(key==='prepare')return (sql:string)=>{if(sql.startsWith('UPDATE project_creation_drafts SET preview_json='))published=true;if(published&&!failed&&sql.startsWith('SELECT * FROM project_creation_drafts')){failed=true;throw new Error('response read failed');}return target.prepare(sql);};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  await expect(previewDraft({...env,DB:db} as Env,f.id,f.owner.userId,f.revision,'manual',[],true)).rejects.toThrow('response read failed');
  const row=await env.DB.prepare('SELECT preview_state,preview_revision,preview_json FROM project_creation_drafts WHERE id=?1').bind(f.id).first<{preview_state:string;preview_revision:number;preview_json:string}>();
  expect(row).toMatchObject({preview_state:'ready',preview_revision:f.revision});expect(row!.preview_json).toBeTruthy();
  expect((await commitDraft(env,f.id,f.owner.userId,f.revision)).projectId).toBeTruthy();
});
it('returns an actionable failed-preview reason and does not create a project',async()=>{
  const f=await fixture();await previewDraft(env,f.id,f.owner.userId,f.revision,'manual',[],true);
  await env.DB.prepare("UPDATE project_creation_drafts SET preview_state='failed' WHERE id=?1").bind(f.id).run();
  const r=await SELF.fetch(`${BASE}/api/v1/creation-drafts/${f.id}/commit`,{method:'POST',headers:{cookie:authCookie(f.owner.token),'content-type':'application/json'},body:JSON.stringify({expectedRevision:f.revision,confirmed:true})});
  expect(r.status).toBe(409);expect(await r.json()).toMatchObject({error:{code:'INVALID_STATE',message:expect.stringContaining('任务预览失败'),details:{reason:'PREVIEW_FAILED',previewState:'failed'}}});
  expect((await env.DB.prepare('SELECT count(*) n FROM projects WHERE created_by=?1').bind(f.owner.userId).first<{n:number}>())!.n).toBe(0);
});
it('rejects a stale reviewed preview identifier and an attempt replaced inside the commit transaction',async()=>{
  const f=await fixture();const ready=await previewDraft(env,f.id,f.owner.userId,f.revision,'manual',[],true);
  await expect(commitDraft(env,f.id,f.owner.userId,f.revision,newId())).rejects.toThrow('任务预览已被替换');
  let raced=false;const db=new Proxy(env.DB,{get(target,key){
    if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(!raced){raced=true;await target.prepare('UPDATE project_creation_drafts SET preview_attempt_id=?2 WHERE id=?1').bind(f.id,newId()).run();}return target.batch(statements);};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  await expect(commitDraft({...env,DB:db} as Env,f.id,f.owner.userId,f.revision,ready.previewAttemptId!)).rejects.toThrow('草稿已变化');
  expect((await env.DB.prepare('SELECT count(*) n FROM projects WHERE created_by=?1').bind(f.owner.userId).first<{n:number}>())!.n).toBe(0);
});
