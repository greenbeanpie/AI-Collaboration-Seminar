import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// API-only verification: ADB process/file commands and CDP Runtime.evaluate; no UI input.
const adbPath = process.env.BUWEI_ADB_PATH ?? 'D:/Android/Sdk/platform-tools/adb.exe';
const appId = process.env.BUWEI_ANDROID_APP_ID ?? 'cn.buwei.mobile';
assert.match(appId, /^[a-z][a-z0-9_.]+$/);
let serial = process.env.BUWEI_ADB_SERIAL;
const invokeAdb = (args, input, binary = false) => {
  const result = spawnSync(adbPath, [...(serial ? ['-s', serial] : []), ...args], { input, encoding: binary ? undefined : 'utf8', maxBuffer: 128 * 1024 * 1024, windowsHide: true, timeout: 10000 });
  if (result.status !== 0) throw new Error('ADB ' + args[0] + ': ' + String(result.error??result.stderr));
  return result.stdout;
};
if (!serial) {
  const devices = invokeAdb(['devices']).split(/\r?\n/).map(line => line.match(/^(\S+)\s+device$/)?.[1]).filter(Boolean);
  assert.equal(devices.length, 1, 'Set BUWEI_ADB_SERIAL when zero/multiple online devices'); serial = devices[0];
}
// This must succeed before any synthetic private cache write: release apps cannot run-as.
assert.match(invokeAdb(['shell','dumpsys','package',appId]), /(?:pkgFlags|flags)=\[[^\]]*DEBUGGABLE/,'Only debug APKs are permitted');
const instrumentation=process.argv.includes('--instrumentation');
let privateFiles=true, privateFileError;try{invokeAdb(['shell','run-as',appId,'pwd']);}catch(error){privateFiles=false;privateFileError=String(error);}
invokeAdb(['reverse', 'tcp:5173', 'tcp:5173']);
const origin = 'http://127.0.0.1:5173';
const output = path.resolve(process.env.BUWEI_ANDROID_OUTPUT_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../output/android-smoke'));
await mkdir(output, { recursive: true });
const fixture = await (await fetch(origin + '/_smoke/fixture')).json();
const report = { startedAt: new Date().toISOString(), platform: 'android', native: true, appId, serial, checks: [], limitations: ['System SAF picker/export interaction is not exercised.', 'Synthetic spool upload bypasses picker only; real Rust multipart and task registration are exercised.', 'No production backend, credentials or paid providers are exercised.', 'BlueStacks results are not physical Android device acceptance.'] };
if(!privateFiles&&!instrumentation)report.limitations.push('Debug run-as unavailable; exact disk-byte and synthetic multipart upload tests skipped: '+privateFileError);
const check = (name, evidence) => { report.checks.push({ name, passed: true, evidence }); console.log('PASS ' + name); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const controls = async value => { const r = await fetch(origin + '/_smoke/control', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}); assert.equal(r.status,200); };
const stats = async () => (await fetch(origin + '/_smoke/stats')).json();
let socket, pending = new Map(), nextId = 0;
async function connect() {
  let target;
  for (let attempt = 0; attempt < 45; attempt++) {
    try {
      const pid = invokeAdb(['shell', 'pidof', appId]).trim().split(' ')[0];
      const sockets = invokeAdb(['shell', 'cat', '/proc/net/unix']);
      const socketName = sockets.match(new RegExp('@(webview_devtools_remote_' + pid + ')\\b'))?.[1];
      if (socketName) {
        invokeAdb(['forward', 'tcp:9224', 'localabstract:' + socketName]);
        const tabs = await (await fetch('http://127.0.0.1:9224/json',{signal:AbortSignal.timeout(2500)})).json();
        target = tabs.find(tab => tab.url.startsWith(origin));
        if (target) break;
      }
    } catch { /* WebView starts asynchronously. */ }
    await wait(1000);
  }
  assert.ok(target, 'Debug WebView with loopback fixture must be available');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject) => {socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  socket.addEventListener('message', event => {const response=JSON.parse(event.data);const task=pending.get(response.id);if(task){pending.delete(response.id);response.error?task.reject(new Error(response.error.message)):task.resolve(response.result);}});
  socket.addEventListener('close', () => {for(const task of pending.values())task.reject(new Error('CDP connection closed'));pending.clear();});
  if(!await evaluate('Boolean(window.smoke)')){await evaluate(`(async()=>{for(const registration of await navigator.serviceWorker.getRegistrations())await registration.unregister();for(const name of await caches.keys())await caches.delete(name);})()`);await cdp('Page.reload');await wait(1000);}
  for(let attempt=0;attempt<30;attempt++){try{if(await evaluate('window.smoke?.ready'))return;}catch{}await wait(1000);}
  throw new Error('Native fixture initialization failed: '+JSON.stringify(await evaluate('({url:location.href,text:document.body?.textContent?.slice(0,900),bridge:Boolean(window.__TAURI_INTERNALS__),events:window.smoke?.events})')));
}
function cdp(method, params = {}) {
  const id=++nextId;
  return new Promise((resolve,reject) => {const timeout=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timed out: '+method));},120000);pending.set(id,{resolve:v=>{clearTimeout(timeout);resolve(v);},reject:e=>{clearTimeout(timeout);reject(e);}});socket.send(JSON.stringify({id,method,params}));});
}
async function evaluate(expression) {
  const result=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description??String(result.exceptionDetails.exception?.value??result.exceptionDetails.text));
  return result.result.value;
}
const invoke=(command,args={})=>evaluate('window.smoke.invoke('+JSON.stringify(command)+','+JSON.stringify(args)+')');
const rows=()=>invoke('desktop_list_files',{projectId:fixture.projectId});
const reject=async(name,command,args={})=>{let reason;try{await invoke(command,args);}catch(e){reason=String(e);}assert.ok(reason,name+' must reject');check(name,reason);};
const start=()=>invokeAdb(['shell','am','start','-n',appId+'/.MainActivity']);
async function restart() {socket?.close();await wait(100);invokeAdb(['shell','am','force-stop',appId]);start();await connect();}
function instrument(op,row){
  const component=process.env.BUWEI_ANDROID_INSTRUMENTATION??'cn.buwei.mobile.test/cn.buwei.mobile.test.FixtureInstrumentation';
  assert.match(component,/^[a-z0-9_.]+\/[a-zA-Z0-9_.]+$/);
  const stdout=invokeAdb(['shell','am','instrument','-w','-e','op',op,...(row?['-e','row',row]:[]),component]);
  const result=Object.fromEntries([...stdout.matchAll(/INSTRUMENTATION_RESULT:\s*(\w+)=(.*)/g)].map(match=>[match[1],match[2].trim()]));
  assert.equal(result.status,'passed',stdout);return result;
}
const readPrivate=relative=>invokeAdb(['exec-out','run-as',appId,'cat',relative],undefined,true);
const writePrivate=(relative,bytes)=>{assert.match(relative,/^attachments\/[a-f0-9-]{36}\/(?:[a-f0-9-]{36}\.blob|manifest\.json)$/);invokeAdb(['exec-out','run-as',appId,'sh','-c','cat > '+relative],bytes,true);};
try {
  start(); await connect(); await evaluate("window.smoke.login('a')");await invoke('mobile_set_foreground',{foreground:true});await wait(500);
  const hello=await invoke('desktop_hello');assert.equal(hello.platform,'android');assert.equal(hello.capabilities.updater,false);assert.equal(hello.capabilities.tray,false);check('Android capabilities handshake',hello);
  assert.equal(await evaluate("document.cookie.includes('ai_office_session')"),false);check('HttpOnly session remains hidden from JavaScript',true);
  await reject('internal native CookieManager command denied','plugin:buwei-native-files|session');
  await reject('internal native arbitrary export path denied','plugin:buwei-native-files|export_file',{path:'/data/data/'+appId+'/shared_prefs',name:'leak'});
  await reject('arbitrary filesystem plugin denied','plugin:fs|read_text_file',{path:'/proc/self/environ'});
  await reject('extra WebView creation denied','plugin:webview|create_webview_window',{options:{label:'extra',url:'https://example.invalid'}});
  await reject('unsupported bridge protocol rejected','desktop_report_state',{state:{protocol:2,accountId:fixture.accountA,dirty:false,busy:false,durable:true}});
  await reject('cache traversal rejected','desktop_cache_project',{projectId:fixture.projectId,files:[{fileId:'../escape',name:'escape',sizeBytes:1}]});
  for(const row of (await rows()).filter(row=>row.direction==='download'))await invoke('desktop_remove_file',{projectId:fixture.projectId,id:row.id,discard:false});
  await controls({failDownloadOnce:true,downloadFailed:false,chunkDelayMs:10});
  const queued=await invoke('desktop_cache_project',{projectId:fixture.projectId,files:[{fileId:fixture.downloadId,name:'native-download.txt',sizeBytes:fixture.sizeBytes}]});
  assert.ok(queued.some(row=>row.fileId===fixture.downloadId&&row.status==='waiting'));check('native persistent download created',queued.length);
  await reject('interrupted download reports failure','desktop_transfer_files',{projectId:fixture.projectId});
  const partial=(await rows()).find(row=>row.fileId===fixture.downloadId);assert.equal(partial.status,'failed');assert.ok(partial.transferredBytes>0&&partial.transferredBytes<fixture.sizeBytes);check('interrupted download keeps partial bytes',partial.transferredBytes);
  await invoke('desktop_transfer_files',{projectId:fixture.projectId});
  const complete=(await rows()).find(row=>row.fileId===fixture.downloadId);assert.equal(complete.status,'complete');
  assert.ok((await stats()).events.some(e=>e.native&&e.range&&Number(e.range.match(/bytes=(\d+)/)?.[1])>0));check('native download resumes using Range',complete.transferredBytes);
  if(privateFiles){const actual=readPrivate('attachments/'+fixture.accountA+'/'+complete.id+'.blob');assert.deepEqual(actual,await readFile(fixture.downloadPath));check('Android private cache byte-for-byte match',actual.length);}
  else if(instrumentation){socket.close();await wait(100);const digest=instrument('digest',complete.id);assert.equal(digest.sha256,createHash('sha256').update(await readFile(fixture.downloadPath)).digest('hex'));assert.equal(Number(digest.bytes),fixture.sizeBytes);check('Android private cache exact SHA256 via test-only instrumentation',digest.sha256);await restart();}
  await cdp('Page.reload');await wait(1000);for(let attempt=0;attempt<30;attempt++){try{if(await evaluate('window.smoke?.ready'))break;}catch{}await wait(1000);}assert.equal((await rows()).find(row=>row.id===complete.id)?.status,'complete');check('cache survives WebView reload',complete.id);
  await restart();assert.equal((await rows()).find(row=>row.id===complete.id)?.status,'complete');check('cache and HttpOnly login survive process restart',complete.id);
  await evaluate("window.smoke.login('b')");assert.ok(!(await rows()).some(row=>row.id===complete.id));check('account B cannot enumerate account A cache',true);
  await reject('account B cannot export account A cache','desktop_export_file',{projectId:fixture.projectId,id:complete.id});
  await evaluate("window.smoke.login('a')");assert.ok((await rows()).some(row=>row.id===complete.id));check('account A cache retained after switch',true);
  await invoke('desktop_remove_file',{projectId:fixture.projectId,id:complete.id,discard:false});
  await controls({failDownloadOnce:false,chunkDelayMs:2});
  await invoke('desktop_cache_project',{projectId:fixture.projectId,files:[{fileId:fixture.downloadId,name:'background-download.txt',sizeBytes:fixture.sizeBytes}]});
  await invoke('mobile_set_foreground',{foreground:false});
  await reject('background native transfer blocked','desktop_transfer_files',{projectId:fixture.projectId});
  await invoke('mobile_set_foreground',{foreground:true});
  for(let attempt=0;attempt<60&&(await rows()).some(row=>row.direction==='download'&&row.status!=='complete');attempt++)await wait(500);
  assert.ok((await rows()).filter(row=>row.direction==='download').every(row=>row.status==='complete'));check('foreground resumes queued download',true);
  const lifecycleRows=(await rows()).filter(row=>row.direction==='download');
  for(const row of lifecycleRows)await invoke('desktop_remove_file',{projectId:fixture.projectId,id:row.id,discard:false});
  invokeAdb(['shell','am','start','-a','android.intent.action.MAIN','-c','android.intent.category.HOME']);await wait(700);
  // Page has no visibility handler: native JNI lifecycle must independently deny transfer.
  await invoke('desktop_cache_project',{projectId:fixture.projectId,files:[{fileId:fixture.downloadId,name:'lifecycle-download.txt',sizeBytes:fixture.sizeBytes}]});
  await reject('native Activity pause independently blocks transfer','desktop_transfer_files',{projectId:fixture.projectId});
  start();await wait(700);await invoke('mobile_set_foreground',{foreground:true});
  for(let attempt=0;attempt<60&&(await rows()).some(row=>row.direction==='download'&&row.status!=='complete');attempt++)await wait(500);
  assert.ok((await rows()).filter(row=>row.direction==='download').every(row=>row.status==='complete'));check('native Activity resume permits recovery',true);
  if((privateFiles||instrumentation)&&!process.argv.includes('--skip-upload')) {
    const row={id:randomUUID(),accountId:fixture.accountA,projectId:fixture.projectId,taskId:fixture.taskId,name:'synthetic-spool-upload.txt',sizeBytes:fixture.sizeBytes,direction:'upload',status:'waiting',transferredBytes:0,error:null,sessionId:null,fileId:null};
    if(privateFiles){
      const manifestPath='attachments/'+fixture.accountA+'/manifest.json';
      const manifest=JSON.parse(readPrivate(manifestPath).toString('utf8'));
      writePrivate('attachments/'+fixture.accountA+'/'+row.id+'.blob',await readFile(fixture.uploadPath));writePrivate(manifestPath,Buffer.from(JSON.stringify([...manifest,row])));
    }else{socket.close();await wait(100);const seed=instrument('seed-upload');row.id=seed.rowId;assert.match(row.id,/^[a-f0-9-]{36}$/);assert.equal(Number(seed.bytes),fixture.sizeBytes);assert.equal(seed.sha256,createHash('sha256').update(await readFile(fixture.uploadPath)).digest('hex'));}
    await restart();assert.ok((await rows()).some(item=>item.id===row.id));check('synthetic upload spool loaded after restart',row.id);
    await reject('pending upload protected from ordinary cleanup','desktop_remove_file',{projectId:fixture.projectId,id:row.id,discard:false});
    await controls({failPartOnce:true,partFailed:false,failRegistrationOnce:false});
    await reject('accepted-part response interruption retains queue','desktop_transfer_files',{projectId:fixture.projectId});assert.ok((await invoke('desktop_pending_files')).pendingUploads>0);
    await controls({failRegistrationOnce:true,registrationFailed:false});
    await reject('registration conflict keeps submission blocked','desktop_transfer_files',{projectId:fixture.projectId});assert.ok((await invoke('desktop_pending_files')).pendingUploads>0);
    await invoke('desktop_resume_file',{projectId:fixture.projectId,id:row.id});
    const finished=(await rows()).find(item=>item.id===row.id);assert.equal(finished.status,'complete');
    const value=await stats(),session=value.sessions.find(item=>item.fileId===finished.fileId);assert.ok(session.parts.every(part=>part.accepts===1));assert.ok(value.files.find(item=>item.fileId===finished.fileId)?.registered);check('native multipart reconciles accepted parts and registers',session.parts);
  }
  const requests=await stats();assert.ok(requests.events.some(e=>e.native&&e.cookiePresent&&e.path==='/api/v1/auth/session'));check('Rust receives native HttpOnly cookie for authenticated requests',true);
  report.passed=true;report.completedAt=new Date().toISOString();await writeFile(path.join(output,'server-stats.json'),JSON.stringify(requests,null,2));
} catch(error) {report.passed=false;report.error=String(error);process.exitCode=1;}
finally {await writeFile(path.join(output,'android-smoke-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,report:path.join(output,'android-smoke-report.json'),error:report.error??null}));socket?.close();}
