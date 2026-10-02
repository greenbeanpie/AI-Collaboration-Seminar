import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Disposable local accounts/records only. Credentials and fixture SQL stay gitignored.
const root=fileURLToPath(new URL('../',import.meta.url));
const base=new URL(process.env.INTEGRATION_URL || 'http://127.0.0.1:5179');
assert(['localhost','127.0.0.1'].includes(base.hostname));
let checks=0;
async function call(user,path,method='GET',body,status=200) {
  const headers={Origin:base.origin,'X-Request-Id':randomUUID(),'Idempotency-Key':randomUUID(),'CF-Connecting-IP':'198.51.100.241'};
  if(user?.cookie)headers.Cookie=user.cookie;
  if(body!==undefined)headers['Content-Type']='application/json';
  const res=await fetch(new URL(`/api/v1${path}`,base),{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const result=await res.json();assert.equal(res.status,status,`${method} ${path}: ${result.error?.message ?? 'unexpected status'}`);
  if(user && res.headers.get('set-cookie'))user.cookie=res.headers.get('set-cookie').split(';')[0];
  checks++;return result.data;
}
assert.equal((await call(null,'/capabilities')).environment,'local');
const admin={};const credentials=JSON.parse(readFileSync(new URL('../.local-secrets/admin-credentials.json',import.meta.url),'utf8')).accounts.local;
await call(admin,'/auth/sessions','POST',{account:credentials.username,password:credentials.password},201);
async function account(role) {
  const invitation=await call(admin,'/admin/account-invitations','POST',{},201), user={username:`verify_${role}_${randomUUID().slice(0,8)}`,password:`Local-verification-${randomUUID()}`};
  user.user=(await call(user,'/auth/register','POST',{username:user.username,password:user.password,invitationCode:invitation.code},201)).user;
  return user;
}
const owner=await account('owner'),member=await account('member');
const project=await call(owner,'/projects','POST',{name:'团队协作六项改进 · 本地验收',description:'仅本地验证'},201),p=`/projects/${project.id}`;
const invite=await call(owner,`${p}/invitations`,'POST',{},201);await call(member,'/invitations/accept','POST',{code:invite.code});
assert.equal((await call(member,`${p}/members`)).items.length,2);
await call(member,`${p}/invitations`,'GET',undefined,403);
const permissions={teamManage:true,taskManage:true,resourceManage:true,scoreInitiate:true};
await call(owner,`${p}/members/${member.user.id}/permissions`,'PATCH',{expectedRevision:1,permissions});
await call(member,`${p}/invitations`);
await call(member,`${p}/members/${owner.user.id}/permissions`,'PATCH',{expectedRevision:1,permissions},403);
await call(owner,`${p}/members/${member.user.id}/permissions`,'PATCH',{expectedRevision:2,permissions:{...permissions,teamManage:false,taskManage:false,resourceManage:false}});
const file=await call(member,`${p}/files`,'POST',{fileName:'shared-contribution.txt',contributorIds:[owner.user.id,member.user.id]},201);
assert.equal((await call(member,`${p}/files`)).items.find(f=>f.fileId===file.fileId).contributors.length,2);
async function task(title,user,dependencies=[]) {
  const goal=await call(owner,`${p}/goal`);
  return call(owner,`${p}/tasks`,'POST',{title,criteria:'交付可复核结果',assigneeId:user.user.id,dependsOnTaskIds:dependencies,expectedGraphRevision:goal.graphRevision},201);
}
const up=await task('上游接口定义',owner),middle=await task('上游接口实现',owner,[up.taskId]),second=await task('上游数据准备',owner),down=await task('下游集成验证',member,[middle.taskId,second.taskId]);
async function finish(task) {
  const current=await call(owner,`${p}/tasks/${task.taskId}`);
  const submission=await call(owner,`${p}/collaboration/tasks/${task.taskId}/submissions`,'POST',{expectedRevision:current.revision,body:'本地验收提交，已完成要求'},201);
  await call(owner,`${p}/collaboration/submissions/${submission.submissionId}/decide`,'POST',{expectedRevision:submission.revision,decision:'accept',feedback:'人工核验通过'});
}
await finish(up);await finish(middle);
assert.equal((await call(member,'/notifications')).items.filter(n=>n.kind==='task_ready').length,0);
await finish(second);
assert.equal((await call(member,'/notifications')).items.filter(n=>n.kind==='task_ready').length,1);
const inquiry=await call(member,`${p}/tasks/${down.taskId}/inquiries`,'POST',{upstreamTaskId:up.taskId,body:'间接前置任务的接口格式如何影响集成？'},201);
await call(owner,`${p}/task-inquiries/${inquiry.inquiryId}/messages`,'POST',{body:'请使用约定的 JSON 接口。'},201);
assert.equal((await call(member,`${p}/tasks/${down.taskId}/inquiries`)).items[0].messages.length,2);
assert((await call(owner,'/notifications')).items.some(n=>n.kind==='task_inquiry'));

// UI-only rehearsal fixture: no model configuration, paid calls or production mutation.
const rehearsalId=randomUUID(),now=new Date().toISOString(),quote=s=>`'${String(s).replaceAll("'","''")}'`;
const sql=`INSERT INTO rehearsals(id,project_id,scope,material_version_ids_json,status,created_by,created_at) VALUES(${quote(rehearsalId)},${quote(project.id)},'all','[]','active',${quote(owner.user.id)},${quote(now)});
INSERT INTO rehearsal_turns(id,rehearsal_id,project_id,sequence,kind,content_json,created_at) VALUES(${quote(randomUUID())},${quote(rehearsalId)},${quote(project.id)},1,'question','{"content":"请说明上游任务如何支持项目交付。"}',${quote(now)});`;
const sqlPath=new URL('../.local-secrets/collaboration-fixture.sql',import.meta.url);writeFileSync(sqlPath,sql);
execFileSync(process.execPath,[fileURLToPath(new URL('../backend/node_modules/wrangler/bin/wrangler.js',import.meta.url)),'d1','execute','DB','--local','--config',fileURLToPath(new URL('../backend/wrangler.jsonc',import.meta.url)),'--file',fileURLToPath(sqlPath),'--json'],{cwd:root,stdio:'pipe',windowsHide:true});
assert.equal((await call(member,`${p}/rehearsals/${rehearsalId}`)).canOperate,false);
await call(member,`${p}/rehearsals/${rehearsalId}/answers`,'POST',{content:'旁观者不能回答'},403);
await call(member,`${p}/rehearsals/${rehearsalId}/finish`,'POST',{},403);
writeFileSync(new URL('../.local-secrets/collaboration-smoke.json',import.meta.url),JSON.stringify({base:base.origin,owner,member,projectId:project.id,taskId:down.taskId,rehearsalId},null,2));
console.log(`PASS: ${checks} local API checks; permissions, contributors, last-dependency readiness, private upstream messages and rehearsal ownership verified. Browser fixtures saved privately.`);
