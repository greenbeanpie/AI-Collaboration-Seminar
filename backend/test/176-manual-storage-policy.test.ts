import {describe,it,expect} from 'vitest';
import {SELF} from 'cloudflare:test';
import {env,BASE} from './helpers/env';
import {loadResourcePolicy,saveResourcePolicy} from '../src/services/resource-policy';
import {reserveStorage} from '../src/services/managed-storage';
import {newId} from '../src/core/db';

describe('9 GB manual-only storage policy',()=>{
 it('migrates the total and upload ceilings and refuses raising them',async()=>{
  const {version,...policy}=await loadResourcePolicy(env);
  expect(policy.platformStorageBytes).toBe(9000000000);
  expect(policy.uploadPoolBytes).toBe(7200000000);
  await expect(saveResourcePolicy(env,version,{...policy,platformStorageBytes:9000000001},null)).rejects.toThrow();
  await expect(saveResourcePolicy(env,version,{...policy,uploadPoolBytes:7200000001},null)).rejects.toThrow();
 });
 it('admits the last accounted byte and rejects growth beyond 9 GB minus other buckets',async()=>{
  const {version,...policy}=await loadResourcePolicy(env);
  await saveResourcePolicy(env,version,{...policy,externalStorageBytes:12},null);
  await env.DB.prepare("INSERT INTO storage_objects(object_key,size_bytes,category,updated_at) VALUES(?1,8999999987,'system',?2)").bind(newId(),new Date().toISOString()).run();
  await reserveStorage(env,newId(),1,'put',{category:'system'});
  await expect(reserveStorage(env,newId(),1,'put',{category:'system'})).rejects.toMatchObject({code:'QUOTA_EXCEEDED'});
 });
 it('keeps expiry protection even though automatic token queries are removed',async()=>{
  await env.DB.prepare("UPDATE storage_inventory_state SET ready=1,external_checked_at='2020-01-01T00:00:00Z' WHERE id=1").run();
  await expect(reserveStorage({...env,ENV_NAME:'production'},newId(),1,'put',{category:'system'})).rejects.toMatchObject({details:{storageInventoryRequired:true}});
 });
 it('removes the automatic-query endpoint from the HTTP router',async()=>{
  const response=await SELF.fetch(BASE+'/api/v1/admin/storage-inventory/external-usage',{method:'POST',headers:{authorization:'Bearer '+env.ADMIN_TOKEN}});
  expect(response.status).toBe(404);
 });
});
