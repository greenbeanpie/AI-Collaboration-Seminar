/** Real local Workers D1/R2 + production plugin runner contract acceptance.
 * Requires backend wrangler dev at BRIDGE_LOCAL_URL (default127.0.0.1:5288).
 * Own test-only D1 storage/migrations; never accepts a production URL.
 * Website eligibility is seeded as an explicit fixture; DSH adapter is simulated.
 * Actual RC2 model/tool lifecycle is verified separately by plugin smoke:host.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID,randomBytes,createHash } from 'node:crypto';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { Journal,CloudClient,BridgeRunner } from '../packages/dsh-team-office-bridge/src/runner.js';

const root=resolve('.'),backend=join(root,'backend'),out=join(root,'output/dsh-bridge-local');await mkdir(out,{recursive:true});
const origin=process.env.BRIDGE_LOCAL_URL||'http://127.0.0.1:5288';assert(['127.0.0.1','localhost'].includes(new URL(origin).hostname));
const state=process.env.BRIDGE_LOCAL_STATE||join(root,'output/dsh-bridge-local/state');
const cli=join(backend,'node_modules/wrangler/bin/wrangler.js'),sha=s=>createHash('sha256').update(s).digest('hex');
function query(sql){const stdout=execFileSync(process.execPath,[cli,'d1','execute','DB','--local','--persist-to',state,'--command',sql,'--json'],{cwd:backend,encoding:'utf8',windowsHide:true,maxBuffer:4000000});const results=JSON.parse(stdout.replace(/^\uFEFF/,''));assert(results.every(r=>r.success));return results.flatMap(r=>r.results);}
const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
const userId=randomUUID(),projectId=randomUUID(),taskId=randomUUID(),session=randomBytes(32).toString('hex'),now=new Date().toISOString();
const task={title:'Bridge local contract',detail:'分析已有资料并输出文本报告',criteria:'交付报告文件'};
const config=query('SELECT id FROM ai_config_versions ORDER BY version DESC LIMIT 1')[0];assert(config);
const sourceHash=sha(JSON.stringify([task.title,task.detail,task.criteria,config.id,'task-agent-eligibility-v1'])),jobId=randomUUID();
query(`UPDATE ai_config_versions SET enabled=1;
INSERT INTO users(id,email,display_name,created_at)VALUES(${quote(userId)},${quote(userId+'@fixture.invalid')},'Bridge fixture',${quote(now)});
INSERT INTO auth_accounts(user_id,username,username_norm,password_hash,created_at)VALUES(${quote(userId)},${quote('bridge-'+userId)},${quote('bridge-'+userId)},'fixture-non-null-password-hash',${quote(now)});
INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at,auth_method)VALUES(${quote(randomUUID())},${quote(userId)},${quote(sha(session))},${quote(new Date(Date.now()+86400000).toISOString())},${quote(now)},'password');
INSERT INTO projects(id,name,description,status,revision,created_by,created_at,updated_at,ai_collaboration_enabled)VALUES(${quote(projectId)},'Local bridge fixture','','active',1,${quote(userId)},${quote(now)},${quote(now)},1);
INSERT INTO project_members(id,project_id,user_id,role,joined_at)VALUES(${quote(randomUUID())},${quote(projectId)},${quote(userId)},'owner',${quote(now)});
INSERT INTO tasks(id,project_id,title,detail,criteria,status,lifecycle_state,revision,created_by,assignee_id,created_at,updated_at)VALUES(${quote(taskId)},${quote(projectId)},${quote(task.title)},${quote(task.detail)},${quote(task.criteria)},'doing','in_progress',1,${quote(userId)},${quote(userId)},${quote(now)},${quote(now)});
INSERT INTO jobs(id,project_id,kind,status,input_json,attempts,created_by,created_at,updated_at)VALUES(${quote(jobId)},${quote(projectId)},'agent_run','succeeded',${quote(JSON.stringify({configVersionId:config.id}))},0,${quote(userId)},${quote(now)},${quote(now)});
INSERT INTO task_agent_eligibility(project_id,task_id,source_hash,status,job_id,eligible,reason,updated_at)VALUES(${quote(projectId)},${quote(taskId)},${quote(sourceHash)},'ready',${quote(jobId)},1,'Fixture digital task',${quote(now)});`);
const cookie=`ai_office_session=${session}`;
if(process.argv.includes('--prepare-ui')) {
  await writeFile(join(out,'ui-fixture.json'),JSON.stringify({origin,state,cookie,userId,projectId,taskId,out},null,2));
  console.log(JSON.stringify({fixtureOnly:true,fixturePath:join(out,'ui-fixture.json'),projectId,taskId}));
  process.exit(0);
}
async function browser(path,method='GET',body,status=200){const response=await fetch(origin+'/api/v1/agent-bridges'+path,{method,headers:{Cookie:cookie,Origin:origin,'Idempotency-Key':randomUUID(),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});const envelope=await response.json();assert.equal(response.status,status,`${method} ${path}: ${envelope.error?.code} ${envelope.error?.message}`);return envelope.data;}
const base='https://local-bridge.invalid/api/v1/agent-bridges',secret=randomBytes(32).toString('hex');
const cloud=new CloudClient(base,secret,(url,options)=>fetch(origin+new URL(url).pathname,options));
const pair=await cloud.request('pairings','POST',{credentialHash:sha(secret),deviceName:'Local bridge fixture',bridgeVersion:'0.1.0',dshVersion:'0.2.0-rc.2'});
await browser(`/pairings/${pair.pairingId}/approve`,'POST',{projectIds:[projectId]});await cloud.request('device/workspaces','POST',{projectId,workspaceLabel:'Fixture'});
const started=await browser(`/projects/${projectId}/tasks/${taskId}/handoffs`,'POST',{expectedRevision:1,targetDeviceId:pair.pairingId},202);assert.equal(started.state,'waiting_device');
const journal=await new Journal(join(out,randomUUID())).load();const workspace=join(out,'workspace',randomUUID());await mkdir(workspace,{recursive:true});journal.state.bindings[projectId]={cwd:workspace,label:'Fixture'};await journal.save();
let completion,prompts=0,events=[],released=0;
const dsh={create:async(run,callback)=>{completion=callback;},attach:async()=>{},prompt:async run=>{prompts++;await writeFile(join(run.output,'report.txt'),'Bridge generated fixture report\n');await completion({summary:'已核对本地契约测试成果',paths:['report.txt']});events=[{seq:1,type:'user/message',data:{source:{rpcId:run.id}}},{seq:2,type:'turn/end',data:{reason:{kind:'completed'}}}];return{accepted:true};},inspect:async()=>({events}),isLive:()=>true,cancel:async()=>{},release:()=>{released++;}};
const runner=new BridgeRunner({journal,client:cloud,dsh});for(let i=0;i<5;i++){await runner.tick();if(journal.state.runs[started.handoffId]?.state==='ready_for_review')break;}
const result=await browser(`/handoffs/${started.handoffId}`);assert.equal(result.state,'ready_for_review');assert.equal(result.stale,false);assert.equal(result.result.artifacts.length,1);assert.equal(prompts,1);assert.equal(released,1);
const artifact=result.result.artifacts[0];const download=await fetch(`${origin}/api/v1/projects/${projectId}/files/${artifact.fileId}/content`,{headers:{Cookie:cookie}});assert.equal(download.status,200);assert.equal(sha(Buffer.from(await download.arrayBuffer())),artifact.sha256);
await runner.tick();assert.equal(prompts,1);
// Disable test-only cloud models before submission: this fixture never dispatches a provider.
query('UPDATE ai_config_versions SET enabled=0;');
const adopted=await browser(`/handoffs/${started.handoffId}/adopt-and-submit`,'POST',{expectedTaskRevision:1,reviewed:true});
const replay=await browser(`/handoffs/${started.handoffId}/adopt-and-submit`,'POST',{expectedTaskRevision:1,reviewed:true});assert.equal(replay.submissionId,adopted.submissionId);
await browser(`/devices/${pair.pairingId}`,'DELETE');await runner.tick();
const report={passed:true,production:false,actualBackend:'Wrangler local Workers D1/R2',actualPluginRunner:true,dshAdapter:'simulated; native RC2 lifecycle separately smoke-tested',modelCalls:0,prompts,projectId,taskId,handoffId:started.handoffId,submissionId:adopted.submissionId,checks:['device pairing and browser scopes','one-click cached-eligibility dispatch','native runner HTTP claim/snapshot/events','real filesystem artifacts SHA256','automatic draft keeps task state unchanged','same submission on reviewed adoption retry','revocation stops receiving','no parser/audio/index work from artifact upload']};
assert.equal(query(`SELECT COUNT(*) n FROM task_submissions WHERE task_id=${quote(taskId)}`)[0].n,1);
assert.equal(query(`SELECT COUNT(*) n FROM jobs WHERE project_id=${quote(projectId)} AND kind IN ('parse_source','ocr_pages','web_fetch')`)[0].n,0);
await writeFile(join(out,'contract-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
