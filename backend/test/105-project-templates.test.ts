import { SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedUser } from './helpers/seed';
import { newId } from '../src/core/db';
import type { Env } from '../src/env';
import { commitDraft } from '../src/services/creation-drafts';
import { docToMarkdown, type TiptapDoc } from '../src/services/tiptap';

afterEach(()=>vi.unstubAllGlobals());
const request=(token:string,path:string,body?:unknown,method=body?'POST':'GET',key=newId())=>SELF.fetch(BASE+'/api/v1'+path,{method,headers:{cookie:authCookie(token),'content-type':'application/json','idempotency-key':key},...(body?{body:JSON.stringify(body)}:{})});
const json=async(response:Response)=>(await response.json() as {data:any}).data;
async function draft(token:string){const response=await request(token,'/creation-drafts/from-template',{templateId:'blank'});expect(response.status).toBe(201);return json(response);}
const formalTables=['projects','project_members','project_goals','materials','material_versions','requirement_sets','requirements','rubric_versions','standards_versions','tasks','task_dependencies','invitations','project_username_invitations','notification_events','notification_inbox','notification_push_outbox','jobs','job_outbox'];
let counts:Record<string,number>={};
beforeEach(async()=>{counts={};for(const table of formalTables)counts[table]=(await env.DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first<{n:number}>())!.n;});
async function assertNoFormalEntities(){for(const table of formalTables)expect((await env.DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first<{n:number}>())!.n,table).toBe(counts[table]);}
const workspace={templateId:'blank',materials:[{key:'background',title:'背景说明',purpose:'background',markdown:'# 项目背景\n\n真实研究背景。'},{key:'reference',title:'参考记录',purpose:'reference',markdown:'参考信息仍待核对。'},{key:'result',title:'报告草稿',purpose:'output',markdown:'**结论草稿**'}],standards:{title:'交付要求与评分',requirements:[{key:'deadline',title:'提交时间',detail:'遵守已知截止时间',category:'deadline',dueDate:'2026-10-09T23:59:00+08:00',duePrecision:'datetime'},{key:'quality',title:'结论有依据',detail:'明确写出依据',category:'deliverable',dimensionKey:'quality'}],weights:[{key:'quality',label:'论证质量',weight:100}],notes:'最终保存确认本版标准'}};
async function populate(token:string,value:any,inviteUsernames:string[]=[]){const saved=await json(await request(token,`/creation-drafts/${value.id}`,{expectedRevision:value.revision,payload:{...value.payload,name:'模板建立的项目',goal:{title:'完成可复核报告',detail:'交付有依据的结论'},teamSize:inviteUsernames.length+1,inviteUsernames,description:'原始项目描述',workspace}},'PATCH'));const preview=await json(await request(token,`/creation-drafts/${value.id}/preview`,{expectedRevision:saved.revision,mode:'manual',tasks:[{key:'collect',title:'收集依据',detail:'形成证据记录',criteria:'依据可复核',effortHours:1,dependsOn:[],citations:[]},{key:'write',title:'撰写报告',detail:'据此形成结论',criteria:'结论对应依据',effortHours:2,dependsOn:['collect'],citations:[]}]}));return preview;}

