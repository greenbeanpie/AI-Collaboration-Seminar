import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const production=process.argv.includes('--production');
const base=new URL(production?'https://team.greenbp.dpdns.org':process.env.INTEGRATION_URL || 'http://127.0.0.1:5179');
if(!production)assert(['127.0.0.1','localhost'].includes(base.hostname));
const index=process.argv.indexOf('--credentials');
const saved=JSON.parse(readFileSync(index>=0?process.argv[index+1]:new URL('../.local-secrets/admin-credentials.json',import.meta.url),'utf8'));
const account=production?saved.acceptanceAccounts?.findLast(a=>a.password&&a.userId):saved.accounts.local;
assert(account,'Existing verification account required');
let cookie='',checks=0,projectId;
async function call(path,method='GET',body,status=200){
  const headers={Origin:base.origin,'Idempotency-Key':randomUUID(),...(cookie?{Cookie:cookie}:{})};
  if(body!==undefined)headers['Content-Type']='application/json';
  const r=await fetch(new URL(`/api/v1${path}`,base),{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const envelope=await r.json();assert.equal(r.status,status,`${method} ${path}: ${envelope.error?.message || 'unexpected status'}`);
  if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];checks++;return envelope;
}
try {
  await call('/auth/sessions','POST',{account:account.username,password:account.password},201);
  const draft=(await call('/creation-drafts','POST',{name:'预览状态修复验收',description:'验收后归档，不调用外部模型'},201)).data;
  const path=`/creation-drafts/${draft.id}`;
  const first=(await call(path+'/preview','POST',{expectedRevision:draft.revision,mode:'manual',tasks:[],regenerate:true})).data;
  const second=(await call(path+'/preview','POST',{expectedRevision:first.revision,mode:'manual',tasks:[],regenerate:true})).data;
  assert.equal(first.revision,second.revision);assert.notEqual(first.previewAttemptId,second.previewAttemptId);
  const stale=await call(path+'/commit','POST',{expectedRevision:second.revision,expectedPreviewAttemptId:first.previewAttemptId,confirmed:true},409);
  assert.equal(stale.error.details.reason,'PREVIEW_REPLACED');
  assert.equal((await call(path)).data.status,'active');
  const body={expectedRevision:second.revision,expectedPreviewAttemptId:second.previewAttemptId,confirmed:true};
  projectId=(await call(path+'/commit','POST',body,201)).data.projectId;
  assert.equal((await call(path+'/commit','POST',body,201)).data.projectId,projectId);
  const project=(await call(`/projects/${projectId}`)).data;
  await call(`/projects/${projectId}`,'PATCH',{expectedRevision:project.revision,status:'archived'});
  projectId=undefined;
  console.log(`PASS: ${checks} ${production?'production':'local'} HTTP checks; same-revision preview replacement rejected, reviewed preview committed once, verification project archived. No AI calls.`);
} finally {
  if(projectId&&cookie){const p=(await call(`/projects/${projectId}`)).data;await call(`/projects/${projectId}`,'PATCH',{expectedRevision:p.revision,status:'archived'});}
  if(cookie)await call('/auth/session','DELETE');
}
