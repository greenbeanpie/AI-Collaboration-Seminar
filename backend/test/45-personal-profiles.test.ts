import { SELF } from 'cloudflare:test';
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { seedUser, seedProject, authCookie } from './helpers/seed';
import { profileStamp, finishRecommendationJob } from '../src/services/personal-profiles';
import { generateAssignmentSuggestions, runAssignmentSuggestionJob, type AssignmentSuggestionInput } from '../src/services/assignment';
import { runCollaborationAiJob } from '../src/services/collaboration-ai';
import { loadAiConfig } from '../src/ai/config';
import { configureGoFixture } from './helpers/provider-config';
import { applyProposal } from '../src/services/collaboration';
import { reserveAiSlot } from '../src/services/budget';

const blank = { searchable:false,aiUseAllowed:false,bio:'private-bio-needle',major:'private-major-needle',specialties:'private-specialties-needle',preferredRoles:'private-role-needle',visibility:{bio:false,major:false,specialties:false,preferredRoles:false},expectedRevision:0 };
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
  const initial=await get(ownPath,a.token);expect(initial.headers.get('cache-control')).toBe('no-store');expect((await initial.json() as any).data).toMatchObject({revision:0,searchable:false,aiUseAllowed:false,visibility:{bio:false}});
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

async function assignmentFixture(allowed=true) {
 await configureGoFixture();const a=await user('alice');const outside=await user('outside');const projectId=await seedProject(a.userId);
 await env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=1 WHERE id=?1').bind(projectId).run();
 await save(a.token,{...blank,aiUseAllowed:allowed});await save(outside.token,{...blank,aiUseAllowed:true,bio:'OUTSIDE-SECRET'});
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

async function peerRequest(f: Awaited<ReturnType<typeof assignmentFixture>>) {
 const peer=await seedUser('peer@example.test');
 await env.DB.prepare("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES(?1,?2,?3,'member',?4)").bind(crypto.randomUUID(),f.projectId,peer.userId,new Date().toISOString()).run();
 f.input.requestedBy=peer.userId;f.input.members.push({userId:peer.userId,displayName:'LEGACY-PEER-NAME',skills:['LEGACY-PEER-SKILLS'],hoursPerWeek:123});
 f.input.profileStamp=await profileStamp(env,f.projectId);
 return peer;
}
function captureModel(f:Awaited<ReturnType<typeof assignmentFixture>>,messages:string[],before?:()=>Promise<void>,bad=false) {
 const fetch=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{messages.push(String(init?.body));await before?.();return Response.json({choices:[{message:{content:JSON.stringify(bad?{bad:blank.bio}:{assignments:[{taskId:f.taskId,assigneeId:f.a.userId}]})}}]});});
 vi.stubGlobal('fetch',fetch);return fetch;
}
async function pendingJob(f:Awaited<ReturnType<typeof assignmentFixture>>) {
 const id=crypto.randomUUID();const now=new Date().toISOString();
 await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_by,created_at,updated_at) VALUES(?1,?2,'assignment_suggest','queued',?3,?4,?5,?5)").bind(id,f.projectId,JSON.stringify(f.input),f.input.requestedBy,now).run();
 return id;
}
describe('explicit personal AI consent',()=>{
 it('peer-triggered recommendation omits denied private/public profile and legacy member attributes',async()=>{
  const f=await assignmentFixture(false);await peerRequest(f);
  f.input.members[0]!.displayName='LEGACY-NAME';f.input.members[0]!.skills=['LEGACY-SKILL'];f.input.members[0]!.major='LEGACY-MAJOR';f.input.members[0]!.hoursPerWeek=99;
  await env.DB.prepare("UPDATE project_members SET major='LEGACY-DB-MAJOR',skills_json='[\"LEGACY-DB-SKILL\"]',hours_per_week=99 WHERE project_id=?1 AND user_id=?2").bind(f.projectId,f.a.userId).run();
  await save(f.a.token,{...blank,searchable:true,visibility:{bio:true,major:true,specialties:true,preferredRoles:true},expectedRevision:1});
  f.input.profileStamp=await profileStamp(env,f.projectId);const messages:string[]=[];captureModel(f,messages);
  const output=await generateAssignmentSuggestions(env,undefined as unknown as string,f.input,f.config);
  expect(messages).toHaveLength(1);expect(messages[0]).not.toContain('private-');expect(messages[0]).not.toContain('LEGACY-');expect(messages[0]).not.toContain('OUTSIDE-SECRET');
  const payload=JSON.parse(JSON.parse(messages[0]!).messages[1].content);expect(payload.preferences).toEqual([]);expect(Object.keys(payload.members[0]).sort()).toEqual(['loadHours','userId']);expect(output.assignments).toHaveLength(1);
 });
 it('existing rows and writes without explicit consent stay denied',async()=>{
  const f=await assignmentFixture(false);
  await env.DB.prepare('DELETE FROM personal_profiles WHERE user_id=?1').bind(f.a.userId).run();
  await env.DB.prepare("INSERT INTO personal_profiles(user_id,bio,updated_at) VALUES(?1,'UNCONFIRMED-OLD-BIO',?2)").bind(f.a.userId,new Date().toISOString()).run();
  const row=await env.DB.prepare('SELECT ai_use_allowed FROM personal_profiles WHERE user_id=?1').bind(f.a.userId).first<{ai_use_allowed:number}>();expect(row?.ai_use_allowed).toBe(0);
  const {aiUseAllowed:omitted,...oldClientBody}=blank;expect(omitted).toBe(false);expect((await save(f.a.token,oldClientBody)).status).toBe(400);
  f.input.profileStamp=await profileStamp(env,f.projectId);const messages:string[]=[];captureModel(f,messages);await generateAssignmentSuggestions(env,undefined as unknown as string,f.input,f.config);expect(messages[0]).not.toContain('UNCONFIRMED-OLD-BIO');
 });
 it('only self opt-in enables private profiles for another current member, independently of publication',async()=>{
  const f=await assignmentFixture(false);const peer=await peerRequest(f);
  expect((await save(peer.token,{...blank,aiUseAllowed:true,userId:f.a.userId})).status).toBe(400);
  expect((await save(peer.token,{...blank,aiUseAllowed:true,bio:'PEER-OWN-DATA'})).status).toBe(200);
  const denied:string[]=[];f.input.profileStamp=await profileStamp(env,f.projectId);captureModel(f,denied);await generateAssignmentSuggestions(env,undefined as unknown as string,f.input,f.config);expect(denied[0]).not.toContain(blank.bio);expect(denied[0]).toContain('PEER-OWN-DATA');
  const saved=await save(f.a.token,{...blank,aiUseAllowed:true,expectedRevision:1});expect(saved.status).toBe(200);expect((await saved.json() as any).data).toMatchObject({aiUseAllowed:true,searchable:false,visibility:{bio:false}});
  const consented:string[]=[];f.input.profileStamp=await profileStamp(env,f.projectId);captureModel(f,consented);await generateAssignmentSuggestions(env,undefined as unknown as string,f.input,f.config);expect(consented[0]).toContain(blank.bio);expect(consented[0]).not.toContain('OUTSIDE-SECRET');
 });
 it('withdrawal blocks queued jobs before fetch and invalidates proposals/results',async()=>{
  const f=await assignmentFixture();await peerRequest(f);const jobId=await pendingJob(f);const proposalId=crypto.randomUUID();const now=new Date().toISOString();
  await env.DB.prepare("INSERT INTO collaboration_proposals(id,project_id,kind,job_id,payload_json,settings_revision,status,revision,created_at,updated_at) VALUES(?1,?2,'assign',?3,?4,1,'pending',1,?5,?5)").bind(proposalId,f.projectId,jobId,JSON.stringify({assignments:[],considerations:['STALE-OUTPUT']}),now).run();
  expect((await save(f.a.token,{...blank,expectedRevision:1})).status).toBe(200);const messages:string[]=[];const fetch=captureModel(f,messages);
  await expect(generateAssignmentSuggestions(env,jobId,f.input,f.config)).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
  await expect(finishRecommendationJob(env,jobId,{output:'STALE-OUTPUT'})).rejects.toThrow();
  const job=await env.DB.prepare('SELECT status,result_json FROM jobs WHERE id=?1').bind(jobId).first();expect(job).toMatchObject({status:'queued',result_json:null});
  const response=await get(`/api/v1/jobs/${jobId}`,f.a.token);expect(response.status).toBe(409);expect(response.headers.get('cache-control')).toBe('no-store');expect(await response.text()).not.toContain('STALE-OUTPUT');
  const proposals=await get(`/api/v1/projects/${f.projectId}/collaboration/proposals`,f.a.token);expect(proposals.headers.get('cache-control')).toBe('no-store');const data=await proposals.json() as any;expect(data.data.items[0]).toMatchObject({status:'stale',payload:{}});expect(JSON.stringify(data)).not.toContain('STALE-OUTPUT');
  await expect(applyProposal(env,f.projectId,proposalId,1,f.a.userId)).rejects.toThrow();
 });
 it('withdrawal during a valid response discards it and during repair prevents a second request',async()=>{
  const f=await assignmentFixture();await peerRequest(f);const messages:string[]=[];const fetch=captureModel(f,messages,async()=>{expect((await save(f.a.token,{...blank,expectedRevision:1})).status).toBe(200);});
  await expect(generateAssignmentSuggestions(env,undefined as unknown as string,f.input,f.config)).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
  await save(f.a.token,{...blank,aiUseAllowed:true,expectedRevision:2});f.input.profileStamp=await profileStamp(env,f.projectId);const repair=captureModel(f,[],async()=>{await save(f.a.token,{...blank,expectedRevision:3});},true);
  await expect(generateAssignmentSuggestions(env,undefined as unknown as string,f.input,f.config)).rejects.toThrow();expect(repair).toHaveBeenCalledTimes(1);
 });
 it('withdrawal after inference prevents atomic result publication and hides previously published results',async()=>{
  const f=await assignmentFixture();const completed=await pendingJob(f);await finishRecommendationJob(env,completed,{assignments:[],considerations:['PREVIOUS-OUTPUT']});expect((await get(`/api/v1/jobs/${completed}`,f.a.token)).status).toBe(200);
  const pending=await pendingJob(f);captureModel(f,[]);const output=await generateAssignmentSuggestions(env,undefined as unknown as string,f.input,f.config);
  await save(f.a.token,{...blank,expectedRevision:1});await expect(finishRecommendationJob(env,pending,output)).rejects.toThrow();const old=await get(`/api/v1/jobs/${completed}`,f.a.token);expect(old.status).toBe(409);expect(await old.text()).not.toContain('PREVIOUS-OUTPUT');
 });
 it('rechecks consent after the budget write immediately before provider fetch',async()=>{
  const f=await assignmentFixture();const jobId=await pendingJob(f);await reserveAiSlot(env,{projectId:f.projectId,jobId,purpose:'assignment_suggest',configVersionId:f.config.id});
  const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(target,key){
   if(key==='bind')return (...values:unknown[])=>wrap(target.bind(...values));
   if(key==='run')return async()=>{const result=await target.run();expect((await save(f.a.token,{...blank,expectedRevision:1})).status).toBe(200);return result;};
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  const database=new Proxy(env.DB,{get(target,key){if(key==='prepare')return (sql:string)=>{const statement=target.prepare(sql);return sql.includes('UPDATE usage_reservations SET attempts_started')?wrap(statement):statement;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  const fetch=captureModel(f,[]);await expect(generateAssignmentSuggestions({...env,DB:database},jobId,f.input,f.config)).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
 });
});

describe('last dispatch authorization',()=>{
 it.each([
  ['assignment',1],['assignment',2],['collaboration',1],['collaboration',2],
 ] as const)('blocks %s request %i when withdrawal completes during its final config read',async(kind,attempt)=>{
  const f=await assignmentFixture();const jobId=crypto.randomUUID();const now=new Date().toISOString();
  const input=kind==='assignment'?{...f.input,configVersionId:f.config.id}:{
   operation:'collaboration.assign',projectId:f.projectId,requestedBy:f.a.userId,settingsRevision:1,configVersionId:f.config.id,profileStamp:f.input.profileStamp,
   tasks:f.input.tasks.map(t=>({...t,criteria:'Deliver work',effortHours:1})),
   members:[{userId:f.a.userId,major:'LEGACY-MAJOR',skills:['LEGACY-SKILL'],hoursPerWeek:99,loadHours:0}],
  };
  await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_by,created_at,updated_at) VALUES(?1,?2,?3,'queued',?4,?5,?6,?6)")
   .bind(jobId,f.projectId,kind==='assignment'?'assignment_suggest':'agent_run',JSON.stringify(input),f.a.userId,now).run();
  await reserveAiSlot(env,{projectId:f.projectId,jobId,purpose:'assignment_suggest',configVersionId:f.config.id});
  let budgetWrites=0;let withdrawn=false;const events:string[]=[];
  const wrap=(statement:D1PreparedStatement,sql:string):D1PreparedStatement=>new Proxy(statement,{get(target,key){
   if(key==='bind')return (...values:unknown[])=>wrap(target.bind(...values),sql);
   if(key==='run'&&sql.includes('UPDATE usage_reservations SET attempts_started'))return async()=>{
    const result=await target.run();budgetWrites++;events.push('budget-write');return result;
   };
   if(key==='first'&&sql.includes('FROM ai_config_versions ORDER BY'))return async()=>{
    const result=await target.first();
    if(budgetWrites===attempt&&!withdrawn){
     events.push('config-read');expect((await save(f.a.token,{...blank,expectedRevision:1})).status).toBe(200);
     withdrawn=true;events.push('withdrawn');
    }
    return result;
   };
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  const database=new Proxy(env.DB,{get(target,key){
   if(key==='prepare')return (sql:string)=>wrap(target.prepare(sql),sql);
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  const fetch=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{
   events.push('provider-fetch');expect(withdrawn).toBe(false);expect(String(init?.body)).toContain(blank.bio);
   return Response.json({choices:[{message:{content:JSON.stringify({bad:blank.bio})}}]});
  });vi.stubGlobal('fetch',fetch);
  if(kind==='assignment')await runAssignmentSuggestionJob({...env,DB:database},jobId);
  else await runCollaborationAiJob({...env,DB:database},jobId);
  expect(withdrawn).toBe(true);expect(budgetWrites).toBe(attempt);expect(fetch).toHaveBeenCalledTimes(attempt-1);
  expect(events.slice(-3)).toEqual(['budget-write','config-read','withdrawn']);
  expect((await env.DB.prepare('SELECT status,result_json FROM jobs WHERE id=?1').bind(jobId).first())).toMatchObject({status:'failed',result_json:null});
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM collaboration_proposals WHERE job_id=?1').bind(jobId).first<{n:number}>())?.n).toBe(0);
 });

 it.each(['consent','member','config'] as const)('rejects a %s change at the final context read',async(kind)=>{
  const f=await assignmentFixture();let checked=false;
  const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(target,key){
   if(key==='bind')return (...values:unknown[])=>wrap(target.bind(...values));
   if(key==='first')return async()=>{
    checked=true;
    if(kind==='consent')expect((await save(f.a.token,{...blank,expectedRevision:1})).status).toBe(200);
    else if(kind==='member')await env.DB.prepare('DELETE FROM project_members WHERE project_id=?1').bind(f.projectId).run();
    else await env.DB.prepare('UPDATE ai_config_versions SET enabled=0 WHERE id=?1').bind(f.config.id).run();
    return target.first();
   };
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  const database=new Proxy(env.DB,{get(target,key){
   if(key==='prepare')return (sql:string)=>{const statement=target.prepare(sql);return sql.includes('/* recommendation-dispatch */')?wrap(statement):statement;};
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  const fetch=captureModel(f,[]);await expect(generateAssignmentSuggestions({...env,DB:database},undefined as unknown as string,f.input,f.config)).rejects.toThrow();
  expect(checked).toBe(true);expect(fetch).not.toHaveBeenCalled();
 });
});
