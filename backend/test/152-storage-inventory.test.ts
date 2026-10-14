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
