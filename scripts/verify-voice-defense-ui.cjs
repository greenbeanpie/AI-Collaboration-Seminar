// Loopback fixtures only: no model calls, real microphone or production writes.
// UI_PLAYWRIGHT_PATH=/bundled/node_modules/playwright UI_ORIGIN=http://127.0.0.1:5184 node scripts/verify-voice-defense-ui.cjs
const {chromium}=require(process.env.UI_PLAYWRIGHT_PATH||'playwright');
const assert=require('node:assert/strict');const {mkdirSync,writeFileSync}=require('node:fs');
const origin=process.env.UI_ORIGIN||'http://127.0.0.1:5184',output=process.env.UI_OUTPUT_DIR||'/tmp/voice-defense-ui';
if(!['localhost','127.0.0.1'].includes(new URL(origin).hostname))throw Error('Loopback only');mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.UI_CHROMIUM_PATH?{executablePath:process.env.UI_CHROMIUM_PATH}:{})});const results=[];
 try{for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'}),page=await context.newPage(),errors=[],writes=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
   window.voiceFixture={mic:0,stops:0,playing:0,frames:0};
   Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{window.voiceFixture.mic++;return{getTracks:()=>[{stop:()=>window.voiceFixture.stops++}]};}}});
   class Node{connect(){}disconnect(){} }
   window.AudioContext=class{sampleRate=48000;destination={};audioWorklet={addModule:async()=>{}};createMediaStreamSource(){return new Node();}createGain(){return Object.assign(new Node(),{gain:{value:1}});}resume(){return Promise.resolve();}close(){return Promise.resolve();}};
   window.AudioWorkletNode=class extends Node{constructor(){super();this.port={onmessage:null,postMessage:()=>this.port.onmessage?.({data:{flushed:true}})};this.timer=setInterval(()=>this.port.onmessage?.({data:Float32Array.from({length:1024},(_,i)=>Math.sin(i*.2)*.1).buffer}),20);}disconnect(){clearInterval(this.timer);}};
   window.WebSocket=class{static OPEN=1;readyState=1;bufferedAmount=0;constructor(){window.fixtureSocket=this;setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'ready'})}),20);}send(raw){const data=JSON.parse(raw);if(data.type==='audio'){window.voiceFixture.frames++;if(window.voiceFixture.frames===1)this.emit({type:'partial',text:'临时字幕'});}if(data.type==='stop')setTimeout(()=>{this.emit({type:'final',sequence:1,text:'项目方案具有可验证的实施步骤。'});this.emit({type:'final',sequence:1,text:'项目方案具有可验证的实施步骤。'});this.emit({type:'complete'});},10);}emit(data){this.onmessage?.({data:JSON.stringify(data)});}close(){this.readyState=3;}};
   window.Audio=class{play(){window.voiceFixture.playing++;return Promise.resolve();}pause(){window.voiceFixture.playing=0;}load(){}removeAttribute(){} };
  });
  const user={id:'owner',displayName:'本机验证',username:'fixture',role:'user',isAdmin:false},project={id:'p1',name:'语音答辩验证',status:'active',myRole:'owner',revision:1};
  const turn={sequence:1,kind:'question',role:'assistant',content:'请说明项目方案与证据。',createdAt:'2026-10-05T00:00:00Z'};
  const rehearsal={rehearsalId:'r1',status:'active',scope:'all',memberId:null,createdAt:'2026-10-05T00:00:00Z',initiatorId:'owner',respondentId:'owner',canOperate:true,processingJobId:null,processingStatus:null,turns:[turn]};
  let readOnly=false;
  const assessment={assessmentId:'a1',kind:'rehearsal',historical:true,status:'active',rehearsalId:'r1',createdAt:turn.createdAt,report:null};
  await page.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();const path=url.pathname;
   const send=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify({data,requestId:'fixture'})});
   if(req.method()==='POST'){writes.push({path,body:req.postDataJSON()});if(path.endsWith('/voice-sessions'))return send({sessionId:'s1',webSocketPath:'/api/v1/projects/p1/rehearsals/r1/voice-sessions/s1/stream',expiresAt:'2026-10-05T00:10:00Z'},201);if(path.endsWith('/speech'))return send({speechId:'sp1',jobId:'j1',status:'ready',audioPath:'/api/v1/projects/p1/rehearsals/r1/speech/sp1/audio'},202);if(path.endsWith('/close'))return send({});throw Error(`Unexpected write ${path}`);}
   if(path==='/api/v1/auth/session')return send({user});if(path==='/api/v1/capabilities')return send({features:{aiEnabled:true,webSearchEnabled:false},limits:{maxFileBytes:10000000}});
   if(path==='/api/v1/projects/p1')return send(project);if(path.endsWith('/assessments/a1'))return send(assessment);if(path.endsWith('/assessments'))return send({items:[assessment],nextCursor:null});
   if(path.endsWith('/rehearsals/r1/voice'))return send({configured:true,ready:true,mode:'voice-with-text-fallback',reason:null,speech:{model:'tts-fixture',voice:'Kore'}});
   if(path.endsWith('/rehearsals/r1'))return send({...rehearsal,canOperate:!readOnly});if(path.endsWith('/rehearsals'))return send({items:[rehearsal],nextCursor:null});if(path.endsWith('/members'))return send({items:[{userId:'owner',displayName:'本机验证',role:'owner'}],nextCursor:null});
   if(path.endsWith('/goal'))return send({projectId:'p1',title:'验证语音答辩',detail:'本机fixture',revision:1});if(path.endsWith('/collaboration/settings'))return send({aiCollaborationEnabled:true,planningMode:'manual',assignmentMode:'manual',evaluationMode:'manual',revision:1});
   return send({items:[],nextCursor:null});
  });
  await page.goto(origin+'/app/projects/p1/assessment?section=rehearsals&assessmentId=a1');await page.getByRole('button',{name:'语音回答',exact:true}).waitFor();
  const answer=page.getByRole('textbox',{name:'回答当前问题'});await answer.fill('已有人工编辑');await page.getByRole('button',{name:'语音回答',exact:true}).click();assert.equal(await page.evaluate(()=>window.voiceFixture.mic),0);
  await page.getByRole('button',{name:'播放问题',exact:true}).click();await page.getByRole('button',{name:'停止朗读',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'开始录音',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'提交回答',exact:true}).isDisabled(),true);await page.getByRole('button',{name:'停止朗读',exact:true}).click();
  await page.getByRole('button',{name:'开始录音',exact:true}).click();await page.getByRole('button',{name:'停止并完成转录',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'提交回答',exact:true}).isDisabled(),true);
  await page.getByText('临时字幕（尚未写入回答）：临时字幕').waitFor();await page.screenshot({path:`${output}/voice-recording-${width}.png`,fullPage:true});assert.equal(await answer.inputValue(),'已有人工编辑');await page.getByRole('button',{name:'停止并完成转录',exact:true}).click();await page.getByText(/转录完成，请核对/).waitFor();assert.equal(await answer.inputValue(),'已有人工编辑\n项目方案具有可验证的实施步骤。');assert(!writes.some(write=>write.path.endsWith('/answers')));
  await answer.fill('用户核对后编辑');await page.getByRole('button',{name:'开始录音',exact:true}).click();await page.getByRole('button',{name:'停止并完成转录',exact:true}).waitFor();await page.evaluate(()=>window.fixtureSocket.emit({type:'error',message:'本机断线验证'}));await page.getByText(/本机断线验证/).waitFor();assert.equal(await page.getByRole('button',{name:'文字回答',exact:true}).getAttribute('aria-pressed'),'true');await page.getByText(/已确认字幕：项目方案具有可验证的实施步骤/).waitFor();assert.equal(await answer.inputValue(),'用户核对后编辑');assert((await page.evaluate(()=>window.voiceFixture.stops))>=2);await page.getByRole('button',{name:'文字回答',exact:true}).click();assert.equal(await page.getByRole('button',{name:'提交回答',exact:true}).isEnabled(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.deepEqual(errors,[]);await page.screenshot({path:`${output}/voice-defense-${width}.png`,fullPage:true});readOnly=true;await page.reload();await page.getByText(/其他成员只读/).waitFor();assert.equal(await page.getByRole('button',{name:'语音回答',exact:true}).count(),0);assert.equal(await page.getByRole('textbox',{name:'回答当前问题'}).count(),0);results.push({width,pass:true,checks:['explicit microphone','TTS mutual exclusion','partial/final dedup','editable transcript','no auto submit','failure preserves text','mic cleanup','no overflow','no page errors','read-only controls hidden']});await context.close();
 }}finally{await browser.close();}writeFileSync(`${output}/result.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results));
})().catch(error=>{console.error(error);process.exitCode=1;});
