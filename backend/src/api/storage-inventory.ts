import {createRoute,OpenAPIHono,z} from '@hono/zod-openapi';
import type {AppEnv} from '../env';
import {refreshExternalStorageUsage} from '../services/storage-external-usage';
import {apiData} from '../core/api';
import {apiEnvelope} from '../core/openapi';
import {invalidState,permissionDenied} from '../core/errors';
import {requireAdmin} from './admin';
import {rawStorage,storageOwner,resolveStorageWithEvidence} from '../services/managed-storage';
import {loadResourcePolicy,saveResourcePolicy} from '../services/resource-policy';
import {nowIso} from '../core/db';
const base='/api/v1/admin/storage-inventory';
const statusSchema=z.object({ready:z.boolean(),scanning:z.boolean(),hasMore:z.boolean(),externalCheckedAt:z.string().nullable(),objectCount:z.number(),accountedBytes:z.number(),reservedBytes:z.number()});
const responses={200:{description:'仅存储元数据与盘点进度，不返回对象内容或对象名称',content:{'application/json':{schema:apiEnvelope(statusSchema,'StorageInventoryResponse')}}}};
async function status(env:AppEnv['Bindings']){
 const s=await env.DB.prepare('SELECT ready,scanning,cursor,external_checked_at FROM storage_inventory_state WHERE id=1').first<{ready:number;scanning:number;cursor:string|null;external_checked_at:string|null}>();
 const counts=await env.DB.prepare('SELECT COUNT(*) objectCount,COALESCE(SUM(size_bytes),0) accountedBytes FROM storage_objects').first<{objectCount:number;accountedBytes:number}>();
 const held=await env.DB.prepare('SELECT COALESCE(SUM(bytes),0) bytes FROM storage_reservations').first<{bytes:number}>();
 return {ready:!!s?.ready,scanning:!!s?.scanning,hasMore:!!s?.cursor,externalCheckedAt:s?.external_checked_at??null,objectCount:counts?.objectCount??0,accountedBytes:counts?.accountedBytes??0,reservedBytes:held?.bytes??0};
}
export function registerStorageInventoryRoutes(app:OpenAPIHono<AppEnv>){
 app.use(base,requireAdmin,async(c,next)=>{if(c.get('user')&&c.get('user')!.role!=='super_admin')throw permissionDenied('需要超级管理员权限');c.header('Cache-Control','no-store');await next();});
 app.use(base+'/*',requireAdmin,async(c,next)=>{if(c.get('user')&&c.get('user')!.role!=='super_admin')throw permissionDenied('需要超级管理员权限');c.header('Cache-Control','no-store');await next();});
 app.openapi(createRoute({method:'get',path:base,tags:['admin'],responses}),async c=>c.json(apiData(c,await status(c.env)),200));
 app.openapi(createRoute({method:'post',path:base+'/reservations/{id}/resolve',tags:['admin'],request:{params:z.object({id:z.string().uuid()}),body:{required:true,content:{'application/json':{schema:z.object({providerConfirmedEnded:z.literal(true),reason:z.string().trim().min(10).max(1000)}).strict()}}}},responses:{200:{description:'已按实际对象核对并记录审计',content:{'application/json':{schema:apiEnvelope(z.object({resolved:z.literal(true)}),'StorageResolutionResponse')}}}}}),async c=>{
  const actor=c.get('user');if(actor?.role!=='super_admin')throw permissionDenied('必须由超级管理员账户核对');
  return c.json(apiData(c,await resolveStorageWithEvidence(c.env,c.req.valid('param').id,actor.id,c.req.valid('json').reason)),200);
 });
 app.openapi(createRoute({method:'post',path:base+'/external-usage',tags:['admin'],responses:{200:{description:'受控核查其他桶元数据；不自动启用新增存储',content:{'application/json':{schema:apiEnvelope(z.object({refreshed:z.boolean(),checkedAt:z.string().nullable(),externalBytes:z.number()}),'ExternalStorageUsageResponse')}}}}}),async c=>c.json(apiData(c,await refreshExternalStorageUsage(c.env,true)),200));
 app.openapi(createRoute({method:'post',path:base+'/start',tags:['admin'],request:{body:{required:true,content:{'application/json':{schema:z.object({expectedVersion:z.number().int().positive(),externalStorageBytes:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),verificationNote:z.string().trim().min(10).max(1000)}).strict()}}}},responses}),async c=>{
  const b=c.req.valid('json'),p=await loadResourcePolicy(c.env),{version:_,...fields}=p;
  if(await c.env.DB.prepare("SELECT 1 FROM storage_reservations WHERE kind IN('put','delete')").first())throw invalidState('仍有在途或结果未知的对象写入，先核对再开始盘点');
  await c.env.DB.prepare('UPDATE storage_inventory_state SET ready=0,scanning=0 WHERE id=1').run();
  await saveResourcePolicy(c.env,b.expectedVersion,{...fields,externalStorageBytes:b.externalStorageBytes},c.get('user')?.id??null);
  await c.env.DB.prepare('UPDATE storage_inventory_state SET ready=0,scanning=1,cursor=NULL,external_checked_at=?1,verification_note=?2,updated_at=?1 WHERE id=1').bind(nowIso(),b.verificationNote).run();
  return c.json(apiData(c,await status(c.env)),200);
 });
 app.openapi(createRoute({method:'post',path:base+'/continue',tags:['admin'],responses}),async c=>{
  const state=await c.env.DB.prepare('SELECT scanning,cursor FROM storage_inventory_state WHERE id=1').first<{scanning:number;cursor:string|null}>();
  if(!state?.scanning)throw invalidState('先开始存储盘点');
  const page=await rawStorage(c.env).list({limit:100,cursor:state.cursor??undefined});
  for(const object of page.objects){
   const owner=await storageOwner(c.env,object.key);
   await c.env.DB.prepare(`INSERT INTO storage_objects(object_key,size_bytes,user_id,project_id,category,etag,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7)
    ON CONFLICT(object_key) DO UPDATE SET user_id=excluded.user_id,project_id=excluded.project_id,category=excluded.category,size_bytes=excluded.size_bytes,etag=excluded.etag,updated_at=excluded.updated_at`).bind(object.key,object.size,owner.userId??null,owner.projectId??null,owner.category,object.etag,nowIso()).run();
  }
  if(!page.truncated){
   // Also include outstanding legacy sessions before any new multipart writes are permitted.
   await c.env.DB.prepare(`INSERT OR IGNORE INTO storage_reservations(id,object_key,bytes,user_id,project_id,category,kind,status,upload_id,expires_at,updated_at)
    SELECT 'inventory:'||s.id,s.r2_key,s.size_bytes,s.actor_id,s.project_id,'upload','multipart','reserved',s.upload_id,strftime('%Y-%m-%dT%H:%M:%fZ',s.updated_at,'+1 day'),s.updated_at FROM file_upload_sessions s
    WHERE s.status IN('uploading','completing','aborting') AND NOT EXISTS(SELECT 1 FROM storage_objects o WHERE o.object_key=s.r2_key)`).run();
   await c.env.DB.prepare(`INSERT OR IGNORE INTO storage_reservations(id,object_key,bytes,user_id,project_id,category,kind,status,upload_id,expires_at,updated_at)
    SELECT 'inventory:'||s.file_id,s.r2_key,s.size_bytes,d.owner_id,NULL,'upload','multipart','reserved',s.upload_id,?1,?2 FROM draft_document_uploads s JOIN project_creation_drafts d ON d.id=s.draft_id
    WHERE s.status IN('uploading','completing','aborting') AND NOT EXISTS(SELECT 1 FROM storage_objects o WHERE o.object_key=s.r2_key)`).bind(new Date(Date.now()+86400000).toISOString(),nowIso()).run();
  }
  await c.env.DB.prepare('UPDATE storage_inventory_state SET cursor=?1,ready=?2,scanning=?3,updated_at=?4 WHERE id=1 AND cursor IS ?5').bind(page.truncated?page.cursor:null,page.truncated?0:1,page.truncated?1:0,nowIso(),state.cursor).run();
  return c.json(apiData(c,await status(c.env)),200);
 });
}
