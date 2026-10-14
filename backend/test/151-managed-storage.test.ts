import {describe,it,expect,vi,afterEach,beforeEach} from 'vitest';
import {env} from './helpers/env';
import {seedUser,seedProject} from './helpers/seed';
import {withManagedStorage,reserveStorage,reconcileStorage} from '../src/services/managed-storage';
import {loadResourcePolicy,saveResourcePolicy} from '../src/services/resource-policy';
import {newId} from '../src/core/db';
afterEach(()=>vi.restoreAllMocks());
beforeEach(async()=>{
 await env.DB.batch([env.DB.prepare('DELETE FROM storage_reservations'),env.DB.prepare('DELETE FROM storage_objects'),env.DB.prepare('UPDATE storage_inventory_state SET ready=0,external_checked_at=NULL WHERE id=1')]);
 const {version,...p}=await loadResourcePolicy(env);
 await saveResourcePolicy(env,version,{...p,userStorageBytes:250000000,projectStorageBytes:1000000000,platformStorageBytes:10000000000,uploadPoolBytes:8000000000,externalStorageBytes:0},null);
});
async function fixture(){
 const u=await seedUser(),projectId=await seedProject(u.userId);
 const base=withManagedStorage(env,{userId:u.userId,projectId,category:'upload'});
 return {base,userId:u.userId,projectId,key:`${projectId}/${newId()}.txt`};
}
async function limits(){const p=await loadResourcePolicy(env);await saveResourcePolicy(env,p.version,{...(({version:_,...v})=>v)(p),userStorageBytes:25,projectStorageBytes:60,platformStorageBytes:100,uploadPoolBytes:80,externalStorageBytes:0},null);}
const used=async()=>Number((await env.DB.prepare("SELECT bytes FROM storage_counters WHERE scope='platform' AND scope_id='all'").first<{bytes:number}>())?.bytes??0);
describe('physical storage admission and accounting',()=>{
 it('enforces aggregate user space, retains originals, and releases only after delete',async()=>{
  await limits();const f=await fixture();await f.base.FILES.put(f.key,'1234567890');
  await expect(f.base.FILES.put(f.key+'2','01234567890123456789')).rejects.toMatchObject({code:'QUOTA_EXCEEDED'});
  expect(await (await env.FILES.get(f.key))!.text()).toBe('1234567890');expect(await used()).toBe(10);
  await f.base.FILES.delete(f.key);expect(await used()).toBe(0);
  await f.base.FILES.put(f.key+'2','01234567890123456789');expect(await used()).toBe(20);
 });
 it('accounts overwrite and conditional no-op without double charging',async()=>{
  const f=await fixture();await f.base.FILES.put(f.key,'old');await f.base.FILES.put(f.key,'new data');expect(await used()).toBe(8);
  expect(await f.base.FILES.put(f.key,'ignored',{onlyIf:{etagDoesNotMatch:'*'}})).toBeNull();expect(await used()).toBe(8);
  await f.base.FILES.delete(f.key);expect(await used()).toBe(0);
 });
 it('admits only one of concurrent requests for remaining platform bytes',async()=>{
  await limits();const a=await fixture(),b=await fixture();
  const p=await loadResourcePolicy(env);await saveResourcePolicy(env,p.version,{...(({version:_,...v})=>v)(p),userStorageBytes:60,projectStorageBytes:60},null);
  const outcomes=await Promise.allSettled([a.base.FILES.put(a.key,'x'.repeat(50)),b.base.FILES.put(b.key,'y'.repeat(50))]);
  expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await used()).toBe(50);
 });
 it('reserves full multipart length, blocks concurrent delete and refunds abort',async()=>{
  const f=await fixture();await reserveStorage(env,f.key,10,'multipart',{userId:f.userId,projectId:f.projectId,category:'upload'});
  const upload=await f.base.FILES.createMultipartUpload(f.key);expect(await used()).toBe(10);
  await expect(f.base.FILES.delete(f.key)).rejects.toMatchObject({code:'INVALID_STATE'});
  await upload.uploadPart(1,new TextEncoder().encode('1234567890'));await upload.abort();expect(await used()).toBe(0);
 });
 it('settles completed multipart exactly once',async()=>{
  const f=await fixture();await reserveStorage(env,f.key,10,'multipart',{userId:f.userId,projectId:f.projectId,category:'upload'});
  const upload=await f.base.FILES.createMultipartUpload(f.key),part=await upload.uploadPart(1,new TextEncoder().encode('1234567890'));
  await upload.complete([part]);expect(await used()).toBe(10);
  expect(await env.DB.prepare('SELECT id FROM storage_reservations WHERE object_key=?1').bind(f.key).first()).toBeNull();
  await f.base.FILES.delete(f.key);expect(await used()).toBe(0);
 });
 it('fails closed when inventory or external usage is unverified',async()=>{
  const f=await fixture(),production=withManagedStorage({...env,ENV_NAME:'production'});
  await expect(production.FILES.put(f.key,'x')).rejects.toMatchObject({details:{storageInventoryRequired:true}});
  await env.DB.prepare("UPDATE storage_inventory_state SET ready=1,external_checked_at='2020-01-01T00:00:00Z' WHERE id=1").run();
  await expect(production.FILES.put(f.key,'x')).rejects.toMatchObject({details:{storageInventoryRequired:true}});
 });
 it('retains ambiguous writes and settles only verified claim metadata',async()=>{
  const f=await fixture(),rawPut=env.FILES.put.bind(env.FILES);
  const failing={...env.FILES,put:async(key:string,value:string,options?:R2PutOptions)=>{await rawPut(key,value,options);throw Error('response lost');}} as unknown as R2Bucket;
  const managed=withManagedStorage({...env,FILES:failing},{userId:f.userId,projectId:f.projectId,category:'upload'});
  await expect(managed.FILES.put(f.key,'hello')).rejects.toThrow('response lost');expect(await used()).toBe(5);
  expect(await env.DB.prepare('SELECT status FROM storage_reservations WHERE object_key=?1').bind(f.key).first()).toEqual({status:'uncertain'});
  await reconcileStorage(env);expect(await used()).toBe(5);expect(await env.DB.prepare('SELECT id FROM storage_reservations WHERE object_key=?1').bind(f.key).first()).toBeNull();
 });
});