describe('blank project template private workspace',()=>{
  it('lists only the blank template and creates a replayable private empty editor state without formal entities or AI calls',async()=>{
    const owner=await seedUser(),key=newId(),fetch=vi.fn(()=>{throw new Error('template must not call a provider');});vi.stubGlobal('fetch',fetch);
    const catalog=await json(await request(owner.token,'/project-templates'));expect(catalog.items).toHaveLength(1);expect(catalog.items[0]).toMatchObject({templateId:'blank',name:'空项目'});
    const first=await json(await request(owner.token,'/creation-drafts/from-template',{templateId:'blank'},'POST',key));const replay=await json(await request(owner.token,'/creation-drafts/from-template',{templateId:'blank'},'POST',key));
    expect(replay.id).toBe(first.id);expect(first).toMatchObject({status:'active',revision:1,preview:null,projectId:null,files:[],payload:{name:'未命名项目',aiCollaborationEnabled:false,workspace:{templateId:'blank',materials:[],standards:null}}});
    expect((await json(await request(owner.token,'/projects'))).items).toEqual([]);await assertNoFormalEntities();expect(fetch).not.toHaveBeenCalled();
    expect((await request(owner.token,'/creation-drafts/from-template',{templateId:'research'})).status).toBe(400);
  });
  it('keeps materials, standards and tasks private through edits, then atomically promotes real versions, published standards and dependency edges once',async()=>{
    const owner=await seedUser(),recipient=await seedUser(),username=(await env.DB.prepare('SELECT username FROM auth_accounts WHERE user_id=?1').bind(recipient.userId).first<{username:string}>())!.username;
    const before=await populate(owner.token,await draft(owner.token),[username]);expect(before.payload.workspace).toEqual(workspace);expect(before.preview.tasks[1].dependsOn).toEqual(['collect']);await assertNoFormalEntities();
    const reloaded=await json(await request(owner.token,`/creation-drafts/${before.id}`));expect(reloaded.payload.workspace).toEqual(workspace);
    const committed=await json(await request(owner.token,`/creation-drafts/${before.id}/commit`,{expectedRevision:before.revision,confirmed:true}));expect(committed.usernameInvitations).toEqual([username]);
    const projects=await json(await request(owner.token,'/projects'));expect(projects.items).toHaveLength(1);expect(projects.items[0]).toMatchObject({id:committed.projectId,name:'模板建立的项目'});
    const goal=await json(await request(owner.token,`/projects/${committed.projectId}/goal`));expect(goal.title).toBe('完成可复核报告');
    const materials=await env.DB.prepare('SELECT m.title,m.purpose,v.markdown,v.doc_json FROM materials m JOIN material_versions v ON v.id=m.current_version_id WHERE m.project_id=?1').bind(committed.projectId).all<{title:string;purpose:string;markdown:string;doc_json:string}>();expect(materials.results).toHaveLength(4);
    for(const expected of workspace.materials){const actual=materials.results.find(m=>m.title===expected.title)!;expect(actual.purpose).toBe(expected.purpose);expect(actual.markdown).toBe(expected.markdown);expect(docToMarkdown(JSON.parse(actual.doc_json) as TiptapDoc)).toBe(expected.markdown);}
    const standard=await json(await request(owner.token,`/projects/${committed.projectId}/standards`));expect(standard.items).toHaveLength(1);expect(standard.items[0]).toMatchObject({status:'confirmed',title:workspace.standards.title});expect(standard.items[0].requirements).toHaveLength(2);expect(standard.items[0].requirements.every((r:any)=>r.citations.length===0)).toBe(true);expect(standard.items[0].mappings).toHaveLength(1);
    const tasks=await json(await request(owner.token,`/projects/${committed.projectId}/tasks`)),collect=tasks.items.find((t:any)=>t.title==='收集依据'),write=tasks.items.find((t:any)=>t.title==='撰写报告');expect(write.dependsOnTaskIds).toEqual([collect.taskId]);
    const repeat=await json(await request(owner.token,`/creation-drafts/${before.id}/commit`,{expectedRevision:before.revision,confirmed:true}));expect(repeat.projectId).toBe(committed.projectId);expect((await env.DB.prepare('SELECT COUNT(*) n FROM projects').first<{n:number}>())!.n).toBe(counts.projects!+1);expect((await env.DB.prepare('SELECT COUNT(*) n FROM standards_versions').first<{n:number}>())!.n).toBe(counts.standards_versions!+1);expect((await env.DB.prepare('SELECT COUNT(*) n FROM notification_inbox WHERE user_id=?1').bind(recipient.userId).first<{n:number}>())!.n).toBe(1);
  });
  it('commits the minimum empty template without inventing tasks, resources or grading dimensions',async()=>{
    const owner=await seedUser(),value=await draft(owner.token);const preview=await json(await request(owner.token,`/creation-drafts/${value.id}/preview`,{expectedRevision:1,mode:'manual',tasks:[]}));expect(preview.preview.tasks).toEqual([]);
    const result=await json(await request(owner.token,`/creation-drafts/${value.id}/commit`,{expectedRevision:1,confirmed:true}));expect((await json(await request(owner.token,`/projects/${result.projectId}/goal`))).title).toBe('未命名项目');
    for(const table of ['tasks','materials','standards_versions','rubric_versions'])expect((await env.DB.prepare(`SELECT COUNT(*) n FROM ${table} WHERE project_id=?1`).bind(result.projectId).first<{n:number}>())!.n).toBe(0);
  });
  it('publishes a requirements-only checklist without fabricated weights',async()=>{const owner=await seedUser(),value=await draft(owner.token);const saved=await json(await request(owner.token,`/creation-drafts/${value.id}`,{expectedRevision:1,payload:{...value.payload,workspace:{templateId:'blank',materials:[],standards:{title:'交付清单',requirements:[{key:'deliverable',title:'交付文档',detail:'保存一个文档',category:'deliverable'}],weights:[]}}}},'PATCH'));await request(owner.token,`/creation-drafts/${value.id}/preview`,{expectedRevision:saved.revision,mode:'manual',tasks:[]});const result=await json(await request(owner.token,`/creation-drafts/${value.id}/commit`,{expectedRevision:saved.revision,confirmed:true}));const standards=await json(await request(owner.token,`/projects/${result.projectId}/standards`));expect(standards.items[0]).toMatchObject({status:'confirmed',rubric:{weights:[]}});});
  it('enforces owner privacy, cancellation and CAS without losing template state',async()=>{
    const owner=await seedUser(),outsider=await seedUser(),value=await draft(owner.token);expect((await request(outsider.token,`/creation-drafts/${value.id}`)).status).toBe(404);expect((await request(outsider.token,`/creation-drafts/${value.id}`,{expectedRevision:1,payload:value.payload},'PATCH')).status).toBe(404);expect((await request(outsider.token,`/creation-drafts/${value.id}/commit`,{expectedRevision:1,confirmed:true})).status).toBe(404);
    const saved=await populate(owner.token,value);expect((await request(owner.token,`/creation-drafts/${value.id}`,{expectedRevision:1,payload:value.payload},'PATCH')).status).toBe(409);expect((await json(await request(owner.token,`/creation-drafts/${value.id}`))).payload.workspace).toEqual(workspace);
    const cancelled=await json(await request(owner.token,`/creation-drafts/${value.id}/state`,{expectedRevision:saved.revision,status:'cancelled'}));expect((await request(owner.token,`/creation-drafts/${value.id}/commit`,{expectedRevision:cancelled.revision,confirmed:true})).status).toBe(409);await assertNoFormalEntities();
  });
  it('rejects duplicate workspace keys, invalid scoring references, invented citations and dependency cycles before promotion',async()=>{
    const owner=await seedUser(),value=await draft(owner.token);const bad=[{...workspace,materials:[workspace.materials[0],workspace.materials[0]]},{...workspace,standards:{...workspace.standards,weights:[]}},{...workspace,standards:{...workspace.standards,requirements:[{...workspace.standards.requirements[0],citations:[{quote:'虚构原文'}]}]}}];
    for(const invalid of bad)expect((await request(owner.token,`/creation-drafts/${value.id}`,{expectedRevision:1,payload:{...value.payload,workspace:invalid}},'PATCH')).status).toBe(400);
    expect((await request(owner.token,`/creation-drafts/${value.id}/preview`,{expectedRevision:1,mode:'manual',tasks:[{key:'a',title:'A',detail:'',criteria:'成果',effortHours:1,dependsOn:['b'],citations:[]},{key:'b',title:'B',detail:'',criteria:'成果',effortHours:1,dependsOn:['a'],citations:[]}]})).status).toBe(400);await assertNoFormalEntities();
  });
  it('rejects a dense Markdown document whose converted Tiptap representation exceeds the native storage limit',async()=>{
    const owner=await seedUser(),value=await draft(owner.token),markdown='- dense item\n'.repeat(2200);
    expect(markdown.length).toBeLessThan(200_000);
    const saved=await request(owner.token,`/creation-drafts/${value.id}`,{expectedRevision:1,payload:{...value.payload,workspace:{templateId:'blank',materials:[{key:'dense',title:'密集列表',purpose:'output',markdown}],standards:null}}},'PATCH');expect(saved.status).toBe(400);
    const current=await json(await request(owner.token,`/creation-drafts/${value.id}`));expect(current.revision).toBe(1);expect(current.payload.workspace.materials).toEqual([]);await assertNoFormalEntities();
  });
  it('preserves template origin on older payload edits and restores cancelled drafts without formal creation',async()=>{
    const owner=await seedUser(),value=await draft(owner.token),payload={...value.payload,name:'旧客户端更名'};delete payload.workspace;
    const updated=await json(await request(owner.token,`/creation-drafts/${value.id}`,{expectedRevision:1,payload},'PATCH'));expect(updated.payload.workspace).toEqual(value.payload.workspace);
    const cancelled=await json(await request(owner.token,`/creation-drafts/${value.id}/state`,{expectedRevision:updated.revision,status:'cancelled'})),restored=await json(await request(owner.token,`/creation-drafts/${value.id}/state`,{expectedRevision:cancelled.revision,status:'active'}));expect(restored.payload.workspace.templateId).toBe('blank');
    expect((await request(owner.token,`/creation-drafts/${newId()}/commit`,{expectedRevision:1,confirmed:true})).status).toBe(404);await assertNoFormalEntities();
  });
  it('does not partially create entities or notifications if the final CAS loses a late race',async()=>{
    const owner=await seedUser(),recipient=await seedUser(),username=(await env.DB.prepare('SELECT username FROM auth_accounts WHERE user_id=?1').bind(recipient.userId).first<{username:string}>())!.username,value=await populate(owner.token,await draft(owner.token),[username]);let raced=false;
    const db=new Proxy(env.DB,{get(target,property){if(property==='batch')return async(statements:D1PreparedStatement[])=>{if(!raced){raced=true;await target.prepare("UPDATE project_creation_drafts SET revision=revision+1,preview_state='none' WHERE id=?1").bind(value.id).run();}return target.batch(statements);};const member=Reflect.get(target,property);return typeof member==='function'?member.bind(target):member;}});
    await expect(commitDraft({...env,DB:db} as Env,value.id,owner.userId,value.revision)).rejects.toThrow('草稿已变化');await assertNoFormalEntities();expect((await json(await request(owner.token,`/creation-drafts/${value.id}`))).payload.workspace).toEqual(workspace);
  });
  it('rolls back the entire promotion batch including standard publication and invites when storage fails',async()=>{
    const owner=await seedUser(),value=await populate(owner.token,await draft(owner.token));const db=new Proxy(env.DB,{get(target,property){if(property==='batch')return (statements:D1PreparedStatement[])=>target.batch([...statements,target.prepare("INSERT INTO project_goals(project_id,title,detail,created_at,updated_at) VALUES('missing-project','fail','','now','now')")]);const member=Reflect.get(target,property);return typeof member==='function'?member.bind(target):member;}});
    await expect(commitDraft({...env,DB:db} as Env,value.id,owner.userId,value.revision)).rejects.toThrow();await assertNoFormalEntities();expect((await json(await request(owner.token,`/creation-drafts/${value.id}`))).status).toBe('active');
  });
});
