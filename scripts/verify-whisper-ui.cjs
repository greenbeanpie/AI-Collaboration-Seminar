const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.UI_PLAYWRIGHT_PATH || 'playwright');
const { installFixture } = require('./verify-project-upgrades-ui.cjs');
const origin=process.env.UI_ORIGIN || 'http://127.0.0.1:5186';
assert(['localhost','127.0.0.1'].includes(new URL(origin).hostname));
const output=path.resolve('output/whisper-release/ui');fs.mkdirSync(output,{recursive:true});
const report={source:'Chromium and real React app, synthetic APIs; no paid requests',checks:[],errors:[]};
const jobId='00000000-0000-4000-a000-000000000001';
async function verify(){
 const browser=await chromium.launch({headless:true,...(process.env.UI_CHROMIUM_PATH?{executablePath:process.env.UI_CHROMIUM_PATH}:{})});
 try{for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});await installFixture(context,[]);
  let reads=0,resumes=0,continued=false;
  await context.route('**/api/v1/projects/ready/sources/media/versions/media-version/processing**',async route=>{
   const request=route.request();let data;
   if(request.method()==='POST'){
    assert(request.url().endsWith('/media-resume'));assert.equal(request.postDataJSON().jobId,jobId);resumes++;continued=true;data={jobId,status:'running'};
   }else{
    reads++;const summary=continued?{title:'Gemini 摘要',summary:'已依据原音生成摘要',keyPoints:[],conclusions:[],actionItems:[],timestamps:[],caveats:[],complete:true}:null;
    data={textStatus:continued?'ready':'waiting_input',requirementsStatus:'pending',requirementsError:null,summaryStatus:continued?'ready':'pending',summary:continued?{...summary,citations:[]}:null,summaryError:null,summaryJobId:null,summaryRevision:0,coveredChars:null,totalChars:null,media:{jobId,stage:continued?'ready':'processing',summary,error:null,durationSeconds:30,completedWindows:continued?1:0,audio:{phase:continued?'ready':'waiting_config',qualityScore:0.7,reasons:['转录质量未达到 0.85'],transcriptAvailable:true,canResumeFallback:!continued&&reads>1}}};
   }
   await route.fulfill({status:request.method()==='POST'?202:200,contentType:'application/json',body:JSON.stringify({data,requestId:'whisper-ui-fixture'})});
  });
  const page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));
  await page.goto(origin+'/app/projects/ready/data?resourceType=source&resourceId=media');
  await page.getByText('等待 Gemini 配置',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'继续 Gemini 回退',exact:true}).isDisabled(),true);
  assert.equal(resumes,0);
  await page.screenshot({path:path.join(output,`waiting-${width}.png`),fullPage:true});
  await page.getByRole('button',{name:'刷新配置与状态',exact:true}).click();
  await page.getByRole('button',{name:'继续 Gemini 回退',exact:true}).waitFor();
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='继续 Gemini 回退')?.disabled===false);
  assert.equal(resumes,0,'Refreshing configuration must not trigger a paid continuation');
  await page.getByRole('button',{name:'继续 Gemini 回退',exact:true}).click();
  await page.getByText('已依据原音生成摘要',{exact:true}).first().waitFor();
  assert.equal(resumes,1);
  assert.equal(await page.getByRole('button',{name:'继续 Gemini 回退',exact:true}).count(),0);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Horizontal overflow');
  await page.screenshot({path:path.join(output,`resumed-${width}.png`),fullPage:true});
  report.checks.push({width,waitingConfig:true,transcriptRetained:true,noAutomaticPaidCall:true,explicitResumeOnce:true,noOverflow:true});
  await context.close();
 }}finally{await browser.close();}
 assert.deepEqual(report.errors,[]);report.result='PASS';fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({result:'PASS',viewports:report.checks.length,output}));
}
verify().catch(error=>{report.result='FAIL';report.errors.push(error.message);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.error(error);process.exitCode=1;});
