import {createApp} from '../src/app';
import {SELF} from 'cloudflare:test';
import {describe,it,expect} from 'vitest';
import {env,BASE} from './helpers/env';
import {seedUser,seedProject,authCookie} from './helpers/seed';
import {loadResourcePolicy} from '../src/services/resource-policy';
import {newId} from '../src/core/db';
const base=BASE+'/api/v1/admin/storage-inventory';
async function request(path:string,method='GET',body?:unknown){return SELF.fetch(base+path,{method,headers:{Authorization:'Bearer test-admin-token','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});}
describe('storage metadata inventory',()=>{
 it('imports existing originals and legacy pending multipart, without deleting objects',async()=>{
  const u=await seedUser(),project=await seedProject(u.userId),file=newId(),key=`${project}/${file}.txt`;
  await env.DB.prepare("INSERT INTO files(id,project_id,uploader_user_id,r2_key,ext,status,created_at) VALUES(?1,?2,?3,?4,'.txt','available',?5)").bind(file,project,u.userId,key,new Date().toISOString()).run();
  await env.FILES.put(key,'existing original');
  const p=await loadResourcePolicy(env);const start=await request('/start','POST',{expectedVersion:p.version,externalStorageBytes:12,verificationNote:'local fixture: all other buckets inspected'});expect(start.status).toBe(200);
  let result:Response;do{result=await request('/continue','POST');expect(result.status).toBe(200);}while((await result.clone().json() as {data:{scanning:boolean}}).data.scanning);
  expect((await result.json() as {data:{ready:boolean;accountedBytes:number}}).data.ready).toBe(true);
  expect(await (await env.FILES.get(key))!.text()).toBe('existing original');
  expect(await env.DB.prepare('SELECT size_bytes,user_id,project_id FROM storage_objects WHERE object_key=?1').bind(key).first()).toEqual({size_bytes:17,user_id:u.userId,project_id:project});
 });
 it('does not expose object names or allow ordinary users to manage inventory',async()=>{
  const user=await seedUser();const r=await SELF.fetch(base,{headers:{cookie:authCookie(user.token)}});expect(r.status).toBe(403);
  const admin=await request('');expect(admin.status).toBe(200);expect(await admin.text()).not.toContain('object_key');
 });
});

it('a delayed inventory ownership snapshot cannot remove the charge of a newly committed project',async()=>{
 const u=await seedUser(),project=newId(),draft=newId(),key=`creation-drafts/${draft}/${newId()}.txt`,time=new Date().toISOString();
 await env.DB.prepare('INSERT INTO project_creation_drafts(id,owner_id,payload_json,project_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)').bind(draft,u.userId,'{}',project,time).run();
 await env.FILES.put(key,'abc');
 await env.DB.prepare("INSERT INTO storage_objects(object_key,size_bytes,user_id,project_id,category,updated_at) VALUES(?1,3,?2,NULL,'upload',?3)").bind(key,u.userId,time).run();
 const policy=await loadResourcePolicy(env);expect((await request('/start','POST',{expectedVersion:policy.version,externalStorageBytes:0,verificationNote:'all fixture metadata inspected'})).status).toBe(200);
 let promoted=false;
 const db=new Proxy(env.DB,{get(target,property){if(property==='prepare')return (sql:string)=>{
  const stmt=target.prepare(sql);if(!sql.startsWith('SELECT owner_id user_id'))return stmt;
  return {bind:(...args:unknown[])=>{const bound=stmt.bind(...args);if(args[0]!==draft)return bound;
   return new Proxy(bound,{get(inner,name){if(name==='first')return async()=>{const snapshot=await inner.first();if(!promoted){promoted=true;await env.DB.batch([
    env.DB.prepare("INSERT INTO projects(id,name,description,status,revision,created_by,created_at,updated_at) VALUES(?1,'promoted','','active',1,?2,?3,?3)").bind(project,u.userId,time),
    env.DB.prepare("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES(?1,?2,?3,'owner',?4)").bind(newId(),project,u.userId,time),
    env.DB.prepare("UPDATE project_creation_drafts SET status='committed' WHERE id=?1").bind(draft),
    env.DB.prepare('UPDATE storage_objects SET project_id=?2 WHERE object_key=?1').bind(key,project),
   ]);}return snapshot;};const value=Reflect.get(inner,name,inner);return typeof value==='function'?value.bind(inner):value;}});
  }} as D1PreparedStatement;
 };const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}});
 const result=await createApp().request(base+'/continue',{method:'POST',headers:{Authorization:'Bearer test-admin-token'}},{...env,DB:db});
 expect(result.status).toBe(200);expect(promoted).toBe(true);
 expect(await env.DB.prepare('SELECT project_id FROM storage_objects WHERE object_key=?1').bind(key).first()).toEqual({project_id:project});
 expect(await env.DB.prepare("SELECT bytes FROM storage_counters WHERE scope='project' AND scope_id=?1").bind(project).first()).toEqual({bytes:3});
});
