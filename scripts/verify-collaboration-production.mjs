import assert from 'node:assert/strict';
import { readFileSync,writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

if(!process.argv.includes('--production'))throw new Error('Explicit --production required');
const base='https://team.greenbp.dpdns.org',statePath=new URL('../.local-secrets/production-collaboration-smoke.json',import.meta.url);
let checks=0;
async function call(user,path,method='GET',body,status=200) {
  const headers={Origin:base,'Idempotency-Key':randomUUID()};if(user?.cookie)headers.Cookie=user.cookie;
  if(body!==undefined)headers['Content-Type']='application/json';
  const r=await fetch(`${base}/api/v1${path}`,{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{})});
  assert.equal(r.status,status,`${method} ${path} unexpected status`);const result=await r.json();
  if(user&&r.headers.get('set-cookie'))user.cookie=r.headers.get('set-cookie').split(';')[0];checks++;return result.data;
}
if(process.argv.includes('--cleanup')) {
  const state=JSON.parse(readFileSync(statePath,'utf8')),p=`/projects/${state.projectId}`;
  const project=await call(state.owner,p);await call(state.owner,p,'PATCH',{expectedRevision:project.revision,status:'archived'});
  for(const user of [state.owner,state.member])await call(user,'/auth/session','DELETE');
  state.cleanedAt=new Date().toISOString();writeFileSync(statePath,JSON.stringify(state,null,2));
  console.log('PASS: production verification project archived; smoke sessions revoked.');process.exit(0);
}
const index=process.argv.indexOf('--credentials'),saved=JSON.parse(readFileSync(index>=0?process.argv[index+1]:new URL('../.local-secrets/admin-credentials.json',import.meta.url),'utf8'));
assert(saved.accounts.production?.initialized,'Existing production administrator required');
const normal=saved.acceptanceAccounts?.findLast(a=>a.userId&&a.password);assert(normal,'Existing disposable acceptance account required');
const owner={...saved.accounts.production},member={...normal};
owner.user=(await call(owner,'/auth/sessions','POST',{account:owner.username,password:owner.password},201)).user;
member.user=(await call(member,'/auth/sessions','POST',{account:member.username,password:member.password},201)).user;
assert.equal(member.user.isAdmin,false);
assert.equal((await call(owner,'/capabilities')).environment,'production');
const existing=await call(owner,'/projects?status=all&limit=100');let rehearsalReads=0;
for(const project of existing.items){
  const history=await call(owner,`/projects/${project.id}/rehearsals`);
  for(const item of history.items){const detail=await call(owner,`/projects/${project.id}/rehearsals/${item.rehearsalId}`);assert.equal(typeof detail.canOperate,'boolean');assert(detail.initiatorId&&detail.respondentId);rehearsalReads++;}
}
const project=await call(owner,'/projects','POST',{name:'发布验收 · 团队协作六项改进',description:'临时验收项目，验收后归档'},201),p=`/projects/${project.id}`;
const invitation=await call(owner,`${p}/invitations`,'POST',{maxUses:1},201);await call(member,'/invitations/accept','POST',{code:invitation.code});
const members=await call(member,`${p}/members`);assert.equal(members.items.length,2);assert.equal(members.items.find(m=>m.userId===member.user.id).permissions.teamManage,false);
await call(member,`${p}/invitations`,'GET',undefined,403);
const permissions={teamManage:true,taskManage:false,resourceManage:false,scoreInitiate:true};
await call(owner,`${p}/members/${member.user.id}/permissions`,'PATCH',{expectedRevision:1,permissions});await call(member,`${p}/invitations`);
await call(member,`${p}/members/${owner.user.id}/permissions`,'PATCH',{expectedRevision:1,permissions},403);
await call(owner,`${p}/members/${member.user.id}/permissions`,'PATCH',{expectedRevision:2,permissions:{...permissions,teamManage:false}});
const file=await call(member,`${p}/files`,'POST',{fileName:'production-attribution-verification.txt',contributorIds:[owner.user.id,member.user.id]},201);
assert.equal((await call(member,`${p}/files`)).items.find(f=>f.fileId===file.fileId).contributors.length,2);
async function task(title,user,dependencies=[]){const goal=await call(owner,`${p}/goal`);return call(owner,`${p}/tasks`,'POST',{title,criteria:'验收数据，不触发外部模型',assigneeId:user.user.id,dependsOnTaskIds:dependencies,expectedGraphRevision:goal.graphRevision},201);}
const up1=await task('前置资料一',owner),up2=await task('前置资料二',owner),down=await task('领取后的就绪通知验证',member,[up1.taskId,up2.taskId]);
async function complete(t){const current=await call(owner,`${p}/tasks/${t.taskId}`);const submission=await call(owner,`${p}/collaboration/tasks/${t.taskId}/submissions`,'POST',{expectedRevision:current.revision,body:'人工验收测试结果'},201);await call(owner,`${p}/collaboration/submissions/${submission.submissionId}/decide`,'POST',{expectedRevision:submission.revision,decision:'accept',feedback:'仅验证状态与通知，不调用模型'});}
const ready=async()=>(await call(member,'/notifications')).items.filter(n=>n.kind==='task_ready'&&n.url.includes(project.id));
await complete(up1);assert.equal((await ready()).length,0);await complete(up2);assert.equal((await ready()).length,1);
const inquiry=await call(member,`${p}/tasks/${down.taskId}/inquiries`,'POST',{upstreamTaskId:up1.taskId,body:'生产验证：前置任务的影响？'},201);
await call(owner,`${p}/task-inquiries/${inquiry.inquiryId}/messages`,'POST',{body:'生产验证：约定已记录'},201);
assert.equal((await call(member,`${p}/tasks/${down.taskId}/inquiries`)).items[0].messages.length,2);
assert((await call(owner,'/notifications')).items.some(n=>n.kind==='task_inquiry'&&n.url.includes(project.id)));
writeFileSync(statePath,JSON.stringify({base,owner,member,projectId:project.id,taskId:down.taskId,checks,rehearsalReads},null,2));
console.log(`PASS: ${checks} production API checks; normal-member contract, permissions, attribution, readiness and private messages; ${rehearsalReads} existing shared rehearsal read(s). Run --cleanup after browser verification.`);
