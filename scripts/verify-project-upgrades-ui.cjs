// Real React app + Chromium with synthetic intercepted APIs. No DB or model calls.
// Run against an already-started frontend: UI_ORIGIN=http://127.0.0.1:5173 node scripts/verify-project-upgrades-ui.cjs
// UI_PLAYWRIGHT_PATH / UI_CHROMIUM_PATH can select existing bundled dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.UI_PLAYWRIGHT_PATH || 'playwright');
const origin = process.env.UI_ORIGIN || 'http://127.0.0.1:5173';
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw new Error('Use a loopback frontend origin');
const output = path.resolve(process.env.UI_EVIDENCE_DIR || path.join(__dirname, '../output/project-upgrades-ui'));
const now = '2026-10-04T00:00:00.000Z';
const user = { id: 'fixture-user', username: 'local_fixture', displayName: '本地测试负责人', email: null, role: 'user', isAdmin: false };
const projects = ['ready', 'blocked', 'empty'].map(id => ({ id, projectId:id, name: `测试项目 ${id}`, description:'合成项目说明', myRole:'owner', status:'active', revision:1, deadlineDate:null, deadlinePrecision:'unknown', createdAt:now, updatedAt:now }));
const goal = { title:'合成项目目标', detail:'项目目标详细说明', revision:1, graphRevision:1 };
const preview = { projectId:'ready', projectName:'测试项目 ready', description:'接受之前可见的介绍', goal:{title:'接受之前可见的目标', detail:'接受之前可见的目标说明'} };
const task = (taskId, changes={}) => ({taskId,title:taskId,detail:'',criteria:'测试完成条件',effortHours:1,status:'doing',lifecycleState:'in_progress',assigneeId:user.id,revision:1,dueDate:null,duePrecision:'unknown',dependsOnTaskIds:[],unfinishedDependencyIds:[],currentSubmissionId:null,citations:[],createdAt:now,updatedAt:now,...changes});
const bgVersion = {versionId:'bg-version',revision:1,doc:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'合成系统背景正文'}]}]},markdown:'合成系统背景正文',attachments:[],origin:'system',authorId:user.id,createdAt:now};
const background = {materialId:'background',title:'系统背景',kind:'background',purpose:'background',systemManaged:true,canEdit:false,revision:1,currentVersionId:'bg-version',currentVersion:bgVersion,createdAt:now,updatedAt:now};
const capabilities = {environment:'local-fixture',apiVersion:'v1',features:{aiEnabled:false,webFetch:false,emailMode:'disabled'},limits:{maxFileBytes:10485760,maxMediaFileBytes:52428800,maxPdfPages:30,pageImageMaxEdge:2000,pageImageMaxBytes:2097152,listDefaultPageSize:20,listMaxPageSize:100,concurrentAiTasksPerProject:2},competitionTemplate:{teamSizeLimit:null}};

async function installFixture(context, requests) {
  let usernameStatus='pending';
  let currentGoal={...goal};
  await context.route('**/*', async route => {
    const req=route.request(), url=new URL(req.url());
    if (url.origin !== new URL(origin).origin) return route.abort();
    if (!url.pathname.startsWith('/api/v1/')) return route.continue();
    const p=url.pathname, method=req.method();
    requests.push({path:p,method,body:method==='GET' ? null : req.postDataJSON()});
    let data={items:[],nextCursor:null,nextOffset:null};
    if (p==='/api/v1/auth/session') data={user};
    else if (p==='/api/v1/capabilities') data=capabilities;
    else if (p==='/api/v1/projects') data={items:projects,nextCursor:null};
    else if (p==='/api/v1/invitations/inbox') data={items:[{id:'username-invite',projectId:'ready',projectName:'用户名邀请项目',inviterName:'邀请者',username:user.username,role:'member',status:usernameStatus,expiresAt:'2099-12-31T00:00:00Z',createdAt:now}],nextOffset:null};
    else if (p==='/api/v1/invitations/preview' || p.endsWith('/username-invite/preview')) data=preview;
    else if (p==='/api/v1/invitations/accept') data={projectId:'ready',projectName:preview.projectName};
    else if (p==='/api/v1/invitations/inbox/username-invite') {usernameStatus=req.postDataJSON().action==='accept'?'accepted':'declined';data={id:'username-invite',status:usernameStatus,projectId:'ready'};}
    else if (p.endsWith('/members/me')) data={userId:user.id,role:'owner',displayName:user.displayName};
    else if (p.endsWith('/members')) data={items:[{userId:user.id,role:'owner',displayName:user.displayName,joinedAt:now}],nextCursor:null};
    else if (p.endsWith('/tasks')) data={items:p.includes('/ready/')?[task('可完成任务')]:p.includes('/blocked/')?[task('受阻任务',{status:'blocked'})]:[],nextCursor:null};
    else if (p.endsWith('/goal')) {if(method==='PATCH')currentGoal={...currentGoal,...req.postDataJSON(),revision:currentGoal.revision+1};data=currentGoal;}
    else if (p.endsWith('/collaboration/settings')) data={revision:1,aiCollaborationEnabled:true,planningMode:'auto',assignmentMode:'auto',evaluationMode:'auto',progressionMode:'auto'};
    else if (p.endsWith('/resource-library')) data={items:[{resourceType:'material',resourceId:'background',title:'系统背景',purpose:'background',systemManaged:true,canManage:false,canEdit:false,revision:1,currentVersionId:'bg-version',createdAt:now,updatedAt:now}],nextCursor:null};
    else if (p.endsWith('/materials')) data={items:[background],nextCursor:null};
    else if (p.endsWith('/materials/background')) data=background;
    else if (p.endsWith('/materials/background/versions')) data={items:[bgVersion],nextCursor:null};
    else if (p.endsWith('/versions/bg-version')) data=bgVersion;
    else if (/^\/api\/v1\/projects\/[^/]+$/.test(p)) data=projects.find(project=>project.id===p.split('/').at(-1)) || projects[0];
    else if (method !== 'GET') throw new Error(`Unexpected fixture mutation: ${method} ${p}`);
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data,requestId:'project-upgrades-ui-fixture'})});
  });
}

