import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Actual compiled React/PWA, fake local backend, API-only ADB/CDP control.
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const dist=path.resolve(process.env.BUWEI_FRONTEND_DIST??path.join(repo,'frontend/dist'));
await access(path.join(dist,'index.html'));await access(path.join(dist,'sw.js'));
const output=path.resolve(process.env.BUWEI_ANDROID_WEB_OUTPUT_DIR??path.join(repo,'output/android-web-smoke'));await mkdir(output,{recursive:true});
const appId=process.env.BUWEI_ANDROID_APP_ID??'cn.buwei.mobile';assert.match(appId,/^[a-z][a-z0-9_.]+$/);
const adb=process.env.BUWEI_ADB_PATH??'D:/Android/Sdk/platform-tools/adb.exe';let serial=process.env.BUWEI_ADB_SERIAL;
function adbCall(args){const result=spawnSync(adb,[...(serial?['-s',serial]:[]),...args],{encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024,timeout:10000});if(result.status!==0)throw new Error(String(result.error??result.stderr));return result.stdout;}
if(!serial){const devices=adbCall(['devices']).split(/\r?\n/).map(line=>line.match(/^(\S+)\s+device$/)?.[1]).filter(Boolean);assert.equal(devices.length,1);serial=devices[0];}
assert.match(adbCall(['shell','dumpsys','package',appId]),/(?:pkgFlags|flags)=\[[^\]]*DEBUGGABLE/,'Only debug APKs are permitted');adbCall(['reverse','tcp:5173','tcp:5173']);
const origin='http://127.0.0.1:5173',now=new Date().toISOString();
const userId='55555555-5555-4555-8555-555555555555',projectId='66666666-6666-4666-8666-666666666666',taskId='77777777-7777-4777-8777-777777777777';
const user={id:userId,displayName:'Android 离线验证账户',username:'android-offline-fixture',email:null,isAdmin:false,role:'user'};
const permissions={teamManage:true,taskManage:true,resourceManage:true,scoreInitiate:true,scoreCorrect:true};
const project={id:projectId,name:'Android 离线验证项目',description:'实际 React 与 ServiceWorker 缓存',status:'active',myRole:'owner',permissions,revision:1,deadlineDate:null,deadlinePrecision:'unknown'};
const task={taskId,projectId,title:'联网准备的 Android 任务',detail:'程序化离线恢复验证',criteria:'',effortHours:1,assigneeId:null,status:'todo',lifecycleState:'open',revision:1,currentSubmissionId:null,parentTaskId:null,dueDate:null,duePrecision:'unknown',dependsOnTaskIds:[],unfinishedDependencyIds:[],createdAt:now,updatedAt:now};
const events=[];
const types={'.html':'text/html; charset=utf-8','.js':'application/javascript','.mjs':'application/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.woff':'font/woff'};
const server=http.createServer(async(req,res)=>{try{
  const url=new URL(req.url,origin);events.push({at:new Date().toISOString(),method:req.method,path:url.pathname});
  if(url.pathname.startsWith('/api/')){
    let data={items:[],nextCursor:null};
    if(url.pathname==='/api/v1/auth/session'){data={user};res.setHeader('Set-Cookie','ai_office_session=android-web-smoke; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400');}
    else if(url.pathname==='/api/v1/capabilities')data={features:{aiEnabled:false},limits:{},authentication:{mode:'password',passwordEnabled:true,invitationRequired:true}};
    else if(url.pathname==='/api/v1/projects')data={items:[project],nextCursor:null};
    else if(url.pathname==='/api/v1/projects/'+projectId)data=project;
    else if(url.pathname.endsWith('/members/me'))data={userId,role:'owner',permissions};
    else if(url.pathname.endsWith('/members'))data={items:[{userId,displayName:user.displayName,role:'owner'}],nextCursor:null};
    else if(url.pathname.endsWith('/goal'))data={projectId,title:'真实离线启动',detail:'服务器停止后重启 WebView',revision:1,graphRevision:1};
    else if(url.pathname.endsWith('/collaboration/settings'))data={aiCollaborationEnabled:false,assignmentMode:'manual',evaluationMode:'manual',planningMode:'manual',progressionMode:'manual',revision:1};
    else if(url.pathname.endsWith('/tasks'))data={items:[task],nextCursor:null};
    else if(url.pathname.endsWith('/tasks/'+taskId))data=task;
    else if(url.pathname.includes('/feedback'))data={version:0,feedback:'',history:[],items:[],nextCursor:null};
    else if(url.pathname.endsWith('/unread'))data={items:[],count:0,unreadCount:0};
    if(url.pathname.endsWith('/offline-sync')){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:'SYNTHETIC_SYNC_HOLD',message:'Synthetic queue intentionally retained',retryable:true},requestId:'android-web-fixture'}));return;}
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({data,requestId:'android-web-fixture'}));return;
  }
  const relative=url.pathname==='/'||(url.pathname==='/app'||url.pathname.startsWith('/app/'))||url.pathname==='/login'?'index.html':decodeURIComponent(url.pathname).slice(1);
  const file=path.resolve(dist,relative);if(file!==dist&&!file.startsWith(dist+path.sep)){res.writeHead(403);res.end();return;}
  const body=await readFile(file);res.writeHead(200,{'Content-Type':types[path.extname(file)]??'application/octet-stream','Cache-Control':'no-store','Service-Worker-Allowed':'/'});res.end(body);
}catch{res.writeHead(404);res.end('Not found');}});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(5173,'127.0.0.1',resolve);});
const report={startedAt:now,appId,serial,dist,frontendIndexSha256:createHash('sha256').update(await readFile(path.join(dist,'index.html'))).digest('hex'),checks:[],limitations:['Loopback backend stopped; no airplane-mode/network setting or UI automation used.','Queued edit is seeded through the existing IndexedDB schema; this tests durability and frontend optimistic consumption, not a form interaction.','Synthetic prepared project only; real account and production API untouched.','BlueStacks only, no physical Android device acceptance.']};
const check=(name,evidence)=>{report.checks.push({name,passed:true,evidence});console.log('PASS '+name);};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));let socket,pending=new Map(),nextId=0;
async function connect(){let target;for(let attempt=0;attempt<45;attempt++){try{const pid=adbCall(['shell','pidof',appId]).trim().split(' ')[0],unix=adbCall(['shell','cat','/proc/net/unix']),remote=unix.match(new RegExp('@(webview_devtools_remote_'+pid+')\\b'))?.[1];if(remote){adbCall(['forward','tcp:9224','localabstract:'+remote]);const targets=await(await fetch('http://127.0.0.1:9224/json',{signal:AbortSignal.timeout(2500)})).json();target=targets.find(row=>row.url.startsWith(origin));if(target)break;}}catch{}await delay(1000);}assert.ok(target,'Actual app WebView target must start');socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});socket.addEventListener('message',e=>{const response=JSON.parse(e.data),request=pending.get(response.id);if(request){pending.delete(response.id);response.error?request.reject(new Error(response.error.message)):request.resolve(response.result);}});socket.addEventListener('close',()=>{for(const request of pending.values())request.reject(new Error('CDP closed'));pending.clear();});}
function cdp(method,params={}){const id=++nextId;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout '+method));},120000);pending.set(id,{resolve:r=>{clearTimeout(timer);resolve(r);},reject:e=>{clearTimeout(timer);reject(e);}});socket.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const value=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(value.exceptionDetails)throw new Error(value.exceptionDetails.exception?.description??value.exceptionDetails.text);return value.result.value;}
async function until(expression,label,attempts=90){for(let i=0;i<attempts;i++){try{const value=await evaluate(expression);if(value)return value;}catch{}await delay(1000);}throw new Error('Timed out: '+label);}
const native=(cmd,args={})=>evaluate('window.__TAURI_INTERNALS__.invoke('+JSON.stringify(cmd)+','+JSON.stringify(args)+')');
const start=()=>adbCall(['shell','am','start','-n',appId+'/.MainActivity']);
const idbRead=(store,key)=>evaluate(`(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('buwei-offline-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});try{return await new Promise((resolve,reject)=>{const r=db.transaction(${JSON.stringify(store)}).objectStore(${JSON.stringify(store)}).get(${JSON.stringify(key)});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}finally{db.close();}})()`);
let stopped=false;
async function stopServer(){if(stopped)return;stopped=true;const finished=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await finished;}
try{
  start();await connect();
  // Previous native fixture has no SW; navigate to real compiled page, not test HTML.
  await cdp('Page.navigate',{url:origin+'/app'});await until(`document.body?.textContent.includes(${JSON.stringify(project.name)})`,'online dashboard cache');check('real dashboard list prepared for offline cold startup',true);
  await cdp('Page.navigate',{url:origin+'/app/projects/'+projectId});
  await until(`document.body?.textContent.includes(${JSON.stringify(project.name)})`,'project rendered by actual frontend');check('actual compiled React renders synthetic project',project.name);
  const hello=await native('desktop_hello');assert.equal(hello.platform,'android');check('actual frontend retains native Android bridge',hello.platform);
  await until("navigator.serviceWorker?.controller || navigator.serviceWorker?.getRegistration().then(r=>Boolean(r?.active))",'ServiceWorker active');
  const caches=await evaluate('(async()=>{const names=await window.caches.keys();return Promise.all(names.map(async name=>({name,urls:(await(await window.caches.open(name)).keys()).map(r=>r.url)})));})()');
  assert.ok(caches.some(cache=>cache.name.startsWith('workbox-precache-')&&cache.urls.some(url=>new URL(url).pathname==='/index.html')));check('real PWA shell precached in Android WebView',{caches:caches.map(cache=>({name:cache.name,entries:cache.urls.length}))});
  const readyKey=userId+':/api/v1/projects/'+projectId+'/offline-ready';
  await until(`(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('buwei-offline-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});try{return await new Promise(resolve=>{const r=db.transaction('snapshots').objectStore('snapshots').get(${JSON.stringify(readyKey)});r.onsuccess=()=>resolve(Boolean(r.result));});}finally{db.close();}})()`,'real prepareProject completion');
  assert.equal((await idbRead('snapshots',userId+':/api/v1/projects/'+projectId)).data.name,project.name);check('real frontend prepares durable account/project snapshots',readyKey);
  await cdp('Page.navigate',{url:origin+'/app/projects/'+projectId+'/tasks'});await until(`document.body?.textContent.includes(${JSON.stringify(task.title)})`,'task page lazy chunk cached');check('real task page and lazy assets load online',task.title);
  await stopServer();await assert.rejects(fetch(origin+'/api/v1/auth/session',{signal:AbortSignal.timeout(2500)}));assert.equal(await evaluate("fetch('/api/v1/auth/session',{cache:'no-store'}).then(()=>false,()=>true)"),true);check('loopback backend and static server stopped for WebView',true);
  const queuedTitle='Android 离线队列修改',operation={key:randomUUID(),accountId:userId,projectId,url:'/api/v1/projects/'+projectId+'/tasks/'+taskId,method:'PATCH',body:{title:queuedTitle,expectedRevision:1},localId:taskId,base:task,createdAt:new Date().toISOString(),state:'pending'};
  await evaluate(`(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('buwei-offline-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});await new Promise((resolve,reject)=>{const tx=db.transaction('operations','readwrite');tx.objectStore('operations').put(${JSON.stringify(operation)});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();window.dispatchEvent(new Event('offline-data-changed'));return true;})()`);check('synthetic queued edit committed before restart',{key:operation.key,title:queuedTitle});
  socket.close();await delay(150);adbCall(['shell','am','force-stop',appId]);start();await connect();
  await until(`document.body?.textContent.includes(${JSON.stringify(project.name)})`,'offline process startup actual shell');
  assert.equal(await evaluate("document.body.textContent.includes('服务暂时无法连接')"),false);check('actual PWA starts after process kill with server unavailable',await evaluate('({url:location.href,online:navigator.onLine,controller:Boolean(navigator.serviceWorker.controller)})'));
  assert.equal((await idbRead('operations',operation.key)).body.title,queuedTitle);assert.equal((await idbRead('snapshots',userId+':/api/v1/projects/'+projectId)).data.name,project.name);check('account snapshots and unsynced edit survive process restart',operation.key);
  await cdp('Page.navigate',{url:origin+'/app/projects/'+projectId+'/tasks'});await until(`document.body?.textContent.includes(${JSON.stringify(queuedTitle)})`,'actual offline optimistic task title');check('real task page consumes queued optimistic edit offline',queuedTitle);
  assert.equal((await native('desktop_hello')).platform,'android');check('native bridge retained during offline entry',true);
  report.passed=true;report.completedAt=new Date().toISOString();
}catch(error){report.passed=false;report.error=String(error);process.exitCode=1;}
finally{await stopServer();socket?.close();await writeFile(path.join(output,'android-web-smoke-report.json'),JSON.stringify(report,null,2));await writeFile(path.join(output,'requests.json'),JSON.stringify(events,null,2));console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,error:report.error??null,report:path.join(output,'android-web-smoke-report.json')}));}
