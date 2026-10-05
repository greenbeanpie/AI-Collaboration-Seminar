// Real audio only. No video, TTS or repeated paid submissions.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const option=name=>process.argv[process.argv.indexOf(name)+1];
assert(process.argv.includes('--production')&&process.argv.includes('--credentials'),'Pass --production and private --credentials');
const checkOnly=process.argv.includes('--check-config');
assert(checkOnly||process.argv.includes('--audio'),'Supply a synthetic WAV with --audio');
const origin=process.env.RELEASE_URL||'https://greenbp-team-office.hddhp.workers.dev';
assert(['https://team.greenbp.dpdns.org','https://greenbp-team-office.hddhp.workers.dev'].includes(origin));
const output=resolve(process.argv.includes('--output')?option('--output'):'output/mimo-release');mkdirSync(output,{recursive:true});
const report={origin,result:'RUNNING',checks:[],limitations:['Real video recognition is not tested.'],draftId:null,fileId:null,jobId:null,configVersion:null,summary:null};
let cookie='',originalStrategies,temporaryVersion;
async function request(path,method='GET',body,raw=false){
 const response=await fetch(origin+'/api/v1'+path,{method,headers:{...(method==='POST'?{'idempotency-key':randomUUID()}:{}),...(cookie?{cookie}:{}),...(body!==undefined?{'content-type':raw?'audio/wav':'application/json'}:{})},body:body===undefined?undefined:raw?body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
 if(response.headers.has('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
 const envelope=await response.json();
 if(!response.ok)throw new Error(`${method} ${path}: HTTP ${response.status}; ${envelope.error?.code??'unknown'}`);
 return envelope.data;
}
async function restoreStrategy(){
 if(temporaryVersion===undefined)return;
 // A concurrent administrator save must never be overwritten by cleanup.
 await request('/admin/ai-config','PUT',{expectedVersion:temporaryVersion,processingStrategies:originalStrategies});
 temporaryVersion=undefined;report.checks.push('Original processing strategy restored; uploaded job retains frozen MiMo configuration');
}
try{
 const saved=JSON.parse(readFileSync(resolve(option('--credentials')),'utf8')),account=saved.accounts?.production;
 assert(account?.username&&account?.password,'Stored production administrator credentials missing');
 await request('/auth/sessions','POST',{account:account.username,password:account.password});report.checks.push('Existing administrator login');
 const loaded=await request('/admin/ai-config');report.configVersion=loaded.version;
 assert(loaded.config.mimoMediaUnderstanding!==undefined,'Save the optional MiMo configuration in administrator settings');
 assert(loaded.config.mimoMediaUnderstanding.keyConfigured,'Configure the official pay-as-you-go MiMo API key in administrator settings');
 assert.equal(loaded.config.mimoMediaUnderstanding.model,'mimo-v2.6-pro');
 if(checkOnly){report.result='CONFIG_READY';report.checks.push('MiMo key configured; no inference or setting mutation performed');}
 else{
  assert(loaded.enabled,'Existing AI configuration must already be enabled');
  const fixture=readFileSync(resolve(option('--audio')));
  assert(fixture.length<2*1024*1024&&fixture.toString('ascii',0,4)==='RIFF'&&fixture.toString('ascii',8,12)==='WAVE','Use one synthetic WAV under 2 MiB');
  const strategies=loaded.config.processingStrategies??{audioFiles:loaded.config.audioProcessingStrategy==='gemini-only'?'media-only':'whisper-first',rehearsal:'text'};
  if(strategies.audioFiles!=='mimo-only'){
   assert(process.argv.includes('--select-mimo-for-test'),'Select MiMo explicitly, or pass --select-mimo-for-test for a temporary strategy change');
   originalStrategies=strategies;
   const selected=await request('/admin/ai-config','PUT',{expectedVersion:loaded.version,processingStrategies:{...strategies,audioFiles:'mimo-only'}});
   temporaryVersion=selected.version;report.configVersion=selected.version;
  }
  const draft=await request('/creation-drafts','POST',{name:'MiMo synthetic audio verification',description:'Synthetic audio only; no real project created.'});report.draftId=draft.id;report.fileId=randomUUID();
  let current=await request(`/creation-drafts/${draft.id}/files/${report.fileId}?expectedRevision=${draft.revision}&name=synthetic-mimo-audio.wav`,'PUT',fixture,true);
  await restoreStrategy();
  const deadline=Date.now()+60000;
  for(;;){
   const file=current.files.find(item=>item.id===report.fileId);report.jobId=file?.mediaJobId??report.jobId;
   if(file?.mediaStatus==='ready'){
    assert(file.textReady&&file.mediaSummary?.complete);report.summary=file.mediaSummary;
    if(process.argv.includes('--expect'))assert(JSON.stringify(file.mediaSummary).includes(option('--expect')),'Expected spoken content is absent from audio summary');
    report.checks.push('Real MiMo audio summary completed','Audio output returned in creation draft');report.result='PASS';break;
   }
   if(file?.mediaStatus==='failed')throw new Error('MiMo audio processing failed; original job retained, no paid replay');
   if(Date.now()>=deadline){report.result='PENDING';report.limitations.push('One-minute observation expired; original job retained and no duplicate submitted.');break;}
   await new Promise(resolve=>setTimeout(resolve,2000));current=await request(`/creation-drafts/${draft.id}`);
  }
  if(report.result==='PASS'){current=await request(`/creation-drafts/${draft.id}`);await request(`/creation-drafts/${draft.id}/state`,'POST',{expectedRevision:current.revision,status:'cancelled'});report.checks.push('Terminal synthetic draft cancelled');}
 }
}catch(error){report.result='FAILED';report.limitations.push(error.message);process.exitCode=1;}
finally{
 if(temporaryVersion!==undefined){try{await restoreStrategy();}catch{report.limitations.push('Concurrent configuration change or network failure prevented automatic strategy restoration; inspect administrator settings.');process.exitCode=1;}}
 if(cookie){try{await request('/auth/session','DELETE');}catch{/* Readout does not require logout success. */}}
 writeFileSync(resolve(output,checkOnly?'config-readiness.json':'production-audio.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}
