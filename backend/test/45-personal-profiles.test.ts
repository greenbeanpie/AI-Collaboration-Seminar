import { SELF } from 'cloudflare:test';
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { seedUser, seedProject, authCookie } from './helpers/seed';
import { profileStamp } from '../src/services/personal-profiles';
import { generateAssignmentSuggestions, type AssignmentSuggestionInput } from '../src/services/assignment';
import { loadAiConfig } from '../src/ai/config';
import { configureGoFixture } from './helpers/provider-config';
import { applyProposal } from '../src/services/collaboration';

const blank = { searchable:false,bio:'private-bio-needle',major:'private-major-needle',specialties:'private-specialties-needle',preferredRoles:'private-role-needle',visibility:{bio:false,major:false,specialties:false,preferredRoles:false},expectedRevision:0 };
const ownPath='/api/v1/auth/personal-profile';
function get(path:string, token?:string) { return SELF.fetch(BASE+path,{headers:token?{cookie:authCookie(token)}:{}}); }
function save(token:string, body:unknown, header=true) {return SELF.fetch(BASE+ownPath,{method:'PUT',headers:{cookie:authCookie(token),'content-type':'application/json',...(header?{'X-Account-Settings':'1'}:{})},body:JSON.stringify(body)});}
async function user(name:string) {const u=await seedUser();await env.DB.prepare('UPDATE auth_accounts SET username=?2,username_norm=?2 WHERE user_id=?1').bind(u.userId,name).run();return u;}
afterEach(()=>vi.unstubAllGlobals());
beforeEach(async()=>{await env.DB.prepare("UPDATE auth_accounts SET username_norm=user_id WHERE username_norm IN ('alice','bob','outside')").run();});
describe('private profiles and exact account search',()=>{
 it.each(['user','admin','super_admin'] as const)('%s has no privileged read of another account private fields',async(role)=>{
  const owner=await user('alice');const viewer=await user('bob');
  await env.DB.prepare('UPDATE auth_accounts SET account_role=?2,is_admin=?3 WHERE user_id=?1').bind(viewer.userId,role,role==='user'?0:1).run();
  expect((await save(owner.token,{...blank,searchable:true,visibility:{...blank.visibility,bio:true}})).status).toBe(200);
  const publicRes=await get('/api/v1/profiles/alice',viewer.token);
  expect(publicRes.headers.get('cache-control')).toBe('no-store');
  const visible=await publicRes.json() as any;
  expect(visible.data.profile).toEqual({username:'alice',displayName:'测试用户',bio:blank.bio});
  for(const needle of [blank.major,blank.specialties,blank.preferredRoles])expect(JSON.stringify(visible)).not.toContain(needle);
  const found=await (await get('/api/v1/profiles/search?username=alice',viewer.token)).json() as any;
  expect(found.data.items).toEqual([{username:'alice',displayName:'测试用户'}]);
  expect((await (await get(ownPath,viewer.token)).json() as any).data.bio).toBe('');
  expect((await save(viewer.token,{...blank,userId:owner.userId})).status).toBe(400);
 });
 it('requires authentication, defaults private, does not expose old account data',async()=>{
  expect((await get(ownPath)).status).toBe(401);expect((await get('/api/v1/profiles/search?username=alice')).status).toBe(401);
  const a=await user('alice');const b=await user('bob');
  const initial=await get(ownPath,a.token);expect(initial.headers.get('cache-control')).toBe('no-store');expect((await initial.json() as any).data).toMatchObject({revision:0,searchable:false,visibility:{bio:false}});
  expect((await (await get('/api/v1/profiles/alice',b.token)).json() as any).data).toEqual({profile:null});
  expect((await (await get('/api/v1/profiles/search?username=alice',b.token)).json() as any).data.items).toEqual([]);
 });
 it('only explicitly public fields, immediate disable, owner-only saves and optimistic conflict',async()=>{
  const a=await user('alice');const b=await user('bob');
  expect((await save(a.token,blank,false)).status).toBe(403);
  expect((await save(a.token,{...blank,userId:b.userId})).status).toBe(400);
  expect((await save(a.token,{...blank,searchable:true,visibility:{...blank.visibility,bio:true}})).status).toBe(200);
  expect((await save(a.token,blank)).status).toBe(409);
  const publicRes=await get('/api/v1/profiles/alice',b.token);expect(publicRes.headers.get('cache-control')).toBe('no-store');
  const pub=await publicRes.json() as any;expect(pub.data.profile).toEqual({username:'alice',displayName:'测试用户',bio:blank.bio});
  const search=await (await get('/api/v1/profiles/search?username=ALICE',b.token)).json() as any;expect(search.data.items).toHaveLength(1);expect(Object.keys(search.data.items[0]).sort()).toEqual(['displayName','username']);
  expect((await (await get('/api/v1/profiles/search?username=ali',b.token)).json() as any).data.items).toEqual([]);
  expect((await get('/api/v1/profiles/search?username=alice&page=2',b.token)).status).toBe(400);
  expect((await get('/api/v1/profiles/search?username=%25',b.token)).status).toBe(400);
  expect((await save(a.token,{...blank,expectedRevision:1})).status).toBe(200);
  const hidden=await (await get('/api/v1/profiles/alice',b.token)).json() as any;const missing=await (await get('/api/v1/profiles/nobody',b.token)).json() as any;expect(hidden.data).toEqual(missing.data);
  expect((await (await get(ownPath,b.token)).json() as any).data.bio).toBe('');
 });
 it('rate limits authenticated enumeration',async()=>{const a=await user('alice');for(let i=0;i<30;i++)expect((await get('/api/v1/profiles/search?username=none',a.token)).status).toBe(200);expect((await get('/api/v1/profiles/search?username=none',a.token)).status).toBe(429);});
});