async function verify() {
  fs.mkdirSync(output,{recursive:true});
  const report={source:'Real React and Chromium; synthetic API interception; no production or model requests',checks:[],errors:[],requests:[]};
  const browser=await chromium.launch({headless:true,...(process.env.UI_CHROMIUM_PATH?{executablePath:process.env.UI_CHROMIUM_PATH}:{})});
  try {
    for(const width of [1440,390]) {
      const requests=[];
      const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
      await installFixture(context,requests);
      const page=await context.newPage();
      page.on('pageerror',error=>report.errors.push(error.message));
      const accepts=()=>requests.filter(r=>r.path==='/api/v1/invitations/accept'||r.path==='/api/v1/invitations/inbox/username-invite');
      await page.goto(origin+'/app/join?code=synthetic-invitation-code');
      await page.getByRole('button',{name:'查看邀请详情',exact:true}).click();
      await page.getByText(preview.goal.detail,{exact:true}).waitFor();
      assert.equal(accepts().length,0,'Code preview must not accept');
      await page.screenshot({path:path.join(output,`code-preview-${width}.png`),fullPage:true});
      await page.getByLabel('邀请代码',{exact:true}).fill('different-invitation-code');
      assert.equal(await page.getByRole('button',{name:'确认接受并加入',exact:true}).count(),0,'Changing code clears preview');
      await page.getByRole('button',{name:'查看邀请详情',exact:true}).click();
      await page.getByRole('button',{name:'取消预览',exact:true}).click();
      assert.equal(accepts().length,0,'Cancel must not accept');
      await page.getByRole('button',{name:'查看邀请详情',exact:true}).click();
      await page.getByRole('button',{name:'确认接受并加入',exact:true}).click();
      await page.waitForURL('**/app/projects/ready');
      assert.equal(accepts().length,1);
      assert.equal(accepts()[0].body.code,'different-invitation-code');
      report.checks.push({width,name:'Code preview, cancellation, code edit and explicit acceptance',passed:true});

      await page.goto(origin+'/app/join');
      await page.getByRole('button',{name:'接受邀请',exact:true}).click();
      await page.getByText(preview.description,{exact:true}).waitFor();
      assert.equal(accepts().length,1,'Username preview must not accept');
      await page.screenshot({path:path.join(output,`username-preview-${width}.png`),fullPage:true});
      await page.getByRole('button',{name:'确认接受并加入',exact:true}).click();
      await page.getByText(/已接受/).waitFor();
      assert.equal(accepts().length,2);
      assert.equal(accepts()[1].body.action,'accept');
      report.checks.push({width,name:'Username project details before acceptance',passed:true});

      await page.goto(origin+'/app');
      const attention=page.getByRole('complementary',{name:'待响应事项'});
      await attention.getByText('可完成任务',{exact:true}).waitFor();
      assert.equal(await attention.locator('.dashboard-attention-project').count(),1);
      assert.equal(await attention.getByText('测试项目 blocked',{exact:true}).count(),0);
      assert.equal(await attention.getByText('测试项目 empty',{exact:true}).count(),0);
      await page.screenshot({path:path.join(output,`dashboard-${width}.png`),fullPage:true});
      report.checks.push({width,name:'Dashboard excludes projects with no actionable tasks',passed:true});

      await page.goto(origin+'/app/projects/ready/settings');
      const title=page.getByLabel('主目标',{exact:true});
      await title.fill('浏览器更新的主目标');
      const savedGoal=page.waitForResponse(response=>response.url().endsWith('/goal')&&response.request().method()==='PATCH');
      await page.getByRole('button',{name:'保存项目目标',exact:true}).click();
      await savedGoal;
      await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='保存项目目标')?.disabled);
      const goalWrite=requests.find(r=>r.path.endsWith('/goal')&&r.method==='PATCH');
      assert.equal(goalWrite.body.expectedRevision,1);
      assert.equal(goalWrite.body.title,'浏览器更新的主目标');
      await page.screenshot({path:path.join(output,`goal-settings-${width}.png`),fullPage:true});
      report.checks.push({width,name:'Owner saves project goal with revision',passed:true});

      await page.goto(origin+'/app/projects/ready/data?resourceType=material&resourceId=background');
      await page.getByText('系统背景 · 自动同步',{exact:true}).waitFor();
      assert.equal(await page.getByRole('button',{name:'保存新版本',exact:true}).count(),0);
      assert.equal(await page.getByLabel('修改资料用途',{exact:true}).count(),0);
      assert.equal(await page.locator('[contenteditable=true]').count(),0);
      await page.screenshot({path:path.join(output,`system-background-${width}.png`),fullPage:true});
      report.checks.push({width,name:'System background has no editor or purpose mutation controls',passed:true});
      assert.equal(await page.locator('vite-error-overlay').count(),0);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Horizontal overflow');
      report.requests.push(...requests.map(request=>({...request,width})));
      await context.close();
    }
    assert.deepEqual(report.errors,[]);
    report.result='PASS';
  } finally {await browser.close();fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));}
  console.log(JSON.stringify({result:report.result,checks:report.checks.length,output},null,2));
}
if(require.main===module)verify().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={verify,installFixture};
