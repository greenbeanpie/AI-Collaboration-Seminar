// Read-only deployed UI verification. Credentials/cookies never enter output.
const {chromium}=require(process.env.UI_PLAYWRIGHT_PATH||'playwright');
const {readFileSync,mkdirSync,writeFileSync}=require('node:fs');
const assert=require('node:assert/strict');
const option=name=>process.argv[process.argv.indexOf(name)+1];
const origin=process.env.RELEASE_URL||'https://greenbp-team-office.hddhp.workers.dev';
assert(process.argv.includes('--credentials')&&origin==='https://greenbp-team-office.hddhp.workers.dev');
const output=option('--output')||'output/mimo-release';mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.UI_CHROMIUM_PATH?{executablePath:process.env.UI_CHROMIUM_PATH}:{})});
 const context=await browser.newContext(),results=[],errors=[];
 try{
  const account=JSON.parse(readFileSync(option('--credentials'),'utf8')).accounts.production;
  const login=await context.request.post(origin+'/api/v1/auth/sessions',{data:{account:account.username,password:account.password}});assert(login.ok(),'Existing administrator login rejected');
  const savedResponse=await context.request.get(origin+'/api/v1/admin/ai-config');assert(savedResponse.ok());const saved=(await savedResponse.json()).data;
  const initialAudio=saved.config.processingStrategies?.audioFiles??(saved.config.audioProcessingStrategy==='gemini-only'?'media-only':'whisper-first');
  for(const width of [1440,390]){
   const page=await context.newPage({viewport:{width,height:1000}});page.on('pageerror',error=>errors.push(error.message));
   await page.route('**/api/**',async route=>{if(!['GET','HEAD'].includes(route.request().method()))return route.abort();return route.continue();});
   await page.goto(origin+'/app/settings/ai');await page.getByRole('heading',{name:'MiMo 音视频理解模型',exact:true}).waitFor({timeout:30000});
   assert.equal(await page.getByLabel('音频文件处理策略').inputValue(),initialAudio);assert.equal(await page.getByLabel('视频文件处理策略').inputValue(),saved.config.processingStrategies?.videoFiles??'gemini');
   assert.equal(await page.getByLabel('配置 MiMo 音视频摘要模型').isChecked(),Boolean(saved.config.mimoMediaUnderstanding));
   if(saved.config.mimoMediaUnderstanding){assert.equal(await page.getByLabel('MiMo API key').inputValue(),'');assert.equal(await page.getByLabel('MiMo 模型',{exact:true}).inputValue(),'mimo-v2.6-pro');}
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
   await page.getByRole('heading',{name:'MiMo 音视频理解模型',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:`${output}/deployed-settings-${width}.png`});
   results.push({width,mimoPanelPresent:true,defaultStrategy:initialAudio,videoStrategy:saved.config.processingStrategies?.videoFiles??'gemini',noOverflow:true});await page.close();
  }
  assert.deepEqual(errors,[]);await context.request.delete(origin+'/api/v1/auth/session');
  const report={result:'PASS',origin,configVersion:saved.version,mimoKeyConfigured:Boolean(saved.config.mimoMediaUnderstanding?.keyConfigured),checks:results,noInference:true,noConfigurationWrites:true};writeFileSync(output+'/deployed-ui.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }finally{await context.close();await browser.close();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
