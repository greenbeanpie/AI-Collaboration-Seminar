// All API requests are local fixtures. No real keys or paid model calls.
const {existsSync}=require('node:fs');
const bundledPlaywright='/Users/hddhp/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright';
const {chromium}=require(process.env.UI_PLAYWRIGHT_PATH||(existsSync(bundledPlaywright)?bundledPlaywright:'playwright'));
const assert=require('node:assert/strict');
const {mkdirSync,writeFileSync}=require('node:fs');
const origin=process.env.UI_ORIGIN||'http://127.0.0.1:5184',output=process.env.UI_OUTPUT_DIR||'/tmp/audio-settings-ui';
if(!['localhost','127.0.0.1'].includes(new URL(origin).hostname))throw Error('Loopback only');
mkdirSync(output,{recursive:true});
(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.UI_CHROMIUM_PATH?{executablePath:process.env.UI_CHROMIUM_PATH}:{})}),results=[];
  try{for(const width of [1440,390]){
    const page=await browser.newPage({viewport:{width,height:1000}}),errors=[],writes=[];
    page.on('pageerror',e=>errors.push(e.message));
    const model={provider:'openai-compatible',providerPreset:'custom',model:'fixture-text',apiUrl:'https://model.example/v1/chat/completions',timeoutMs:90000,maxInputChars:48000,maxOutputTokens:4096,enabledOutputLimit:true,supportsJson:true,supportsVision:true,pricePerMTokens:null,keyConfigured:true};
    const config={routingMode:'unified',textEconomy:model,visionEconomy:model,review:model,unified:model,
      audioFileTranscription:{provider:'workers-ai',model:'@cf/openai/whisper-large-v3-turbo'},
      processingStrategies:{audioFiles:'whisper-first',rehearsal:'text'},rehearsalSpeech:{provider:'system-local',lang:'zh-CN',rate:1,volume:1},
      realtimeAudioTranscription:{provider:'google-ai-studio',model:'gemini-3.5-transcribe-live',gatewayId:'fixture-voice',languageCodes:['zh-CN'],keyConfigured:true,gatewayTokenConfigured:true}};
    await page.route('**/*',async route=>{
      const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();
      let data={items:[],nextCursor:null};
      if(url.pathname.endsWith('/auth/session'))data={user:{id:'fixture-admin',displayName:'设置验证',username:'fixture',role:'super_admin',isAdmin:true}};
      else if(url.pathname.endsWith('/capabilities'))data={features:{aiEnabled:true}};
      else if(url.pathname.endsWith('/ai-config')){
        if(req.method()==='PUT'){writes.push(req.postDataJSON());data={version:9,enabled:true};}
        else data={version:8,enabled:true,config};
      }else if(req.method()!=='GET')throw Error('Unexpected model/write request');
      await route.fulfill({contentType:'application/json',body:JSON.stringify({data,requestId:'fixture'})});
    });
    await page.goto(origin+'/app/settings/ai');
    await page.getByRole('heading',{name:'AI 模型接入与测试',exact:true}).waitFor({timeout:5000}).catch(async error=>{console.error({url:page.url(),body:await page.locator('body').innerText(),errors});throw error;});
    for(const name of ['音视频理解模型','实时语音转录模型','答辩语音朗读','音频与答辩处理策略'])await page.getByRole('heading',{name,exact:true}).waitFor();
    assert.equal(await page.getByLabel('文件转录模型',{exact:true}).inputValue(),'@cf/openai/whisper-large-v3-turbo');
    assert.equal(await page.getByLabel('文件转录模型',{exact:true}).getAttribute('readonly'),'');
    const fileField=page.getByLabel('文件转录模型',{exact:true}).locator('xpath=ancestor::label[1]');
    assert.equal(await fileField.innerText(),'文件转录模型');
    assert.equal(await fileField.locator('input').count(),1);assert.equal(await fileField.locator('p').count(),0);
    assert.equal(await page.getByRole('heading',{name:'音频文件初步转录模型',exact:true}).count(),0);
    assert.equal(await page.getByLabel('答辩朗读模型',{exact:true}).count(),0);
    assert.equal(await page.getByLabel('朗读语言').inputValue(),'zh-CN');
    await page.getByLabel('朗读语速').fill('1.5');await page.getByLabel('朗读音量').fill('0.7');
    await page.getByLabel('实时转录语言提示').fill('');
    await page.getByLabel('模拟答辩处理策略').selectOption('voice-with-text-fallback');
    await page.getByRole('button',{name:'保存配置',exact:true}).click();
    await page.getByText('配置已保存，AI 保持启用。',{exact:true}).waitFor();
    assert.equal(writes.length,1);assert.equal(writes[0].processingStrategies.rehearsal,'voice-with-text-fallback');
    assert.deepEqual(writes[0].rehearsalSpeech,{provider:'system-local',lang:'zh-CN',rate:1.5,volume:0.7});
    assert.equal('fileTranscriptionRuntime' in writes[0],false);assert.equal('model' in writes[0].rehearsalSpeech,false);assert.equal('voice' in writes[0].rehearsalSpeech,false);
    assert.deepEqual(writes[0].realtimeAudioTranscription.languageCodes,[]);assert.equal('keyConfigured' in writes[0].realtimeAudioTranscription,false);
    assert.equal(await page.getByLabel('实时语音 Google API key').inputValue(),'');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await page.getByRole('heading',{name:'实时语音转录模型',exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({path:`${output}/audio-settings-${width}.png`,fullPage:true});
    await page.screenshot({path:`${output}/realtime-settings-${width}.png`});
    await page.getByRole('heading',{name:'答辩语音朗读',exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({path:`${output}/local-speech-settings-${width}.png`});
    assert.deepEqual(errors,[]);results.push({width,sections:4,whisperFixed:true,whisperOnlyModel:true,localSpeech:true,strategyIndependent:true,noProbes:true,noOverflow:true});await page.close();
  }}finally{await browser.close();}
  writeFileSync(output+'/result.json',JSON.stringify({result:'PASS',source:'Local Chromium fixtures only',checks:results},null,2));console.log(JSON.stringify(results));
})().catch(e=>{console.error(e);process.exitCode=1;});
