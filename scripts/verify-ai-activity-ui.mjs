/** Built React UI acceptance against deterministic local API fixtures; never calls a model. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const require=createRequire(import.meta.url);
const { chromium }=require(process.env.PLAYWRIGHT_MODULE || '/Users/hddhp/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin=process.argv[2]||'http://127.0.0.1:4173';
assert(['127.0.0.1','localhost'].includes(new URL(origin).hostname));
const output=resolve('output/ai-activity/browser');await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const projectId='11111111-1111-4111-8111-111111111111',userId='22222222-2222-4222-8222-222222222222',now='2026-10-07T00:00:05Z';
const task={taskId:'t1',title:'整理研究资料',detail:'分析已有项目资料',criteria:'证据完整',effortHours:4,revision:1,assigneeId:userId,lifecycleState:'in_progress',status:'doing',dependsOnTaskIds:[],unfinishedDependencyIds:[],currentSubmissionId:null,citations:[],createdAt:now,updatedAt:now};
const report={fixtureOnly:true,realModelInvoked:false,checks:[],screenshots:[],errors:[]};
let activePage;
try{
 for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block',reducedMotion:'reduce'}),page=await context.newPage();activePage=page;page.setDefaultTimeout(15000);page.on('pageerror',e=>report.errors.push(e.message));
  let status='failed',id='job-failed',resumes=0,modelStarts=0,failRead=false;
  const activity=()=>({code:status==='failed'?'summarizing':status==='running'?'summarizing':'completed',updatedAt:now,lastResponseAt:now,progress:{completed:3,total:5,unit:'chunk'},canResume:status==='failed',resumeReason:null,uncertain:status==='failed'});
  await context.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url()),p=u.pathname,m=req.method();if(u.origin!==new URL(origin).origin)return route.abort();if(!p.startsWith('/api/'))return route.continue();let data={items:[],nextCursor:null};
   if(p.endsWith('/auth/session'))data={user:{id:userId,username:'fixture',displayName:'测试成员',role:'user',isAdmin:false}};
   else if(p.endsWith('/capabilities'))data={features:{aiEnabled:true},limits:{maxFileBytes:20000000},competitionTemplate:{}};
   else if(p===`/api/v1/projects/${projectId}`)data={projectId,name:'AI 活动验收',description:'本地固定数据',status:'active',myRole:'owner',revision:1};
   else if(p.endsWith('/members/me'))data={userId,displayName:'测试成员',role:'owner'};
   else if(p.endsWith('/members'))data={items:[{userId,displayName:'测试成员',role:'owner'}],nextCursor:null};
   else if(p.endsWith('/goal'))data={title:'交付研究成果',detail:'整理资料',revision:1,graphRevision:1};
   else if(p.endsWith('/tasks/graph'))data={items:[task],graphRevision:1,canRegenerate:false,totals:{total:1,done:0}};
   else if(p.endsWith('/tasks'))data={items:[task],nextCursor:null};
   else if(p.endsWith('/collaboration/settings'))data={aiCollaborationEnabled:true,assignmentMode:'manual',evaluationMode:'manual',revision:1};
   else if(p.endsWith('/collaboration/feedback/current'))data={version:0,feedback:''};
   else if(p.endsWith('/standards/current'))data={standard:null,generatedJobId:null,activity:null};
   else if(p.endsWith('/collaboration/ai-activity'))data={jobId:null,activity:null};
   else if(p.endsWith('/agent-eligibility'))data={status:'ready',taskRevision:1,sourceHash:'fixture',eligible:false,reason:'需要人工核验',jobId:null};
   else if(p.endsWith('/assistance-plan')){if(m==='POST')modelStarts++;data={status:status==='succeeded'?'ready':status,taskRevision:1,sourceHash:'fixture',plan:status==='succeeded'?{markdown:'## 已完成计划\n已复用前三块，完成剩余两块。',generatedAt:now,sourceHash:'fixture',stale:false}:null,jobId:id,error:status==='failed'?'第四块处理失败':null};}
   else if(p.endsWith('/activity-events')){const cursor=Number(u.searchParams.get('cursor')||0);data={items:cursor?[]:[{id:1,code:'summarizing',state:'completed',at:now,progress:{completed:3,total:5,unit:'chunk'}},{id:2,code:status==='succeeded'?'completed':'summarizing',state:status==='succeeded'?'completed':'failed',at:now,progress:{completed:3,total:5,unit:'chunk'}}],nextCursor:null};}
   else if(p.startsWith('/api/v1/jobs/')){
    if(m==='POST'){assert(p.endsWith('/retry'));resumes++;id='job-resumed';status='running';data={jobId:id};}
    else if(failRead){failRead=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'INTERNAL',message:'模拟状态读取失败'},requestId:'fixture'})});}
    else data={jobId:id,kind:'agent_run',status,result:null,error:status==='failed'?{code:'AI_UNAVAILABLE',message:'第四块处理失败'}:null,attempts:1,createdAt:now,updatedAt:now,finishedAt:status==='succeeded'?now:null,activity:activity()};
   }
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data,requestId:'fixture'})});
  });
  const open=async()=>{await page.locator('.collab-task').getByRole('button',{name:'AI 辅助',exact:true}).click();await page.getByRole('dialog').getByRole('heading',{name:'辅助计划',exact:true}).waitFor();};
  await page.goto(origin+`/app/projects/${projectId}/tasks`);await open();
  const panel=page.getByRole('dialog').getByRole('region',{name:'AI 处理状态'});
  await panel.getByText('失败',{exact:true}).waitFor();await panel.getByText(/AI 最后一次回复时间/).waitFor();assert.match(await panel.locator('time').first().textContent(),/\d{2}:\d{2}:\d{2}/);
  await panel.getByText('操作记录',{exact:true}).click();await panel.getByText('总结资料 · 完成',{exact:false}).waitFor();
  assert.match(await panel.textContent(),/可能再次计费/);
  const failedShot=resolve(output,`${width}-failed.png`);await page.screenshot({path:failedShot,fullPage:true});report.screenshots.push(failedShot);
  await panel.getByRole('button',{name:'从停止处继续'}).click();await panel.getByText('AI 处理中',{exact:true}).waitFor();assert.equal(resumes,1);assert.equal(modelStarts,0);
  assert.equal(await panel.locator('.is-running').count(),1);
  failRead=true;await panel.getByText('读取状态失败，保留最近一次已知状态。').waitFor();assert.match(await panel.locator('time').first().textContent(),/\d{2}:\d{2}:\d{2}/);await panel.getByRole('button',{name:'重试',exact:true}).click();await panel.getByText('读取状态失败，保留最近一次已知状态。').waitFor({state:'hidden'});assert.equal(resumes,1);
  status='succeeded';await panel.getByText('已完成',{exact:true}).first().waitFor();
  assert.equal(await panel.locator('.is-running').count(),0);assert.match(await panel.textContent(),/AI 最后一次回复时间/);
  await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();await page.reload();await open();await page.getByRole('dialog').getByRole('region',{name:'AI 处理状态'}).getByText('已完成',{exact:true}).first().waitFor();assert.equal(resumes,1);assert.equal(modelStarts,0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const completeShot=resolve(output,`${width}-completed-reloaded.png`);await page.screenshot({path:completeShot,fullPage:true});report.screenshots.push(completeShot);
  report.checks.push({width,passed:true,resumes,modelStarts,verified:['reply seconds','current block','history','direct uncertain resume','running animation','terminal no animation','reload recovery','read error retry without execution','no horizontal overflow','reduced motion']});await context.close();
 }
 assert.deepEqual(report.errors,[]);console.log(JSON.stringify(report,null,2));
}catch(error){if(activePage){console.error(await activePage.locator('body').innerText());await activePage.screenshot({path:resolve(output,'error.png'),fullPage:true});}throw error;}finally{await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));await browser.close();}