async function assignmentFixture() {
 await configureGoFixture();const a=await user('alice');const outside=await user('outside');const projectId=await seedProject(a.userId);
 await save(a.token,blank);await save(outside.token,{...blank,bio:'OUTSIDE-SECRET'});
 const taskId=crypto.randomUUID(); const config=(await loadAiConfig(env.DB))!;
 const input:AssignmentSuggestionInput={projectId,requestedBy:a.userId,profileStamp:await profileStamp(env,projectId),requirementSetId:null,requirements:[],tasks:[{taskId,title:'Task',detail:'Work',dueDate:null,duePrecision:'unknown',status:'todo',assigneeId:null,revision:1}],members:[{userId:a.userId,displayName:'A',skills:[],hoursPerWeek:1}]};
 return {a,outside,projectId,taskId,config,input};
}
describe('private profile AI boundary',()=>{
 it('uses the unified frozen model while retaining private request and output protections',async()=>{
  const f=await assignmentFixture();
  const merged={...f.config.config,routingMode:'unified',unified:{...f.config.config.textEconomy,model:'single-private-model',apiProtocol:'chat-completions',pricePerMTokens:[1,2]}};
  await env.DB.prepare('UPDATE ai_config_versions SET config_json=?2 WHERE id=?1').bind(f.config.id,JSON.stringify(merged)).run();
  const resolved=(await loadAiConfig(env.DB,f.config.id))!;
  expect(resolved.config.textEconomy).toBe(resolved.config.unified);
  expect((await loadAiConfig(env.DB,f.config.id,false))!.config.textEconomy.model).toBe('glm-5.2');
  const fetch=vi.fn(async(_url,init)=>{
   const body=JSON.parse(String(init?.body));expect(body.model).toBe('single-private-model');
   expect(String(init?.body)).toContain(blank.bio);expect(String(init?.body)).not.toContain('OUTSIDE-SECRET');
   expect(new Headers(init?.headers).get('cf-aig-skip-cache')).toBe('true');
   expect(new Headers(init?.headers).get('cf-aig-collect-log')).toBe('false');
   return Response.json({choices:[{message:{content:JSON.stringify({assignments:[{taskId:f.taskId,assigneeId:f.a.userId,reason:blank.bio}],considerations:[blank.major]})}}]});
  });
  vi.stubGlobal('fetch',fetch);
  const result=await generateAssignmentSuggestions(env,undefined as unknown as string,{...f.input,configVersionId:f.config.id},resolved);
  expect(fetch).toHaveBeenCalledTimes(1);expect(JSON.stringify(result)).not.toContain('private-');
  const calls=await env.DB.prepare('SELECT input_r2_key,output_r2_key FROM ai_calls WHERE project_id=?1').bind(f.projectId).all<{input_r2_key:string;output_r2_key:string}>();
  expect(calls.results).toHaveLength(1);
  for(const row of calls.results)for(const key of [row.input_r2_key,row.output_r2_key])expect(await (await env.FILES.get(key))!.text()).toBe('{"redacted":true}');
 });
 it('uses only current project profiles, redacts input/output snapshots, templates all external text',async()=>{
  const f=await assignmentFixture();let captured='';
  vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{captured=String(init?.body);expect(new Headers(init?.headers).get('cf-aig-skip-cache')).toBe('true');expect(new Headers(init?.headers).get('cf-aig-collect-log')).toBe('false');return Response.json({choices:[{message:{content:JSON.stringify({assignments:[{taskId:f.taskId,assigneeId:f.a.userId,reason:blank.bio}],considerations:[blank.major]})}}]});}));
  const result=await generateAssignmentSuggestions(env,undefined as unknown as string,f.input,f.config);
  expect(captured).toContain(blank.bio);expect(captured).not.toContain('OUTSIDE-SECRET');expect(JSON.stringify(result)).not.toContain('private-');
  const calls=await env.DB.prepare('SELECT input_r2_key,output_r2_key FROM ai_calls WHERE project_id=?1').bind(f.projectId).all<{input_r2_key:string;output_r2_key:string}>();expect(calls.results).toHaveLength(1);
  for(const row of calls.results)for(const key of [row.input_r2_key,row.output_r2_key])expect(await (await env.FILES.get(key))!.text()).toBe('{"redacted":true}');
 });
 it('rejects old jobs and profile changes before any model request',async()=>{const f=await assignmentFixture();const fetch=vi.fn();vi.stubGlobal('fetch',fetch);await expect(generateAssignmentSuggestions(env,'unused',{...f.input,profileStamp:undefined},f.config)).rejects.toThrow();await save(f.a.token,{...blank,expectedRevision:1});await expect(generateAssignmentSuggestions(env,'unused',f.input,f.config)).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();});
 it('rejects a member leaving or changing settings during inference',async()=>{const f=await assignmentFixture();vi.stubGlobal('fetch',vi.fn(async()=>{await env.DB.prepare('DELETE FROM project_members WHERE project_id=?1').bind(f.projectId).run();return Response.json({choices:[{message:{content:JSON.stringify({assignments:[{taskId:f.taskId,assigneeId:f.a.userId}]})}}]});}));await expect(generateAssignmentSuggestions(env,undefined as unknown as string,f.input,f.config)).rejects.toThrow();});
 it.each(['profile','provider'] as const)('rejects %s changes during inference',async(kind)=>{const f=await assignmentFixture();vi.stubGlobal('fetch',vi.fn(async()=>{if(kind==='profile')await save(f.a.token,{...blank,expectedRevision:1});else await env.DB.prepare('UPDATE ai_config_versions SET enabled=0 WHERE id=?1').bind(f.config.id).run();return Response.json({choices:[{message:{content:JSON.stringify({assignments:[{taskId:f.taskId,assigneeId:f.a.userId}]})}}]});}));await expect(generateAssignmentSuggestions(env,undefined as unknown as string,f.input,f.config)).rejects.toThrow();});
 it('does not repair with withdrawn profile data after a member leaves',async()=>{const f=await assignmentFixture();const fetch=vi.fn(async()=>{await env.DB.prepare('DELETE FROM project_members WHERE project_id=?1').bind(f.projectId).run();return Response.json({choices:[{message:{content:JSON.stringify({bad:blank.bio})}}]});});vi.stubGlobal('fetch',fetch);await expect(generateAssignmentSuggestions(env,undefined as unknown as string,f.input,f.config)).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);});
 it('blocks stale persisted proposals atomically after personal profile edit',async()=>{
  const f=await assignmentFixture();const now=new Date().toISOString();const jobId=crypto.randomUUID();const proposalId=crypto.randomUUID();
  await env.DB.batch([
   env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_by,created_at,updated_at) VALUES(?1,?2,'agent_run','succeeded',?3,?4,?5,?5)").bind(jobId,f.projectId,JSON.stringify({...f.input,members:[{userId:f.a.userId,major:'',skills:[],hoursPerWeek:null,loadHours:0}]}),f.a.userId,now),
   env.DB.prepare("INSERT INTO collaboration_proposals(id,project_id,kind,job_id,payload_json,settings_revision,status,revision,created_at,updated_at) VALUES(?1,?2,'assign',?3,?4,1,'pending',1,?5,?5)").bind(proposalId,f.projectId,jobId,JSON.stringify({assignments:[{taskId:f.taskId,assigneeId:null,expectedRevision:1,reason:'Safe'}]}),now)
  ]);
  await save(f.a.token,{...blank,expectedRevision:1});await expect(applyProposal(env,f.projectId,proposalId,1,f.a.userId)).rejects.toThrow();
  expect((await env.DB.prepare('SELECT status FROM collaboration_proposals WHERE id=?1').bind(proposalId).first<{status:string}>())?.status).toBe('pending');
 });
});
