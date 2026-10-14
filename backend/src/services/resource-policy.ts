import {z} from 'zod';
import type {Env} from '../env';
import {newId,nowIso} from '../core/db';
import {versionConflict,validationFailed} from '../core/errors';

export const resourcePolicyFields=z.object({
  aiEnabled:z.boolean(), userDailyCalls:z.number().int().min(1).max(100000),
  projectDailyCalls:z.number().int().min(1).max(100000), platformDailyCalls:z.number().int().min(1).max(1000000),
  globalConcurrency:z.number().int().min(1).max(100), userStorageBytes:z.number().int().min(1).max(9000000000),
  projectStorageBytes:z.number().int().min(1).max(9000000000), platformStorageBytes:z.number().int().min(1).max(9000000000),
  uploadPoolBytes:z.number().int().min(0).max(7200000000),
}).strict();
export const resourcePolicySchema=resourcePolicyFields.extend({version:z.number().int().positive()});
export type ResourcePolicy=z.infer<typeof resourcePolicySchema>;
export async function loadResourcePolicy(env:Pick<Env,'DB'>):Promise<ResourcePolicy>{
  const row=await env.DB.prepare('SELECT version,policy_json FROM resource_policy WHERE id=1').first<{version:number;policy_json:string}>();
  if(!row)throw validationFailed('资源策略尚未初始化');
  return resourcePolicySchema.parse({...JSON.parse(row.policy_json),version:row.version});
}
export async function saveResourcePolicy(env:Pick<Env,'DB'>,expectedVersion:number,policy:z.infer<typeof resourcePolicyFields>,actorId:string|null){
  const next=resourcePolicyFields.parse(policy);
  if(next.uploadPoolBytes>next.platformStorageBytes||next.userStorageBytes>next.projectStorageBytes||next.projectStorageBytes>next.platformStorageBytes)throw validationFailed('存储额度应满足用户≤项目≤平台，上传池≤平台');
  const json=JSON.stringify(next),now=nowIso();
  const results=await env.DB.batch([
    env.DB.prepare('UPDATE resource_policy SET version=version+1,policy_json=?2,updated_at=?3 WHERE id=1 AND version=?1').bind(expectedVersion,json,now),
    env.DB.prepare('INSERT INTO resource_policy_audit SELECT ?1,?2,version,policy_json,?3 FROM resource_policy WHERE id=1 AND changes()=1').bind(newId(),actorId,now),
  ]);
  if(!results[0]?.meta.changes)throw versionConflict((await loadResourcePolicy(env)).version);
  return loadResourcePolicy(env);
}
