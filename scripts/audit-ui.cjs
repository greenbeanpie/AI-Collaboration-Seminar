const { chromium } = require(process.env.UI_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'); const path = require('node:path');
const root = path.resolve(process.argv[2] || 'docs/evidence/ui-audit');
const stage = process.argv[3] || 'after';
const origin = process.env.UI_ORIGIN || 'http://127.0.0.1:5197';
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw new Error('UI audits require a loopback origin');
const date = '2026-09-30T12:00:00Z';
const long = '跨学科项目协作与人工智能应用研究：完整保留任务说明、来源依据和人工确认记录。';
const project = {id:'fixture',name:'项目2 · AI 协作研讨',description:long.repeat(3),deadlineDate:'2026-12-01',deadlinePrecision:'date',status:'active',aiBudgetUsd:20,revision:1,myRole:'owner',createdAt:date,updatedAt:date};
const user = {id:'fixture-user',username:'local_fixture',email:null,displayName:'本地审查测试成员',isAdmin:true};
const member = {userId:user.id,...user,role:'owner',skills:['研究','材料整理'],hoursPerWeek:8,joinedAt:date};
const capabilities = {apiVersion:'v1',environment:'local-fixture',features:{aiEnabled:false,webFetch:false,emailMode:'echo'},limits:{maxFileBytes:20000000,maxPdfPages:50,pageImageMaxEdge:1600,pageImageMaxBytes:1000000,listDefaultPageSize:20,listMaxPageSize:100,concurrentAiTasksPerProject:2,assignmentSuggestionMaxTasks:20},competitionTemplate:{teamSizeLimit:5},authentication:{mode:'password',passwordEnabled:true,invitationRequired:true,passwordMinLength:12,turnstileRequired:false,turnstileSiteKey:null}};
const routes = ['/login','/app','/app/projects/new','/app/join','/app/admin/accounts','/app/admin/ai','/app/settings',...['','sources','requirements','team','tasks','ai','materials','reviews','rehearsals','ledger','settings','export'].map(x=>'/app/projects/fixture'+(x?'/'+x:''))];
const requirementSet={requirementSetId:'set1',sourceVersionId:null,status:'draft',revision:1,confirmedAt:null,requirements:[{requirementId:'requirement1',seq:1,category:'deliverable',title:long,detail:long.repeat(6),dueDate:null,duePrecision:'unknown',citations:[],fieldState:'edited'}]};
const rubric={rubricId:'rubric1',version:1,source:'custom',weights:[{key:'quality',label:long,weight:100}],notes:long.repeat(4),status:'draft',confirmedAt:null,createdAt:date};
const material={materialId:'material1',title:long,kind:'proposal',revision:1,currentVersionId:'version1',currentVersion:{versionId:'version1',revision:1,doc:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:long.repeat(8)}]}]},markdown:long.repeat(8),attachments:[],origin:'manual',authorId:user.id,createdAt:date},createdAt:date,updatedAt:date};
function fixture(p,state) {
 const filled = state==='filled'||state==='history';
 if(state==='history') {
  const review={reviewId:'review1',requirementSetId:'set1',rubricVersionId:'rubric1',materialVersionIds:['version1'],status:'succeeded',createdAt:date,report:{overall:{score:80,summary:long.repeat(6)},scores:[{key:'quality',score:80,comment:long.repeat(6),suggestions:[long,long]}]}};
  const rehearsal={rehearsalId:'rehearsal1',scope:'all',memberId:null,status:'finished',createdAt:date,finishedAt:date,turns:[{sequence:1,kind:'question',role:'assistant',content:long.repeat(4),createdAt:date},{sequence:2,kind:'answer',role:'user',content:long.repeat(8),createdAt:date},{sequence:3,kind:'summary',role:'assistant',content:long.repeat(6),createdAt:date}]};
  const session={sessionId:'session1',title:long,capability:'guide',status:'closed',taskId:'task1',latestRunId:null,latestRunStatus:null,latestJobId:null,createdAt:date,updatedAt:date,runs:[],turns:[{sequence:1,role:'user',kind:'instruction',runId:null,payload:{instruction:long.repeat(5)},createdAt:date},{sequence:2,role:'assistant',kind:'question',runId:null,payload:{question:long.repeat(8)},createdAt:date}]};
  if(p.endsWith('/reviews'))return {items:[review]};if(p.endsWith('/reviews/review1'))return review;
  if(p.endsWith('/rehearsals'))return {items:[rehearsal],nextCursor:null};if(p.endsWith('/rehearsals/rehearsal1'))return rehearsal;
  if(p.endsWith('/agent-sessions'))return {items:[session],nextCursor:null};if(p.endsWith('/agent-sessions/session1'))return session;
  if(p.endsWith('/sources'))return {items:[{sourceId:'source1',kind:'paste',title:long,currentVersionId:'source-version1',createdAt:date}],nextCursor:null};
  if(p.endsWith('/sources/source1/versions/source-version1'))return {sourceVersionId:'source-version1',sourceId:'source1',revision:1,origin:'paste',fileId:null,status:'ready',parseError:null,pageCount:null,charCount:1000,pages:[]};
  if(p.endsWith('/fragments'))return {items:[{fragmentId:'fragment1',seq:1,pageNumber:null,kind:'text',content:long.repeat(20)}],nextCursor:null};
 }
 if(p.endsWith('/auth/session')) return {user};
 if(p.endsWith('/capabilities')) return capabilities;
 if(p==='/api/v1/projects') return {items:filled?[project]:[],nextCursor:null};
 if(p==='/api/v1/projects/fixture') return project;
 if(p.endsWith('/members/me')) return member;
 if(p.endsWith('/members')) return {items:filled?[member]:[],nextCursor:null};
 if(p.endsWith('/tasks')) return {items:filled?[{taskId:'task1',title:long,detail:long.repeat(5),duePrecision:'date',status:'todo',assigneeId:user.id,requirementId:null,dueDate:'2026-12-01',revision:1,createdAt:date,updatedAt:date}]:[],nextCursor:null};
 if(p.endsWith('/sources')) return {items:filled?[{sourceId:'source1',kind:'paste',title:long,currentVersionId:null,createdAt:date}]:[],nextCursor:null};
 if(p.endsWith('/materials')) return {items:filled?[material]:[],nextCursor:null};
 if(p.endsWith('/materials/material1')) return material;
 if(p.endsWith('/materials/material1/versions')) return {items:[material.currentVersion],nextCursor:null};
 if(p.endsWith('/materials/material1/versions/version1')) return material.currentVersion;
 if(p.endsWith('/requirement-sets')) return {items:filled?[requirementSet]:[]};
 if(p.endsWith('/requirement-sets/set1')) return requirementSet;
 if(p.endsWith('/rubrics')) return {items:filled?[rubric]:[]};
 if(p.endsWith('/export')) return {project,generatedAt:date,materials:[],requirementSets:[],tasks:[],rubricVersions:[],events:[]};
 if(p.endsWith('/events')) return {items:filled?[{eventId:'event1',type:'task.created',eventType:'task.created',actorType:'human',actorId:user.id,payload:{title:long},occurredAt:date}]:[],nextCursor:null};
 return {items:[],nextCursor:null};
}
module.exports = { fixture, origin, routes, user };
if (require.main === module) (async()=> {
 fs.mkdirSync(path.join(root,stage),{recursive:true});
 const browser = await chromium.launch({headless:true}); const results=[];
 await Promise.all([false,true].flatMap(mobile=>['light','dark'].map(async theme=>{
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:1000},colorScheme:theme,serviceWorkers:'block'});
  for(const state of (process.env.UI_STATES||'filled,empty,error,loading').split(',')) for(const route of routes.filter(x=>!process.env.UI_ROUTES||process.env.UI_ROUTES.split(',').includes(x))) {
   const page=await context.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.addInitScript(t=>localStorage.setItem('theme',t),theme);
   await page.route('**/api/v1/**',async r=>{
    const p=new URL(r.request().url()).pathname;
    if(r.request().method()!=='GET') return r.fulfill({status:409,json:{error:{code:'FIXTURE_READ_ONLY',message:'本地审查夹具不保存操作',retryable:false},requestId:'ui-fixture'}});
    const shell=p.endsWith('/auth/session')||p.endsWith('/capabilities')||p==='/api/v1/projects/fixture';
    if(state==='loading'&&!shell) await new Promise(resolve=>setTimeout(resolve,4000));
    if(state==='error'&&!shell) return r.fulfill({status:503,json:{error:{code:'FIXTURE_UNAVAILABLE',message:long.repeat(2),retryable:true},requestId:'ui-fixture'}});
    return r.fulfill({json:{data:fixture(p,state),requestId:'ui-fixture'}});
   });
   await page.goto(origin+route);await page.waitForSelector('.theme-toolbar');await page.waitForTimeout(state==='loading'?450:state==='error'?1700:600);
   const id=route.replace(/\//g,'_')||'root';const name=`${mobile?'mobile':'desktop'}-${theme}-${state}${id}.png`;
   const metrics=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,theme:document.documentElement.dataset.theme,text:document.body.innerText.slice(-180),overflows:[...document.querySelectorAll('main,section,.card,.page-stack')].filter(e=>e.getBoundingClientRect().right>innerWidth+2).map(e=>e.className)}));
   await page.screenshot({path:path.join(root,stage,name),fullPage:true});
   results.push({route,state,mobile,theme,...metrics,errors,screenshot:name});
   if(state==='filled'&&route.endsWith('/tasks')) {
    const create=page.getByRole('button',{name:/新建任务/});
    if(await create.count()) {await create.click(); await page.waitForTimeout(150);const dialog=page.getByRole('dialog');if(await dialog.count()) {await dialog.screenshot({path:path.join(root,stage,`${mobile?'mobile':'desktop'}-${theme}-task-modal.png`)});await page.keyboard.press('Shift+Tab');results.push({test:'modal-focus',mobile,theme,inside:await page.evaluate(()=>!!document.activeElement?.closest('[role="dialog"]'))});await page.keyboard.press('Escape');results.push({test:'modal-escape',mobile,theme,closed:await dialog.count()===0});}}
   }
   await page.close();
  }
  await context.close();
 })));
 await browser.close();fs.writeFileSync(path.join(root,`${stage}-results.json`),JSON.stringify(results,null,2));
 console.log(JSON.stringify({stage,cases:results.length,overflow:results.filter(x=>x.scrollWidth>x.width+2).map(x=>({route:x.route,state:x.state,mobile:x.mobile,theme:x.theme})),errors:results.filter(x=>x.errors?.length),keyboard:results.filter(x=>x.test)},null,2));
})().catch(e=>{console.error(e);process.exit(1)});
