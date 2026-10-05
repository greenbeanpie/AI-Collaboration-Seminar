/** Local fixture-only browser acceptance. Never contacts a model or production backend.
 * node scripts/verify-ui-regressions.mjs [preview-url] [absolute-output-directory]
 */
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/hmz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin = process.argv[2] || 'http://127.0.0.1:5175';
assert(['localhost','127.0.0.1'].includes(new URL(origin).hostname),'Only a local preview is supported');
const out = resolve(process.argv[3] || 'output/ui-regressions');
await mkdir(out,{recursive:true});
const id='11111111-1111-4111-8111-111111111111', userId='22222222-2222-4222-8222-222222222222', standardId='33333333-3333-4333-8333-333333333333', assessmentId='44444444-4444-4444-8444-444444444444', now='2026-10-03T09:00:00.000Z';
const base=`/app/projects/${id}`;
const result={preview:origin,fixtureOnly:true,startedAt:new Date().toISOString(),checks:[],screenshots:[],errors:[],requests:[]};
const browser=await chromium.launch({headless:true,executablePath:process.env.EDGE_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
async function scenario(name,role,run,scoreCorrect=false,accountRole=role==='admin'?'super_admin':'user'){
  const context=await browser.newContext({viewport:{width:1440,height:1100},serviceWorkers:'block'});
  const page=await context.newPage();page.setDefaultTimeout(8000);
  const fixtureTask={taskId:'88888888-8888-4888-8888-888888888888',title:'样本采集',detail:'记录样本日期和来源',criteria:'提交三条真实样本',effortHours:1,revision:6,assigneeId:userId,lifecycleState:'in_progress',status:'doing',dependsOnTaskIds:[],unfinishedDependencyIds:[],currentSubmissionId:null,createdAt:now,updatedAt:now};
  const state={taskFiles:[],uploaded:[],taskRows:(name.startsWith('task-settings')||name.startsWith('task-files')||name.startsWith('submission-'))?[fixtureTask,{...fixtureTask,taskId:'99999999-9999-4999-8999-999999999999',title:'来源说明',assigneeId:null,lifecycleState:'open'}]:[],feedback:{version:1,versionId:'feedback-1',feedback:'已保存的持续反馈',createdAt:now},invitations:role==='owner'||role==='manager'?[{id:'invite-1',username:'pending-member',requestedBy:userId,status:'pending',revision:1,createdAt:now}]:[],writes:[],config:null};
  const permissions={teamManage:role==='owner'||role==='manager',taskManage:role==='owner'||role==='manager',resourceManage:role==='owner'||role==='manager',scoreInitiate:true,scoreCorrect:role==='owner'||role==='manager'||scoreCorrect};
  const project={projectId:id,name:'浏览器验证项目',description:'仅本地 HTTP fixtures',revision:1,status:'active',myRole:role==='owner'?'owner':'member',permissions,canManagePermissions:role==='owner',createdAt:now,updatedAt:now,deadlineDate:'2026-10-30',deadlinePrecision:'date'};
  const member={memberId:'member-1',userId,displayName:role==='owner'||role==='manager'?'管理员':'普通成员',username:'fixture-user',email:null,role:project.myRole,isAdmin:accountRole!=='user',permissions,canManagePermissions:role==='owner',permissionsRevision:1};
  const rubric={weights:[{key:'quality',label:'质量',weight:100}]};
  const standard={standardsVersionId:standardId,title:'已确认标准',version:1,revision:1,status:'confirmed',rubric:{...rubric,notes:'不应显示的长说明'},mappings:name==='standards-compact'?[{requirementId:'r1',dimensionKey:'quality'}]:[],requirements:name==='standards-compact'?[{requirementId:'r1',title:'不应显示的要求',detail:'不应显示的详情',dueDate:'2026-12-07',citations:[{sourceVersionId:'66666666-6666-4666-8666-666666666666',fragmentId:'fragment',fileId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',fileName:'标准通知.pdf',sourceId:'source-1',quote:'不应显示的原文'}]}]:[],createdAt:now};
  if(name.startsWith('submission-'))Object.assign(state.taskRows[0],{lifecycleState:'accepted',status:'done',currentSubmissionId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'});
  const assessment={assessmentId,kind:'material_review',status:'succeeded',historical:false,revision:1,origin:'ai',standardsVersionId:standardId,standardsVersion:1,goalRevision:1,goal:{title:'验证主目标',detail:'左侧目标详细说明'},materialVersionIds:[],rehearsalId:null,createdAt:now,report:{kind:'assistive',status:'scored',scores:[{key:'quality',label:'质量',score:80,comment:'已有真实评分',confidence:0.8,evidence:[]}],weightedTotal:80,summary:'已有评分记录',requirementChecks:[],limitations:[]}};
  page.on('pageerror',error=>result.errors.push({scenario:name,message:error.message}));
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!==new URL(origin).origin){await route.abort();return;}
    if(!url.pathname.startsWith('/api/')){await route.continue();return;}
    const path=url.pathname,method=route.request().method(),body=route.request().headers()['content-type']?.includes('application/json')?route.request().postDataJSON():null;
    result.requests.push({scenario:name,path,method});
    if(method!=='GET')state.writes.push({path,method,body});
    let data={items:[],nextCursor:null};
    if(path==='/api/v1/auth/session')data={user:{id:userId,username:'fixture-user',displayName:member.displayName,email:null,isAdmin:accountRole!=='user',role:accountRole}};
    else if(path==='/api/v1/capabilities')data={features:{aiEnabled:true,uploadsEnabled:true},competitionTemplate:{teamSizeLimit:10},authentication:{mode:'password'}};
    else if(path==='/api/v1/notifications/settings')data={inAppEnabled:false,pushEnabled:false};
    else if(path==='/api/v1/notifications/push/status')data={configured:false};
    else if(path==='/api/v1/notifications')data={items:[],nextCursor:null,unreadCount:0};
    else if(path==='/api/v1/admin/ai-config'){
      if(method==='PUT'){state.config=body;data={version:2,enabled:false};}
      else data={config:{},version:0,enabled:false};
    }
    else if(path===`/api/v1/projects/${id}`)data=project;
    else if(path.endsWith('/members/me'))data=member;
    else if(path.endsWith('/members'))data={items:[member,{...member,userId:'77777777-7777-4777-8777-777777777777',displayName:'管理员账号成员',role:'member',isAdmin:true,permissions:{teamManage:false,taskManage:false,resourceManage:false,scoreInitiate:false,scoreCorrect:false},canManagePermissions:false}],nextCursor:null};
    else if(path.endsWith('/goal'))data={title:'验证主目标',detail:'左侧目标详细说明',revision:1,graphRevision:1};
    else if(path.endsWith('/files')&&method==='POST'&&!path.includes('/tasks/')){const fileId=crypto.randomUUID();state.uploaded.push({fileId,name:body.fileName});data={fileId,upload:{method:'PUT',url:'/api/v1/projects/'+id+'/files/'+fileId+'/content'}};}
    else if(path.includes('/files/')&&path.endsWith('/content')&&method==='PUT')data={fileId:path.split('/').at(-2),sizeBytes:10,sha256:'fixture-hash',mimeDetected:'text/plain'};
    else if(path.endsWith('/tasks/'+fixtureTask.taskId+'/files')){if(method==='POST'){const raw=state.uploaded.find(file=>file.fileId===body.fileId);const file={...raw,materialId:crypto.randomUUID(),taskId:fixtureTask.taskId,revision:1,versionId:crypto.randomUUID(),archivedAt:null,materialArchivedAt:null,lifecycleVersion:1,canManage:true};state.taskFiles.push(file);data=file;}else data={items:state.taskFiles};}
    else if(path.includes('/files/')&&(path.endsWith('/archive')||path.endsWith('/unarchive'))){const file=state.taskFiles.find(file=>path.includes(file.fileId));file.archivedAt=path.endsWith('/unarchive')?null:now;file.lifecycleVersion++;data=file;}
    else if(path.endsWith('/resource-library'))data={items:state.taskFiles.filter(file=>url.searchParams.get('archived')==='true'?file.archivedAt:!file.archivedAt).map(file=>({...file,resourceId:file.materialId,resourceType:'material',title:file.name,purpose:'output',currentVersionId:file.versionId,createdAt:now,updatedAt:now,deletedAt:null,canManage:true})),nextCursor:null};
    else if(path.endsWith('/files'))data={items:[],nextCursor:null};
    else if(path.endsWith('/tasks'))data={items:state.taskRows,nextCursor:null};
    else if(path.endsWith('/task-inquiries/unread'))data={items:name.startsWith('task-settings')?[{taskId:fixtureTask.taskId,unreadCount:2}]:[]};
    else if(path.endsWith('/inquiries/read'))data={readCount:1};
    else if(path.endsWith('/inquiries'))data={items:[],candidates:[]};
    else if(path.endsWith('/dependencies')){state.taskRows[0].dependsOnTaskIds=body.dependsOnTaskIds;data={graphRevision:2};}
    else if(state.taskRows.some(task=>path.endsWith('/tasks/'+task.taskId))){const task=state.taskRows.find(task=>path.endsWith('/tasks/'+task.taskId));if(method==='PATCH'){Object.assign(task,body);task.revision++;}data=task;}
    else if(path.endsWith('/agent-eligibility'))data={status:'unavailable',eligible:false,reason:'本地验证不调用 AI'};
    else if(path.endsWith('/collaboration/settings'))data={revision:1,aiCollaborationEnabled:true,assignmentMode:'manual',acceptanceMode:'manual',rubricMode:'manual'};
    else if(path.endsWith('/collaboration/feedback/current')){
      if(method==='POST')state.feedback={...state.feedback,feedback:body.feedback,version:state.feedback.version+1};
      data=state.feedback;
    }
    else if(path.endsWith('/collaboration/feedback/history'))data={items:[state.feedback]};
    else if(path.endsWith('/collaboration/decompose'))data={jobId:'55555555-5555-4555-8555-555555555555'};
    else if(path.endsWith('/jobs/scoring-fixture'))data={jobId:'scoring-fixture',status:'succeeded',result:{scoringOutputVersion:2,methodSource:'documented',draft:{title:'项目评分标准',notes:'',weights:[{key:'quality',label:'质量',weight:100}],requirements:[{title:'质量',detail:'',category:'scoring',dimensionKey:'quality',dueDate:null,duePrecision:'unknown',citations:[{sourceVersionId:'66666666-6666-4666-8666-666666666666',fragmentId:'frag',pageNumber:1,quote:'质量100分',fileName:'标准通知.pdf',fileId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}]}]}}};
    else if(path.startsWith('/api/v1/jobs/'))data={jobId:path.split('/').at(-1),status:'succeeded',attempts:1,feedbackSnapshot:state.feedback,createdAt:now,updatedAt:now};
    else if(path.endsWith('/ai-tools/capabilities'))data={fileTools:true,search:{supported:false,reason:'管理员尚未启用互联网搜索'},searchCost:'unknown'};
    else if(path.endsWith('/ai/clarifications'))data={items:[]};
    else if(path.endsWith('/invitation-requests')){
      if(method==='POST')state.invitations.push({id:'invite-1',username:body.username,requestedBy:userId,status:'pending',revision:1,createdAt:now});
      data={items:state.invitations};
    }
    else if(path.endsWith('/invitation-requests/invite-1/decide')){state.invitations[0].status=body.action==='approve'?'approved':'rejected';data=state.invitations[0];}
    else if(path.endsWith('/sources'))data={items:[{sourceId:'source-1',title:'本地参考通知',currentVersionId:'66666666-6666-4666-8666-666666666666'}],nextCursor:null};
    else if(path.endsWith('/standards/generate')&&name==='error-verbatim'){await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:{code:'INTERNAL',message:'原始后端原因：评分方法来源已变化\n请重新选择原文件',retryable:false},requestId:'deadbeef-dead-4eef-8eef-deadbeefdead'})});return;}
    else if(path.endsWith('/standards/generate'))data={jobId:'scoring-fixture'};
    else if(path.endsWith('/standards/current'))data={standard};
    else if(path.endsWith('/standards'))data={items:[standard]};
    else if(path.endsWith('/submissions'))data={items:name.startsWith('submission-')?[{submissionId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',taskId:fixtureTask.taskId,round:1,submittedBy:userId,body:'完整成果正文'+ '内容'.repeat(1000)+'末尾完整文本',materialVersionIds:[],criteria:'固定标准',status:'accept',decision:'accept',feedback:'通过理由',aiDecision:null,aiReport:null,revision:1,createdAt:now}]:[]};
    else if(path.endsWith('/assessments'))data={items:[assessment],nextCursor:null};
    else if(path.endsWith(`/assessments/${assessmentId}`))data=assessment;
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data,requestId:'fixture-only'})});
  });
  const screenshot=async suffix=>{const path=resolve(out,`${name}-${suffix}.png`);await page.screenshot({path,fullPage:true});result.screenshots.push(path);};
  try{await run({page,state,screenshot});result.checks.push({name,passed:true});}
  catch(error){await screenshot('failure');result.checks.push({name,passed:false,error:error.stack});}
  finally{await context.close();}
}
try{
  await scenario('ordinary-invitation','member',async({page,state,screenshot})=>{
    await page.goto(origin+base+'/team');
    await page.getByRole('heading',{name:'按用户名申请邀请组员'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'创建邀请码'}).count(),0);
    assert.equal(await page.getByRole('button',{name:'发送项目邀请',exact:true}).count(),0);
    await page.getByLabel('完整用户名',{exact:true}).fill('new-member');
    await page.getByRole('button',{name:'报请管理员批准'}).click();
    await page.getByText('申请已提交，等待管理员批准。').waitFor();
    assert(state.writes.some(item=>item.path.endsWith('/invitation-requests')&&item.body.username==='new-member'));
    assert(!state.writes.some(item=>item.path.endsWith('/invitations')));
    await screenshot('pending');
  });
  await scenario('team-manager-invitation','manager',async({page,state,screenshot})=>{
    await page.goto(origin+base+'/team');
    await page.getByRole('button',{name:'创建邀请码'}).waitFor();
    await page.getByRole('heading',{name:'成员邀请申请'}).waitFor();
    await page.getByRole('button',{name:'批准并发送邀请'}).click();
    await page.getByText('已批准并发送邀请',{exact:false}).waitFor();
    assert(state.writes.some(item=>item.path.endsWith('/decide')&&item.body.action==='approve'));
    await screenshot('cards');
  });
  await scenario('feedback-reference-history','owner',async({page,state,screenshot})=>{
    await page.goto(origin+base+'/tasks');
    await page.getByRole('button',{name:/AI 拆解/}).click();
    const dialog=page.getByRole('dialog',{name:'AI 拆解、调整与分工'});
    await dialog.waitFor();
    assert.equal(await page.getByText('负责人反馈与重新判断',{exact:true}).count(),0);
    const feedback=dialog.getByLabel('持续项目反馈',{exact:false});
    await feedback.fill('新持续反馈，保留草稿');
    await dialog.getByRole('button',{name:'选择优先参考文件'}).click();
    const picker=page.getByRole('dialog',{name:'选择优先参考文件'});
    await picker.waitFor();
    const contrast=await picker.evaluate(node=>{
      const channels=value=>(value.match(/[\d.]+/g)||[]).slice(0,3).map(Number);
      const luminance=value=>channels(value).map(channel=>{const v=channel/255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;}).reduce((sum,v,index)=>sum+v*[0.2126,0.7152,0.0722][index],0);
      const background=getComputedStyle(node).backgroundColor,foreground=getComputedStyle(node.querySelector('h2')).color;
      const a=luminance(background),b=luminance(foreground);return {background,foreground,ratio:(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)};
    });
    await screenshot('picker-page');
    assert(contrast.ratio>=4.5,`reference picker text/background contrast is ${contrast.ratio.toFixed(2)}: ${JSON.stringify(contrast)}`);
    result.checks.push({name:'reference-picker-light-theme-contrast',passed:true,...contrast});
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('office-theme-select',{detail:'dark'})));
    const dark=await picker.evaluate(node=>{
      const channels=value=>(value.match(/[\d.]+/g)||[]).slice(0,3).map(Number);
      const luminance=value=>channels(value).map(v=>v/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4).reduce((a,v,i)=>a+v*[0.2126,0.7152,0.0722][i],0);
      const style=getComputedStyle(node),fg=getComputedStyle(node.querySelector('h2')).color,bg=style.backgroundColor;
      const a=luminance(fg),b=luminance(bg);return {background:bg,foreground:fg,ratio:(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)};
    });
    assert(dark.ratio>=4.5,`dark reference picker contrast is ${dark.ratio}`);
    result.checks.push({name:'reference-picker-dark-theme-contrast',passed:true,...dark});
    await screenshot('picker-dark');
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('office-theme-select',{detail:'light'})));
    await picker.getByRole('checkbox',{name:'本地参考通知'}).check();
    await picker.getByRole('button',{name:'完成选择并返回'}).click();
    assert.equal(await feedback.inputValue(),'新持续反馈，保留草稿');
    await screenshot('picker-return');
    await dialog.getByRole('button',{name:'重新生成整套任务建议',exact:true}).click();
    await page.getByText('反馈已保存',{exact:true}).waitFor();
    await page.waitForFunction(()=>document.body.innerText.includes('本次使用的持续反馈版本'));
    const saveIndex=state.writes.findIndex(item=>item.path.endsWith('/feedback/current'));
    const aiIndex=state.writes.findIndex(item=>item.path.endsWith('/decompose'));
    assert(saveIndex>=0&&aiIndex>saveIndex,'feedback must persist before AI request');
    assert.equal(state.feedback.feedback,'新持续反馈，保留草稿');
    const history=dialog.getByRole('button',{name:'历史记录',exact:true});
    assert(await history.evaluate(node=>Boolean(node.closest('.modal-head'))));
    await history.click();
    await page.getByRole('heading',{name:'持续反馈版本历史'}).waitFor();
    await screenshot('history');
  });
  for(const [role,grant] of [['member',false],['member',true],['admin',false],['admin',true],['owner',false]])await scenario(`scoring-${role}-${grant?'granted':'default'}`,role,async({page,screenshot})=>{
    await page.goto(origin+base+'/assessment?section=checks');
    await page.getByRole('heading',{name:'独立评分记录'}).waitFor();
    const correction=page.getByRole('heading',{name:'修正本轮评分',exact:true});
    if(role==='owner'||grant){await correction.waitFor();assert(await correction.evaluate(node=>Boolean(node.closest('.assessment-layout'))));}
    else assert.equal(await correction.count(),0);
    assert.equal(await page.getByRole('heading',{name:'独立人工评分',exact:true}).count(),0);
    await screenshot('history');
  },grant);
  for(const role of ['owner','manager','admin'])await scenario(`permission-team-${role}`,role,async({page,screenshot})=>{
    await page.goto(origin+base+'/team');
    await page.getByRole('heading',{name:'团队成员',exact:true}).waitFor();
    const edit=page.getByRole('button',{name:'调整 管理员账号成员 的权限'});
    const remove=page.getByRole('button',{name:'移除成员 管理员账号成员'});
    assert.equal(await edit.count(),role==='owner'?1:0);
    assert.equal(await remove.count(),role==='owner'||role==='manager'?1:0);
    assert.equal(await page.getByText('平台管理员',{exact:true}).count(),0);
    assert.equal(await page.locator('.team-member').filter({hasText:'管理员账号成员'}).getByText('权限锁定',{exact:true}).count(),0);
    await screenshot('desktop');
    if(role==='owner'){
      await edit.click();
      await page.getByRole('dialog',{name:'管理员账号成员 的项目权限'}).waitFor();
      await screenshot('editable-admin');
      await page.getByRole('button',{name:'取消',exact:true}).click();
    }
    await page.setViewportSize({width:390,height:844});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await screenshot('mobile');
    await page.goto(origin+base+'/tasks');
    await page.getByRole('button',{name:'AI 拆解、调整与分工',exact:true}).click();
    const feedback=page.getByLabel('持续项目反馈');
    assert.equal(await feedback.evaluate(node=>node.readOnly),role!=='owner');
    await screenshot('feedback');
  });
  await scenario('overview-layout','member',async({page,screenshot})=>{
    await page.goto(origin+base);
    await page.getByRole('heading',{name:'项目主目标',exact:true}).waitFor();
    assert.equal(await page.getByText('材料版本',{exact:true}).count(),0);
    const columns=page.locator('.project-overview-columns');
    const geometry=await columns.evaluate(node=>Array.from(node.children).map(child=>{const box=child.getBoundingClientRect();return{x:box.x,y:box.y,width:box.width,height:box.height};}));
    assert(geometry[1].x>geometry[0].x+geometry[0].width-1,'desktop columns must sit side by side');
    result.checks.push({name:'overview-desktop-geometry',passed:true,geometry});
    await screenshot('desktop');
    await page.setViewportSize({width:390,height:844});
    const mobile=await columns.evaluate(node=>Array.from(node.children).map(child=>{const box=child.getBoundingClientRect();return{x:box.x,y:box.y,width:box.width,height:box.height};}));
    assert(mobile[1].y>=mobile[0].y+mobile[0].height-1,'mobile layout must stack');
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'mobile must not scroll horizontally');
    result.checks.push({name:'overview-mobile-geometry',passed:true,geometry:mobile});
    await screenshot('mobile');
  });
  await scenario('opencode-custom-url','admin',async({page,state,screenshot})=>{
    await page.goto(origin+'/app/settings/ai');
    await page.getByRole('button',{name:'保存配置',exact:true}).waitFor();
    await page.getByLabel('统一模型供应商',{exact:false}).selectOption('opencode-zen');
    await page.getByLabel('统一模型 API key',{exact:false}).fill('fixture-explicit-key');
    await page.getByLabel('统一模型 API URL',{exact:false}).fill('https://fixture-proxy.example/v1/chat/completions');
    assert.equal(await page.getByLabel('统一模型供应商',{exact:false}).inputValue(),'custom');
    assert.equal(await page.getByLabel('统一模型 API key',{exact:false}).inputValue(),'fixture-explicit-key');
    await page.getByRole('button',{name:'保存配置',exact:true}).click();
    await page.getByText('配置已保存，AI 未启用。连接测试失败不影响保存；启用前请逐项测试。',{exact:true}).waitFor();
    assert.equal(state.config.unified.providerPreset,'custom');
    assert.equal(state.config.unified.apiKey,'fixture-explicit-key');
    assert.equal(state.config.unified.apiProtocol,'chat-completions');
    await page.getByLabel('允许 AI 使用提供商原生互联网搜索').check();
    await page.getByRole('button',{name:'保存配置',exact:true}).click();
    await page.waitForTimeout(100);
    assert.equal(state.config.searchEnabled,true);
    await screenshot('saved');
  });
  await scenario('task-settings-layout','owner',async({page,state,screenshot})=>{
    await page.goto(origin+base+'/tasks');
    await page.getByRole('button',{name:'任务设置',exact:true}).first().click();
    const dialog=page.getByRole('dialog',{name:/^任务设置·/});
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('button',{name:/保存/}).count(),0);
    assert.equal(await dialog.getByText(/本地修改基于/).count(),0);
    assert.equal(await page.getByText('此项目已准备离线使用',{exact:true}).count(),0);
    await screenshot('desktop');
    await dialog.getByRole('button',{name:'修改任务内容',exact:true}).click();
    await dialog.getByLabel('任务名称',{exact:true}).fill('样本采集新名称');
    await page.waitForTimeout(3300);
    assert(state.writes.some(row=>row.method==='PATCH'&&row.body.title==='样本采集新名称'),'three-second autosave must write');
    await dialog.getByRole('button',{name:'修改前置任务',exact:true}).click();
    await page.getByLabel('搜索任务',{exact:true}).fill('来源');
    assert.equal(await page.getByRole('checkbox',{name:'来源说明',exact:true}).count(),1);
    await screenshot('dependencies');
    await page.getByRole('dialog',{name:'前置任务·样本采集新名称',exact:true}).getByRole('button',{name:'关闭',exact:true}).click();
    await page.getByRole('button',{name:'更新',exact:true}).click();
    await page.getByRole('dialog',{name:'更新任务状态·样本采集新名称',exact:true}).waitFor();
    await screenshot('status');
    await page.getByRole('dialog',{name:'更新任务状态·样本采集新名称',exact:true}).getByRole('button',{name:'关闭',exact:true}).click();
    await page.setViewportSize({width:390,height:844});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'task settings mobile must not overflow');
    await screenshot('mobile');
  });
  await scenario('task-settings-readonly','member',async({page,screenshot})=>{
    await page.goto(origin+base+'/tasks');
    await page.getByLabel('有未读质询').first().waitFor();
    await page.getByRole('button',{name:'任务设置',exact:true}).first().click();
    const dialog=page.getByRole('dialog',{name:'任务设置·样本采集',exact:true});
    await dialog.waitFor();assert.equal(await dialog.getByRole('button',{name:/修改/}).count(),0);
    await screenshot('readonly');
  });
  await scenario('task-files-upload','owner',async({page,state,screenshot})=>{
    await page.goto(origin+base+'/tasks');
    await page.getByRole('button',{name:'查看与提交',exact:true}).first().click();
    const dialog=page.getByRole('dialog',{name:'样本采集',exact:true});await dialog.waitFor();
    assert.equal(await dialog.getByLabel('绑定材料版本',{exact:false}).count(),0);
    assert.equal(await dialog.locator('.collab-toolbar').count(),0);
    const header=dialog.locator('.modal-head');
    assert.equal(await header.getByRole('button',{name:'查看历史记录',exact:true}).count(),1);
    await dialog.getByLabel('成果说明',{exact:true}).fill('上传真实成果文件');
    await dialog.getByLabel('上传成果文件',{exact:true}).setInputFiles({name:'成果报告.txt',mimeType:'text/plain',buffer:Buffer.from('local fixture result')});
    await dialog.getByRole('link',{name:'成果报告.txt',exact:true}).waitFor();
    assert.equal(state.taskFiles.length,1);await screenshot('uploaded');
    await dialog.getByRole('button',{name:'归档文件',exact:true}).click();
    await page.waitForTimeout(150);assert.equal(await dialog.getByRole('link',{name:'成果报告.txt',exact:true}).count(),0);
    await dialog.getByRole('button',{name:'已归档（1）',exact:true}).click();
    await dialog.getByRole('button',{name:'撤销文件归档',exact:true}).click();
    await page.waitForTimeout(150);assert.equal(state.taskFiles[0].archivedAt,null);
    await dialog.getByRole('button',{name:'当前文件（1）',exact:true}).click();
    await page.setViewportSize({width:390,height:844});await screenshot('mobile');
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'submission mobile must not overflow');
    await dialog.getByRole('button',{name:'关闭',exact:true}).click();
    await page.goto(origin+base+'/data');
    await page.getByRole('complementary',{name:'项目资料列表'}).getByText('样本采集',{exact:true}).waitFor();
    await page.getByRole('complementary',{name:'项目资料列表'}).getByText('公共文件',{exact:true}).waitFor();
    await screenshot('task-folders');
  });
  await scenario('standards-compact','owner',async({page,screenshot})=>{
    await page.goto(origin+base+'/assessment');
    const menu=page.getByRole('navigation',{name:'评分分区'});await menu.waitFor();
    assert.deepEqual(await menu.getByRole('link').allTextContents(),['项目标准','材料检查','答辩演练']);
    const panel=page.getByRole('region',{name:'评分比例与参考资料'});await panel.waitFor();
    assert.equal(await panel.getByText('质量 · 权重 100%',{exact:false}).count(),1);
    assert.equal(await panel.getByText(/不应显示/).count(),0);
    assert.equal(await panel.getByRole('link',{name:'[1] 标准通知.pdf',exact:true}).getAttribute('href'),'/api/v1/projects/'+id+'/files/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/content');
    assert.equal(await page.locator('.notice.notice-warn').filter({hasText:'该页面标准为项目级标准'}).getByRole('link',{name:'任务',exact:true}).getAttribute('href'),base+'/tasks');
    await page.getByRole('button',{name:'修订生效标准',exact:true}).waitFor();
    await screenshot('desktop');await page.setViewportSize({width:390,height:844});await screenshot('mobile');
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'standard mobile must not overflow');
  });
  await scenario('submission-collapse','owner',async({page,screenshot})=>{
    await page.goto(origin+base+'/tasks');await page.getByRole('button',{name:'查看与提交',exact:true}).first().click();
    const body=page.locator('.submission-body');await body.waitFor();
    assert.equal(await body.getAttribute('open'),null);assert.equal(await body.locator('p').isVisible(),false);
    await screenshot('collapsed');await body.getByText('展开提交内容',{exact:true}).click();
    await body.getByText('收起提交内容',{exact:true}).waitFor();assert((await body.locator('p').textContent()).endsWith('末尾完整文本'));
    await screenshot('expanded');await page.setViewportSize({width:390,height:844});await screenshot('mobile');
  });
  await scenario('scoring-only-generation','owner',async({page,screenshot})=>{
    await page.goto(origin+base+'/assessment');await page.getByRole('button',{name:'AI 生成标准',exact:true}).click();
    await page.getByLabel('评分维度名称',{exact:true}).waitFor();
    assert.equal(await page.getByLabel('评分维度名称',{exact:true}).inputValue(),'质量');
    assert.equal(await page.getByLabel('要求 1 标题',{exact:true}).count(),0);
    assert.equal(await page.getByLabel('要求截止日期',{exact:true}).count(),0);
    assert.equal(await page.getByLabel('标准说明',{exact:true}).count(),0);
    await page.getByText('来源引用（1 条）',{exact:true}).click();
    await page.getByText('[1] 标准通知.pdf',{exact:true}).waitFor();
    await screenshot('editor');
  });
  await scenario('error-verbatim','owner',async({page,screenshot})=>{
    await page.goto(origin+base+'/assessment');await page.getByRole('button',{name:'AI 生成标准',exact:true}).click();
    const error=page.getByRole('alert');await error.waitFor();
    assert((await error.textContent()).includes('原始后端原因：评分方法来源已变化\n请重新选择原文件'));
    assert(!(await error.textContent()).includes('INTERNAL'));assert(!(await error.textContent()).includes('deadbeef'));assert(!(await error.textContent()).includes('traceback'));
    await screenshot('reason');
  });
}finally{
  await browser.close();
  result.finishedAt=new Date().toISOString();result.passed=result.checks.every(check=>check.passed)&&result.errors.length===0;
  await writeFile(resolve(out,'results.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({passed:result.passed,checks:result.checks,screenshots:result.screenshots,errors:result.errors,report:resolve(out,'results.json')},null,2));
  if(!result.passed)process.exitCode=1;
}
