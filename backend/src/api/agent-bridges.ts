import { consumePasswordRateLimit } from '../services/accounts';
import { submissionSchema } from './collaboration';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { requireUser, loadSessionUser, parseCookies, SESSION_COOKIE } from '../core/auth';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { nowIso } from '../core/db';
import { invalidState, notFound, permissionDenied, unauthenticated } from '../core/errors';
import { readBoundedUpload } from '../services/files';
import { adoptBridgeResult } from '../services/agent-bridge-adoption';
import { bridgeScopeOptions, updateBridgeScopes, acknowledgeBridgeCancellation, revokeBridgeDevice, approveBridgePairing, bridgeArtifactInit, bridgeDeviceDto, bridgeDto, bridgeInput, bridgeMember, bridgeSnapshot, browserBridgeHandoff, cancelBridgeHandoff, claimBridgeHandoff, completeBridgeHandoff, createBridgeHandoff, createBridgePairing, deviceBridgeHandoff, loadBridgeDevice, readBridgePairing, recordBridgeEvent, refreshBridgeHandoff, requireBridgeDeviceScope, storeBridgeArtifact, type DeviceRow, type HandoffRow } from '../services/agent-bridges';

const base='/api/v1/agent-bridges',uuid=z.string().uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/),version=z.string().trim().min(1).max(80);
const artifact=z.object({artifactId:uuid,fileId:uuid,name:z.string(),sizeBytes:z.number(),sha256:hash});
export const bridgeHandoffSchema=z.object({handoffId:uuid,projectId:uuid,taskId:uuid,taskRevision:z.number().int(),deviceId:uuid,state:z.enum(['checking','waiting_device','claimed','running','waiting_input','uploading','ready_for_review','blocked','failed','cancel_requested','cancelled','dispatch_uncertain']),reason:z.string().nullable(),snapshotHash:hash.nullable(),sessionId:z.string().nullable(),result:z.object({summary:z.string(),artifacts:z.array(artifact)}).nullable(),stale:z.boolean(),adoptedSubmissionId:uuid.nullable(),createdAt:z.string(),updatedAt:z.string()});
const deviceSchema=z.object({paired:z.boolean(),deviceId:uuid,deviceName:z.string(),bridgeVersion:z.string(),dshVersion:z.string(),projects:z.array(z.object({projectId:uuid,name:z.string(),workspaceLabel:z.string().nullable()})),revoked:z.boolean(),lastSeenAt:z.string().nullable(),protocolVersion:z.literal(1)});
type C=Context<AppEnv>;
/** All routes retain the app's envelope and generated OpenAPI contract. */
export function registerAgentBridgeRoutes(app:OpenAPIHono<AppEnv>){
 app.use(`${base}/*`,async(c,next)=>{c.header('Cache-Control','no-store');await next();});
 const browser=async(c:C)=>{const u=c.get('user') ?? await loadSessionUser(c.env,parseCookies(c.req.header('cookie'))[SESSION_COOKIE]);if(!u)throw unauthenticated();return u.id;};
 const device=(c:C)=>loadBridgeDevice(c.env,c.req.header('authorization'));
 const runBrowser=async(c:C)=>browserBridgeHandoff(c.env,c.req.param('handoffId')!,await browser(c));
 const runDevice=async(c:C)=>deviceBridgeHandoff(c.env,c.req.param('handoffId')!,await device(c));
 function route(method:'get'|'post'|'delete',suffix:string,body:z.ZodType|undefined,response:z.ZodType,handler:(c:C)=>Promise<unknown>,auth:'browser'|'device'|'anonymous'='browser',status:200|202=200){
  const path=base+suffix,paramNames=[...suffix.matchAll(/\{(\w+)\}/g)].map(m=>m[1]!);
  const params=z.object(Object.fromEntries(paramNames.map(n=>[n,uuid])));
  if(auth==='browser')app.use(path.replace(/\{(\w+)\}/g,':$1'),requireUser);
  app.openapi(createRoute({method,path,tags:['agent-bridges'],summary:`DSH bridge ${method} ${suffix}`,request:{params,...(body?{body:{required:true,content:{'application/json':{schema:body}}}}:{})},responses:{200:{description:'Success',content:{'application/json':{schema:apiEnvelope(response,'AgentBridge'+method+suffix.replace(/[^a-zA-Z]/g,''))}}},202:{description:'Accepted',content:{'application/json':{schema:apiEnvelope(response,'AgentBridge'+method+suffix.replace(/[^a-zA-Z]/g,''))}}}}}),async c=>c.json(apiData(c,await handler(c)),status));
 }
 route('post','/pairings',z.object({credentialHash:hash,deviceName:z.string().trim().min(1).max(100),bridgeVersion:version,dshVersion:version}).strict(),z.object({pairingId:uuid,approvalUrl:z.string(),expiresAt:z.string()}),async c=>{
  await consumePasswordRateLimit(c.env,'agent-bridge-pair-ip',c.req.header('cf-connecting-ip')??'unknown',20,600);const origin=c.env.ALLOWED_ORIGINS.split(',').map(s=>s.trim()).find(s=>s.startsWith('https://')) ?? new URL(c.req.url).origin;return createBridgePairing(c.env,await c.req.json(),origin);
 },'anonymous');
 route('get','/pairings/{pairingId}',undefined,z.object({pairingId:uuid,deviceName:z.string(),expiresAt:z.string(),status:z.enum(['pending','approved','expired']),projects:z.array(z.object({projectId:uuid,name:z.string()}))}),async c=>{
  const userId=await browser(c),p=await readBridgePairing(c.env,c.req.param('pairingId')!,userId);const projects=(await c.env.DB.prepare('SELECT p.id projectId,p.name FROM projects p JOIN project_members m ON m.project_id=p.id WHERE m.user_id=?1 ORDER BY p.name,p.id').bind(userId).all()).results;return{...p,status:p.paired?'approved':p.expiresAt<=nowIso()?'expired':'pending',projects};
 });
 route('post','/pairings/{pairingId}/approve',z.object({projectIds:z.array(uuid).min(1).max(100)}).strict(),deviceSchema,async c=>approveBridgePairing(c.env,c.req.param('pairingId')!,await browser(c),(await c.req.json<{projectIds:string[]}>()).projectIds));
 route('get','/device',undefined,deviceSchema,async c=>{const d=await device(c);if(!d.owner_id&&d.pairing_expires_at<=nowIso())throw invalidState('配对已过期，请重新连接');return bridgeDeviceDto(c.env,d);},'device');
 route('get','/devices',undefined,z.object({items:z.array(deviceSchema)}),async c=>{const rows=(await c.env.DB.prepare('SELECT * FROM agent_bridge_devices WHERE owner_id=?1 ORDER BY created_at,id').bind(await browser(c)).all<DeviceRow>()).results;return{items:await Promise.all(rows.map(d=>bridgeDeviceDto(c.env,d)))};});
 route('get','/devices/{deviceId}/projects',undefined,z.object({items:z.array(z.object({projectId:uuid,name:z.string(),authorized:z.boolean()}))}),async c=>bridgeScopeOptions(c.env,c.req.param('deviceId')!,await browser(c)));
 route('post','/devices/{deviceId}/projects',z.object({projectIds:z.array(uuid).max(100)}).strict(),deviceSchema,async c=>updateBridgeScopes(c.env,c.req.param('deviceId')!,await browser(c),(await c.req.json<{projectIds:string[]}>()).projectIds));
 route('delete','/devices/{deviceId}',undefined,z.object({revoked:z.literal(true)}),async c=>revokeBridgeDevice(c.env,c.req.param('deviceId')!,await browser(c)));
 route('post','/device/disconnect',z.object({}).strict(),z.object({revoked:z.literal(true)}),async c=>{const d=await device(c);return revokeBridgeDevice(c.env,d.id,d.owner_id);},'device');
 route('post','/device/workspaces',z.object({projectId:uuid,workspaceLabel:z.string().trim().min(1).max(100).refine(v=>!/[\\/:\u0000-\u001f]/.test(v),'仅传目录显示名称，不接受本地路径')}).strict(),deviceSchema,async c=>{const d=await device(c),b=await c.req.json<{projectId:string;workspaceLabel:string}>();await requireBridgeDeviceScope(c.env,d,b.projectId);await c.env.DB.prepare('UPDATE agent_bridge_scopes SET workspace_label=?3 WHERE device_id=?1 AND project_id=?2').bind(d.id,b.projectId,b.workspaceLabel).run();return bridgeDeviceDto(c.env,d);},'device');
 route('post','/device/heartbeat',z.object({}).strict(),z.object({ok:z.literal(true)}),async c=>{const d=await device(c);if(!d.owner_id||d.revoked_at)throw permissionDenied();await c.env.DB.prepare('UPDATE agent_bridge_devices SET last_seen_at=?2 WHERE id=?1 AND revoked_at IS NULL').bind(d.id,nowIso()).run();return{ok:true};},'device');
 const taskPath='/projects/{projectId}/tasks/{taskId}/handoffs';
 route('post',taskPath,z.object({expectedRevision:z.number().int().positive(),targetDeviceId:uuid}).strict(),bridgeHandoffSchema,async c=>createBridgeHandoff(c.env,c.req.param('projectId')!,c.req.param('taskId')!,await browser(c),await c.req.json(),c.req.header('idempotency-key')),'browser',202);
 route('get',taskPath,undefined,z.object({items:z.array(bridgeHandoffSchema)}),async c=>{const userId=await browser(c),projectId=c.req.param('projectId')!,taskId=c.req.param('taskId')!;await bridgeMember(c.env,projectId,userId);const rows=(await c.env.DB.prepare('SELECT * FROM agent_bridge_handoffs WHERE project_id=?1 AND task_id=?2 AND requested_by=?3 ORDER BY created_at DESC LIMIT 50').bind(projectId,taskId,userId).all<HandoffRow>()).results;return{items:await Promise.all(rows.map(async r=>bridgeDto(await refreshBridgeHandoff(c.env,r))))};});
 route('get','/handoffs/{handoffId}',undefined,bridgeHandoffSchema,async c=>{
  const r=c.req.header('authorization')?await runDevice(c):await runBrowser(c);return bridgeDto(await refreshBridgeHandoff(c.env,r));
 },'anonymous');
 route('post','/handoffs/{handoffId}/cancel',z.object({}).strict(),bridgeHandoffSchema,async c=>cancelBridgeHandoff(c.env,await runBrowser(c)));
 route('post','/handoffs/{handoffId}/adopt-and-submit',z.object({expectedTaskRevision:z.number().int().positive(),reviewed:z.literal(true)}).strict(),submissionSchema,async c=>{const b=await c.req.json<{expectedTaskRevision:number}>();return adoptBridgeResult(c.env,await runBrowser(c),await browser(c),b.expectedTaskRevision);});
 route('post','/device/claim',z.object({}).strict(),z.object({handoff:bridgeHandoffSchema.nullable()}),async c=>({handoff:await claimBridgeHandoff(c.env,await device(c))}),'device');
 route('post','/handoffs/{handoffId}/events',z.object({sequence:z.number().int().positive(),type:z.enum(['session_created','prompt_accepted','running','waiting_input','uploading','failed','cancelled','dispatch_uncertain']),sessionId:z.string().trim().min(1).max(200).optional(),message:z.string().max(1000).optional()}).strict(),z.union([bridgeHandoffSchema,z.object({acknowledged:z.literal(true),state:z.literal('cancelled')})]),async c=>{const event=await c.req.json();if(event.type==='cancelled')return acknowledgeBridgeCancellation(c.env,c.req.param('handoffId')!,await device(c),event);return recordBridgeEvent(c.env,await runDevice(c),event);},'device');
 route('post','/handoffs/{handoffId}/heartbeat',z.object({}).strict(),z.object({cancelRequested:z.boolean()}),async c=>{const r=await runDevice(c);await c.env.DB.prepare('UPDATE agent_bridge_devices SET last_seen_at=?2 WHERE id=?1').bind(r.device_id,nowIso()).run();return{cancelRequested:r.state==='cancel_requested'};},'device');
 route('get','/handoffs/{handoffId}/snapshot',undefined,z.object({prompt:z.string(),inputs:z.array(z.object({path:z.string(),text:z.string()})),files:z.array(z.object({fileId:uuid,name:z.string(),contentPath:z.string(),sizeBytes:z.number(),sha256:hash.nullable(),lifecycleVersion:z.number()})),artifactPolicy:z.object({maxFileBytes:z.number(),maxArtifacts:z.number(),extensions:z.array(z.string())}),snapshotHash:hash}),async c=>bridgeSnapshot(c.env,await runDevice(c)),'device');
 route('post','/handoffs/{handoffId}/artifacts',z.object({artifactId:uuid,name:z.string().min(1).max(200),sizeBytes:z.number().int().positive().max(50*1024*1024),sha256:hash,contentType:z.string().max(150).optional()}).strict(),z.object({artifactId:uuid,fileId:uuid,uploadPath:z.string(),stored:z.boolean()}),async c=>bridgeArtifactInit(c.env,await runDevice(c),await c.req.json()),'device');
 route('post','/handoffs/{handoffId}/complete',z.object({summary:z.string().trim().min(1).max(30000),artifactIds:z.array(uuid).max(20),sessionId:z.string().min(1).max(200)}).strict(),bridgeHandoffSchema,async c=>completeBridgeHandoff(c.env,await runDevice(c),await c.req.json()),'device');
 const params=z.object({handoffId:uuid,fileId:uuid});
 app.openapi(createRoute({method:'get',path:base+'/handoffs/{handoffId}/inputs/{fileId}',tags:['agent-bridges'],summary:'Download authorized fixed input',request:{params},responses:{200:{description:'File',content:{'application/octet-stream':{schema:z.string()}}}}}),async c=>{const r=await runDevice(c),file=await bridgeInput(c.env,r,c.req.valid('param').fileId);return new Response(file.body,{status:file.status,headers:{...file.headers,'content-type':file.mime,'cache-control':'no-store'}});});
 app.openapi(createRoute({method:'put',path:base+'/handoffs/{handoffId}/artifacts/{artifactId}/content',tags:['agent-bridges'],summary:'Store validated bridge artifact without automatic parsing',request:{params:z.object({handoffId:uuid,artifactId:uuid})},responses:{200:{description:'Stored',content:{'application/json':{schema:apiEnvelope(z.object({stored:z.boolean(),fileId:uuid}),'AgentBridgeStoredResponse')}}}}}),async c=>{const r=await runDevice(c),bytes=await readBoundedUpload(c.req.raw.body,50*1024*1024);return c.json(apiData(c,await storeBridgeArtifact(c.env,r,c.req.valid('param').artifactId,bytes)),200);});
}
