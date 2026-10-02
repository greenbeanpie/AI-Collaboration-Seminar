import { describe,it,expect,vi,afterEach } from 'vitest';
import { env,BASE } from './helpers/env';
import { seedUser,seedProject,authCookie } from './helpers/seed';
import { configureGoFixture } from './helpers/provider-config';
import { newId,nowIso } from '../src/core/db';
import { createApp } from '../src/app';
import { enqueueDraftPreview } from '../src/services/draft-preview-jobs';
import { previewDraft } from '../src/services/creation-drafts';
import { gcOrphanObjects } from '../src/services/gc';
import type { Env } from '../src/env';
afterEach(()=>vi.unstubAllGlobals());
describe('background preview and investigation storage',()=>{
 it('dispatches a private draft once, resumes its exact attempt and never creates a project',async()=>{
  await configureGoFixture();const owner=await seedUser(),id=newId(),now=nowIso();
  await env.DB.prepare('INSERT INTO project_creation_drafts(id,owner_id,payload_json,project_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)').bind(id,owner.userId,JSON.stringify({name:'后台预览',aiCollaborationEnabled:true,brief:'生成计划'}),newId(),now).run();
  const create=vi.fn(async()=>({id:'fixture'})),local={...env,AGENT_WORKFLOW:{create}} as unknown as Env;
  const queued=await enqueueDraftPreview(local,id,owner.userId,1,[],false);
  expect(queued.previewState).toBe('running');
  await enqueueDraftPreview(local,id,owner.userId,1,[],false);expect(create).toHaveBeenCalledOnce();
  const params=create.mock.calls[0] as unknown as [{params:{draftPreview:{attempt:string}}}];
  const model=vi.fn(async()=>Response.json({choices:[{message:{content:JSON.stringify({goal:{title:'完整交付',detail:'测试'},tasks:[{key:'a',title:'调查',detail:'按资料调查',criteria:'提供证据',effortHours:1,dependsOn:[],citations:[]}]})}}],usage:{prompt_tokens:10,completion_tokens:10}}));
  vi.stubGlobal('fetch',model);
  const ready=await previewDraft(local,id,owner.userId,1,'ai',[],false,undefined,params[0].params.draftPreview.attempt);
  expect(ready.previewState).toBe('ready');expect(ready.preview?.tasks).toHaveLength(1);
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM projects WHERE created_by=?1').bind(owner.userId).first<{n:number}>())!.n).toBe(0);
 });
 it('keeps referenced investigation checkpoints and collects only aged orphans',async()=>{
  const owner=await seedUser(),projectId=await seedProject(owner.userId),id=newId(),orphan=newId(),key=`ai/investigations/${id}.json`,orphanKey=`ai/investigations/${orphan}.json`;
  await env.DB.prepare('INSERT INTO ai_investigations(id,project_id,requested_by,prompt_version,checkpoint_key,updated_at) VALUES(?1,?2,?3,?4,?5,?6)').bind(id,projectId,owner.userId,'fixture',key,nowIso()).run();
  await env.FILES.put(key,'{}');await env.FILES.put(orphanKey,'{}');
  const result=await gcOrphanObjects(env,new Date(Date.now()+60_000).toISOString(),{graceDays:0});
  expect(result.deleted).toContain(orphanKey);expect(await env.FILES.get(key)).not.toBeNull();
 });
 it('manual scoring repeated with the same intent is idempotent and creates one progress event',async()=>{
  const owner=await seedUser(),projectId=await seedProject(owner.userId),app=createApp();
  const headers={cookie:authCookie(owner.token),'content-type':'application/json','idempotency-key':newId()};
  const request=(path:string,body:unknown)=>app.fetch(new Request(`${BASE}/api/v1/projects/${projectId}${path}`,{method:'POST',headers,body:JSON.stringify(body)}),env);
  const draft=(await (await request('/standards',{requirements:[],weights:[{key:'q',label:'质量',weight:1}]})).json() as {data:{standardsVersionId:string;revision:number}}).data;
  await request(`/standards/${draft.standardsVersionId}/confirm`,{expectedRevision:draft.revision});
  const body={standardsVersionId:draft.standardsVersionId,scores:[{key:'q',score:85}],reason:'人工核对'};
  const one=await request('/assessments/manual',body),two=await request('/assessments/manual',body);
  expect(one.status).toBe(201);expect(await one.json()).toMatchObject({data:{revision:1,origin:'manual'}});expect(two.status).toBe(201);
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM assessments WHERE project_id=?1').bind(projectId).first<{n:number}>())!.n).toBe(1);
  expect((await env.DB.prepare("SELECT COUNT(*) n FROM events WHERE project_id=?1 AND type='assessment.manual_created'").bind(projectId).first<{n:number}>())!.n).toBe(1);
 });
});
