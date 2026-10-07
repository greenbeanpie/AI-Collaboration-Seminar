import http from 'node:http';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const output=path.resolve(process.env.BUWEI_ANDROID_OUTPUT_DIR??path.join(repo,'output/android-smoke'));await mkdir(output,{recursive:true});
const artifacts=path.resolve(process.env.BUWEI_ANDROID_ARTIFACT_DIR??path.join(repo,'output/android-client'));
const release=path.join(artifacts,'buwei-0.1.0-x86_64-release.apk'),debug=path.join(artifacts,'buwei-0.1.0-x86_64-debug.apk');
const appId='cn.buwei.mobile',adb=process.env.BUWEI_ADB_PATH??'D:/Android/Sdk/platform-tools/adb.exe';let serial=process.env.BUWEI_ADB_SERIAL;
function adbCall(args,timeout=10000){const r=spawnSync(adb,[...(serial?['-s',serial]:[]),...args],{encoding:'utf8',windowsHide:true,timeout,maxBuffer:8*1024*1024});if(r.status!==0)throw new Error(String(r.error??r.stderr));return r.stdout;}
if(!serial){const list=adbCall(['devices']).split(/\r?\n/).map(row=>row.match(/^(\S+)\s+device$/)?.[1]).filter(Boolean);assert.equal(list.length,1);serial=list[0];}
const nativeReport=JSON.parse(await readFile(path.join(output,'android-smoke-report.json'),'utf8'));assert.equal(nativeReport.passed,true);
const row=nativeReport.checks.find(check=>check.name==='synthetic upload spool loaded after restart')?.evidence;assert.match(row,/^[a-f0-9-]{36}$/);
const origin='http://127.0.0.1:5173';
const marker=randomUUID();
const dist=path.resolve(process.env.BUWEI_FRONTEND_DIST??path.join(artifacts,'../../frontend/dist'));
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
const fixtureServer=http.createServer(async(req,res)=>{try{
 const url=new URL(req.url,origin);
 if(url.pathname==='/_upgrade/cookie'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store','Set-Cookie':'buwei_android_upgrade_smoke='+marker+'; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400'});res.end('{"ok":true}');return;}
 if(url.pathname.startsWith('/api/')){let data={items:[],nextCursor:null};
  if(url.pathname==='/api/v1/auth/session')data={user:{id:'55555555-5555-4555-8555-555555555555',displayName:'Android 离线验证账户',username:'android-offline-fixture',email:null,isAdmin:false,role:'user'}};
  if(url.pathname==='/api/v1/capabilities')data={features:{aiEnabled:false},limits:{}};
  res.writeHead(url.pathname.endsWith('/offline-sync')?503:200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(url.pathname.endsWith('/offline-sync')?{error:{code:'SYNTHETIC_HOLD',message:'Queue retained',retryable:true},requestId:'replacement-fixture'}:{data,requestId:'replacement-fixture'}));return;}
 const relative=url.pathname==='/'||url.pathname==='/app'||url.pathname.startsWith('/app/')||url.pathname==='/login'?'index.html':decodeURIComponent(url.pathname).slice(1);
 const file=path.resolve(dist,relative);if(!file.startsWith(dist+path.sep)){res.writeHead(403);res.end();return;}
 const bytes=await readFile(file);res.writeHead(200,{'Content-Type':mime[path.extname(file)]??'application/octet-stream','Cache-Control':'no-store','Service-Worker-Allowed':'/'});res.end(bytes);
 }catch{res.writeHead(404);res.end();}});
let socket,pending=new Map(),id=0;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function connect(){let target;for(let i=0;i<45;i++){try{const pid=adbCall(['shell','pidof',appId]).trim(),unix=adbCall(['shell','cat','/proc/net/unix']),remote=unix.match(new RegExp('@(webview_devtools_remote_'+pid+')\\b'))?.[1];if(remote){adbCall(['forward','tcp:9224','localabstract:'+remote]);const tabs=await(await fetch('http://127.0.0.1:9224/json',{signal:AbortSignal.timeout(2500)})).json();target=tabs.find(t=>t.type==='page'&&t.url.startsWith(origin));if(target)break;}}catch{}await delay(1000);}assert.ok(target,'Debug app offline WebView must remain reachable');socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});socket.addEventListener('message',e=>{const message=JSON.parse(e.data),request=pending.get(message.id);if(request){pending.delete(message.id);message.error?request.reject(new Error(message.error.message)):request.resolve(message.result);}});}
function cdp(method,params={}){return new Promise((resolve,reject)=>{const commandId=++id;const timer=setTimeout(()=>{pending.delete(commandId);reject(new Error('CDP timeout '+method));},10000);pending.set(commandId,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});socket.send(JSON.stringify({id:commandId,method,params}));});}
async function evaluate(expression){const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description??String(r.exceptionDetails.exception?.value??r.exceptionDetails.text));return r.result.value;}
function digest(){const stdout=adbCall(['shell','am','instrument','-w','-e','op','digest','-e','row',row,'cn.buwei.mobile.test/cn.buwei.mobile.test.FixtureInstrumentation']);const r=Object.fromEntries([...stdout.matchAll(/INSTRUMENTATION_RESULT:\s*(\w+)=(.*)/g)].map(m=>[m[1],m[2].trim()]));assert.equal(r.status,'passed',stdout);return{sha256:r.sha256,bytes:Number(r.bytes)};}
async function ready(){for(let i=0;i<45;i++){try{if(await evaluate("location.origin==='http://127.0.0.1:5173' && document.readyState==='complete' && Boolean(document.getElementById('root')?.childElementCount)"))return;}catch{}await delay(1000);}throw new Error('Actual frontend did not initialize after replacement');}
const start=()=>adbCall(['shell','am','start','-n',appId+'/.MainActivity']);
const apkHashes={release:createHash('sha256').update(await readFile(release)).digest('hex'),debug:createHash('sha256').update(await readFile(debug)).digest('hex')};
const report={apkHashes,startedAt:new Date().toISOString(),appId,serial,checks:[],limitations:['Same version0.1.0 signed APK replacement; this is not a two-semantic-version Android upgrade.','Debug helper APK is separate and never distributed with release.','No uninstall, clear-data, root setting or UI automation is used.']};
const check=(name,evidence)=>{report.checks.push({name,passed:true,evidence});console.log('PASS '+name);};
let replaced=false;
try{
  // All prerequisite files and APK hashes are read before opening the listener.
  // Only this server is closed; an occupied port never triggers process termination.
  await new Promise((resolve,reject)=>{
    const onError=error=>reject(error.code==='EADDRINUSE'?new Error('Android upgrade fixture requires 127.0.0.1:5173, but that port is already occupied. Stop the other server yourself and retry; no external process was terminated.',{cause:error}):error);
    fixtureServer.once('error',onError);
    fixtureServer.listen(5173,'127.0.0.1',()=>{fixtureServer.removeListener('error',onError);resolve();});
  });
  assert.match(adbCall(['shell','dumpsys','package',appId]),/(?:flags|pkgFlags)=\[[^\]]*DEBUGGABLE/);
  const before=digest();adbCall(['shell','am','force-stop',appId]);start();await connect();await ready();report.pageEvidence??=[];report.pageEvidence.push(await evaluate('({href:location.href,origin:location.origin,documentURL:document.URL,title:document.title,readyState:document.readyState,controller:navigator.serviceWorker.controller?.scriptURL})'));check('native fixture digest captured before replacement',before);
  const accountId='55555555-5555-4555-8555-555555555555',key=accountId+':/_smoke/android-upgrade-marker';
  await evaluate(`(async()=>{localStorage.setItem('buwei:android-upgrade-smoke',${JSON.stringify(marker)});const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('buwei-offline-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});await new Promise((resolve,reject)=>{const tx=db.transaction('snapshots','readwrite');tx.objectStore('snapshots').put({key:${JSON.stringify(key)},accountId:${JSON.stringify(accountId)},url:'/_smoke/android-upgrade-marker',data:{marker:${JSON.stringify(marker)}},savedAt:new Date().toISOString()});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();return true;})()`);
  assert.equal(await evaluate("fetch('/_upgrade/cookie',{cache:'no-store'}).then(response=>response.ok)"),true);
  assert.equal(await evaluate("localStorage.getItem('buwei:android-upgrade-smoke')"),marker);check('localStorage marker immediately read back before replacement',true);
  // localStorage and DevTools cookie writes can be asynchronously flushed by WebView.
  // Establish a restart-surviving baseline before attributing loss to APK replacement.
  adbCall(['shell','am','start','-a','android.intent.action.MAIN','-c','android.intent.category.HOME']);await delay(6500);
  socket.close();adbCall(['shell','am','force-stop',appId]);start();await connect();await ready();
  assert.equal(await evaluate("localStorage.getItem('buwei:android-upgrade-smoke')"),marker);
  check('new web marker survives baseline Debug process restart before APK replacement',true);
  const priorCookies=(await cdp('Network.getCookies',{urls:[origin]})).cookies;
  const baselineCookie=priorCookies.find(cookie=>cookie.name==='buwei_android_upgrade_smoke');assert.equal(baselineCookie?.value,marker);assert.equal(baselineCookie.httpOnly,true);check('HttpOnly HTTP-set cookie survives baseline process restart',true);
  const beforeSession=priorCookies.find(cookie=>cookie.name==='ai_office_session');assert.ok(beforeSession?.httpOnly);check('HttpOnly cookie and durable web storage markers captured',true);
  socket.close();await delay(100);adbCall(['shell','am','start','-a','android.intent.action.MAIN','-c','android.intent.category.HOME']);await delay(500);assert.match(adbCall(['install','-r',release],120000),/Success/);replaced=true;start();await delay(2000);
  assert.ok(adbCall(['shell','pidof',appId]).trim());assert.doesNotMatch(adbCall(['shell','dumpsys','package',appId]),/(?:flags|pkgFlags)=\[[^\]]*DEBUGGABLE/);check('same-certificate release replaces debug and launches',true);
  assert.match(adbCall(['install','-r',debug],120000),/Success/);adbCall(['shell','am','force-stop',appId]);start();await delay(700);await connect();await ready();
  assert.equal(await evaluate("localStorage.getItem('buwei:android-upgrade-smoke')"),marker);
  assert.equal(await evaluate(`(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('buwei-offline-v1',1);r.onsuccess=()=>resolve(r.result);});try{return await new Promise(resolve=>{const r=db.transaction('snapshots').objectStore('snapshots').get(${JSON.stringify(key)});r.onsuccess=()=>resolve(r.result?.data.marker);});}finally{db.close();}})()`),marker);check('localStorage and actual offline IndexedDB marker survive both replacements',true);
  const afterCookies=(await cdp('Network.getCookies',{urls:[origin]})).cookies;
  const cookie=afterCookies.find(c=>c.name==='buwei_android_upgrade_smoke');assert.equal(cookie?.value,marker);assert.equal(cookie.httpOnly,true);assert.equal(afterCookies.find(c=>c.name==='ai_office_session')?.value,beforeSession.value);check('HttpOnly marker and existing synthetic login cookie retained',true);
  socket.close();await delay(100);assert.deepEqual(digest(),before);check('native blob unchanged after both APK replacements',before);
  report.passed=true;report.completedAt=new Date().toISOString();
}catch(error){report.passed=false;report.error=String(error);process.exitCode=1;}
finally{
  socket?.close();
  if(replaced){try{assert.match(adbCall(['install','-r',release],120000),/Success/);start();await delay(1500);assert.ok(adbCall(['shell','pidof',appId]).trim());report.releaseRestored=true;check('production release restored without clearing data',true);}catch(error){report.releaseRestored=false;report.restoreError=String(error);process.exitCode=1;}}
  if(fixtureServer.listening) await new Promise(resolve=>{fixtureServer.close(resolve);fixtureServer.closeAllConnections();});
  await writeFile(path.join(output,'android-replacement-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,releaseRestored:report.releaseRestored,error:report.error??null,report:path.join(output,'android-replacement-report.json')}));
}
