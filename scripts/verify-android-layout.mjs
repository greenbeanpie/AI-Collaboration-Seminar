import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './mobile-entry-fixtures.cjs';

// Compiled application inside the actual debug Android WebView, local GET fixtures only.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.resolve(process.env.UI_ANDROID_DIST || path.join(repo, 'frontend/dist'));
const phase = process.env.UI_ANDROID_PHASE || 'after';
const output = path.resolve(process.env.UI_ANDROID_OUTPUT || path.join(repo, 'output/verification/mobile-layout', phase));
const adb = process.env.BUWEI_ADB_PATH || 'D:/Android/Sdk/platform-tools/adb.exe';
const serial = process.env.BUWEI_ADB_SERIAL || '127.0.0.1:5555';
const appId = 'cn.buwei.mobile';
const origin = 'http://127.0.0.1:5173';
const profiles = [
  { name: 'phone-320', width: 320, height: 740, phone: true },
  { name: 'phone-390', width: 390, height: 844, phone: true },
  { name: 'phone-landscape', width: 844, height: 390, phone: true },
  { name: 'tablet-768', width: 768, height: 1024, phone: false },
  { name: 'tablet-1024', width: 1024, height: 768, phone: false },
].filter(p => !process.env.UI_ANDROID_PROFILES || process.env.UI_ANDROID_PROFILES.split(',').includes(p.name));
const routes = [
  ['/app', 'home'], ['/app/profile', 'profile'], ['/app/support', 'support'], ['/app/support/help', 'help'], ['/app/projects/fixture', 'overview'],
  ['/app/projects/fixture/tasks', 'tasks'], ['/app/projects/fixture/tasks?task=task1', 'task-detail'],
  ['/app/projects/fixture/data', 'data'], ['/app/projects/fixture/data?mode=import', 'import'],
  ['/app/projects/fixture/data?mode=files', 'files'],
  ['/app/projects/fixture/assessment?section=standards', 'standards'],
  ['/app/projects/fixture/assessment?section=checks', 'checks'],
  ['/app/projects/fixture/team', 'team'], ['/app/settings/profile', 'settings'],
  ['/app/projects/new', 'new-project'], ['/app/projects/new/template/draft-template', 'template'],
].filter(([, name]) => !process.env.UI_ANDROID_ROUTES || process.env.UI_ANDROID_ROUTES.split(',').includes(name));
await mkdir(output, { recursive: true });
function adbCall(args, binary = false) {
  const r = spawnSync(adb, ['-s', serial, ...args], { encoding: binary ? undefined : 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(String(r.error || r.stderr));
  return r.stdout;
}
assert.match(adbCall(['shell', 'dumpsys', 'package', appId]), /flags=\[[^\]]*DEBUGGABLE/);
const originalSize = adbCall(['shell', 'wm', 'size']).match(/Override size: (\d+x\d+)/)?.[1];
const originalDensity = adbCall(['shell', 'wm', 'density']).match(/Override density: (\d+)/)?.[1];
const originalRotation = adbCall(['shell', 'settings', 'get', 'system', 'user_rotation']).trim();
const originalAutoRotation = adbCall(['shell', 'settings', 'get', 'system', 'accelerometer_rotation']).trim();
const writes = [], results = [], failures = [], runtimeErrors = [];
let socket, nextId = 0;
const pending = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function cdp(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
    pending.set(id, { resolve: r => { clearTimeout(timer); resolve(r); }, reject: e => { clearTimeout(timer); reject(e); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function until(expression) {
  for (let i = 0; i < 50; i++) { if (await evaluate('Boolean(' + expression + ')')) return; await delay(200); }
  throw new Error('Page did not settle: ' + expression);
}
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    if (req.method !== 'GET') { writes.push({ method: req.method, path: url.pathname }); res.writeHead(405); res.end('Read-only layout fixture'); return; }
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ data: fixture(url.pathname, url.searchParams), requestId: 'android-layout-fixture' })); return;
    }
    const file = path.resolve(dist, /^\/(app|login)(\/|$)/.test(url.pathname) || url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1));
    assert(file.startsWith(dist + path.sep));
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(file));
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
let previousUrl;
let nativeViewport;
async function connectVisible(width) {
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  for(let attempt=0;attempt<30;attempt++) {
    const pid=adbCall(['shell','pidof',appId]).trim().split(' ')[0];
    adbCall(['forward','tcp:9224','localabstract:webview_devtools_remote_'+pid]);
    const targets=await(await fetch('http://127.0.0.1:9224/json')).json();
    const target=targets.find(t=>{try {const d=JSON.parse(t.description);return t.type==='page'&&t.url.startsWith(origin)&&d.visible&&(!width||d.width===width*2);}catch{return false;}});
    if(!target){await delay(300);continue;}
    nativeViewport=JSON.parse(target.description);
    if(process.env.UI_ANDROID_NATIVE_INSETS==='1')assert(nativeViewport.screenY>0,'Native system-bar inset must offset the WebView');
    previousUrl ??= target.url;
    socket=new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
    socket.addEventListener('message',event=>{
      const r=JSON.parse(event.data),request=pending.get(r.id);
      if(request){pending.delete(r.id);r.error?request.reject(new Error(r.error.message)):request.resolve(r.result);}
      if(r.method==='Runtime.exceptionThrown')runtimeErrors.push(r.params.exceptionDetails.exception?.description||r.params.exceptionDetails.text);
    });
    await cdp('Runtime.enable');await cdp('Network.enable');
    await cdp('Network.setBypassServiceWorker',{bypass:true});await cdp('Network.setCacheDisabled',{cacheDisabled:true});
    await cdp('Network.setBlockedURLs',{urls:['https://*']});
    return;
  }
  throw new Error('Visible Android WebView target did not resize to '+width);
}
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(5173, '127.0.0.1', resolve); });
  adbCall(['reverse', 'tcp:5173', 'tcp:5173']);
  adbCall(['shell', 'am', 'start', '-n', appId + '/.MainActivity']);
  await connectVisible();
  adbCall(['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0']);
  adbCall(['shell', 'settings', 'put', 'system', 'user_rotation', '0']);
  for (const profile of profiles) {
    adbCall(['shell', 'wm', 'size', `${profile.width * 2}x${profile.height * 2}`]);
    adbCall(['shell', 'wm', 'density', '320']); await delay(700);
    await connectVisible(profile.width);
    for (const [route, name] of routes) {
      await cdp('Page.navigate', { url: origin + route });
      await until("document.querySelector('.main-shell') && document.querySelector('main h1,main h2,main h3,main form')");
      await evaluate('document.fonts.ready.then(()=>true)'); await delay(400);
      await evaluate("document.querySelector('app-updates')?.shadowRoot?.querySelectorAll('.toast-close').forEach(button=>button.click()); true");
      const geometry = await evaluate(`(() => {
        const shown = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden'; };
        const rect = e => { const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; };
        const nav = document.querySelector('[aria-label="主导航"]');
        const links = [...nav.querySelectorAll('a')].map(e=>({label:e.getAttribute('aria-label')||e.innerText, ...rect(e), visible:shown(e)}));
        const overflow = [...document.querySelectorAll('main *')].filter(shown).filter(e=>{const r=e.getBoundingClientRect();return (r.left < -1 || r.right > innerWidth+1) && !e.closest('pre,.table-wrap,.table-scroll,.tiptap table,.tm-document-preview table');}).slice(0,12).map(e=>({tag:e.tagName,classes:e.className,text:e.innerText?.slice(0,80),...rect(e)}));
        const squeezed = [...document.querySelectorAll('main p,main h1,main h2,main h3,main .notice-copy,main .tm-task-copy')].filter(shown).filter(e=>e.innerText.replace(/\\s/g,'').length>12 && e.getBoundingClientRect().width < parseFloat(getComputedStyle(e).fontSize)*6).map(e=>({classes:e.className,text:e.innerText.slice(0,100),...rect(e)}));
        // Measure rendered text runs too: anonymous flex text can be narrower than its parent.
        const walker=document.createTreeWalker(document.querySelector('main'),NodeFilter.SHOW_TEXT);
        while(walker.nextNode()) {
          const node=walker.currentNode,e=node.parentElement,text=node.textContent;
          if(!shown(e)||e.closest('script,style,pre,table,.ai-reference-badge,.project-content-navigation')||(text.match(/[\\u4e00-\\u9fff]/g)?.length||0)<text.trim().length*.6||text.trim().length<(e.closest('.dashboard-metric-label')?4:12))continue;
          const lines=new Map(),range=document.createRange();
          for(let i=0;i<Math.min(text.length,2000);i++){if(!/[\\u4e00-\\u9fff]/.test(text[i]))continue;range.setStart(node,i);range.setEnd(node,i+1);const r=range.getBoundingClientRect();if(r.width&&r.height){const y=Math.round(r.top);lines.set(y,(lines.get(y)||'')+text[i]);}}
          const values=[...lines.values()];
          if(values.some((line,i)=>i>0&&line.length<=5&&values[i-1].length<=5))squeezed.push({classes:e.className,text:text.trim().slice(0,100),lines:values,...rect(e)});
        }
        const projectNav = document.querySelector('[aria-label="项目功能"]');
        return {width:innerWidth,height:innerHeight,pageWidth:document.documentElement.scrollWidth,navPosition:getComputedStyle(nav).position,links,overflow,squeezed,
          projectLinks:projectNav?[...projectNav.querySelectorAll('a')].map(e=>({label:e.innerText,visible:shown(e),...rect(e)})):null,
          navSelects:[...document.querySelectorAll('.project-content-select')].filter(shown).length,
          dashboardColumns:document.querySelector('.dashboard-metrics')?getComputedStyle(document.querySelector('.dashboard-metrics')).gridTemplateColumns:null};
      })()`);
      const errors = [];
      if(await evaluate("Boolean(document.querySelector('.workspace-error-boundary')) || /Cannot read properties|页面发生错误|无法显示此页面/.test(document.body.innerText)"))errors.push('Application rendered an error boundary');
      if (geometry.width !== profile.width) errors.push('Unexpected actual WebView width ' + geometry.width);
      if (geometry.pageWidth > profile.width + 1) errors.push('Horizontal page overflow');
      if (geometry.overflow.length) errors.push('Content extends beyond viewport');
      if (geometry.squeezed.length) errors.push('Body text squeezed below six characters per line');
      if (geometry.links.some(l => !l.visible || l.x < -1 || l.x + l.width > profile.width + 1 || profile.phone && (l.y < -1 || l.y + l.height > geometry.height+1))) errors.push('Main navigation entry not visible');
      if (phase !== 'before') {
        if (profile.phone && geometry.navPosition !== 'fixed') errors.push('Phone navigation must be fixed');
        if (!profile.phone && geometry.navPosition === 'fixed') errors.push('Tablet must retain its own layout');
        if (geometry.navSelects) errors.push('Navigation dropdown remains');
        if (geometry.projectLinks?.some(l=>!l.visible)) errors.push('Project destination hidden');
      }
      const result = { profile, route, name, nativeViewport, geometry, errors }; results.push(result);
      if (errors.length) failures.push(result);
      if (['home', 'profile', 'support', 'help', 'tasks', 'data', 'standards', 'template', 'task-detail'].includes(name)) {
        await writeFile(path.join(output, `${profile.name}-${name}.png`), adbCall(['exec-out', 'screencap', '-p'], true));
      }
      if (name === 'home') await writeFile(path.join(output, `${profile.name}-emulator.png`), adbCall(['exec-out', 'screencap', '-p'], true));
      console.log(`${errors.length ? 'FAIL' : 'PASS'} ${profile.name} ${name}${errors.length ? ': ' + errors.join(', ') : ''}`);
    }
  }
  // Ensure fixed navigation stays available after scrolling, and content clears it at the end.
  if (phase !== 'before' && profiles.some(p=>p.phone)) {
    const phone = profiles.find(p=>p.phone);
    adbCall(['shell','wm','size',`${phone.width*2}x${phone.height*2}`]); await delay(500); await connectVisible(phone.width);
    await cdp('Page.navigate',{url:origin+'/app'}); await until("location.pathname==='/app' && document.querySelector('a.dashboard-project')");
    await evaluate('document.fonts.ready.then(()=>true)'); await delay(300);
    for(let attempt=0;attempt<4;attempt++) {
      const height=await evaluate('document.documentElement.scrollHeight');
      await evaluate('scrollTo(0,document.documentElement.scrollHeight)'); await delay(250);
      if(height===await evaluate('document.documentElement.scrollHeight'))break;
    }
    const clearance = await evaluate(`(()=>{const n=document.querySelector('.main-nav').getBoundingClientRect(),m=document.querySelector('main').getBoundingClientRect();return {navTop:n.top,navBottom:n.bottom,viewport:innerHeight,contentBottom:m.bottom-parseFloat(getComputedStyle(document.querySelector('main')).paddingBottom)};})()`);
    assert(clearance.navBottom <= clearance.viewport+1 && clearance.navTop > 0);
    assert(clearance.contentBottom <= clearance.navTop, 'Bottom navigation covers final content: '+JSON.stringify(clearance));
    const link = await evaluate("document.querySelector('.main-nav a[href=\"/app/people\"]').getBoundingClientRect().toJSON()");
    await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:link.x+link.width/2,y:link.y+link.height/2}]});
    await cdp('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await until("location.pathname==='/app/people'");
    results.push({name:'phone-fixed-navigation-scroll-clearance-and-touch',clearance,passed:true});
    assert.equal(await evaluate("Boolean(document.querySelector('.workspace-account-panel')?.hidden)"),true);
    const account=await evaluate("document.querySelector('.topbar-account').getBoundingClientRect().toJSON()");
    await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:account.x+account.width/2,y:account.y+account.height/2}]});
    await cdp('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await until("document.querySelector('.topbar-account').getAttribute('aria-expanded')==='true'");
    const menu=await evaluate("(()=>{const e=document.querySelector('.workspace-account-panel'),r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,viewport:innerWidth,logoutButtons:[...e.querySelectorAll('button')].map(b=>b.textContent.trim())};})()");
    assert(menu.x>=0 && menu.x+menu.width<=phone.width+1);
    assert(menu.logoutButtons.includes('退出登录') && menu.logoutButtons.includes('退出并清除此设备数据'));
    await writeFile(path.join(output,'phone-account-menu.png'),adbCall(['exec-out','screencap','-p'],true));
    await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await until("document.querySelector('.workspace-account-panel').hidden");
    results.push({name:'phone-account-dropdown-touch-and-logout-visibility',menu,passed:true});
  }
} catch (error) { failures.push({error:String(error)}); console.error(error); }
finally {
  if (socket?.readyState === WebSocket.OPEN) {
    await cdp('Network.setBlockedURLs',{urls:[]}).catch(()=>{}); await cdp('Network.setBypassServiceWorker',{bypass:false}).catch(()=>{});
    await cdp('Network.setCacheDisabled',{cacheDisabled:false}).catch(()=>{});
    if (previousUrl) await cdp('Page.navigate',{url:previousUrl}).catch(()=>{});
    socket.close();
  }
  adbCall(['shell','wm','size',originalSize || 'reset']); adbCall(['shell','wm','density',originalDensity || 'reset']);
  for (const [key,value] of [['user_rotation',originalRotation],['accelerometer_rotation',originalAutoRotation]]) adbCall(['shell','settings',value==='null'?'delete':'put','system',key,...(value==='null'?[]:[value])]);
  await new Promise(resolve=>server.close(resolve));
  await writeFile(path.join(output,'report.json'),JSON.stringify({phase,passed:failures.length===0,results,failures,runtimeErrors,blockedWrites:writes,limitations:['Synthetic local API data; no production deployment or paid model calls.','BlueStacks Android debug WebView; physical-device and iOS acceptance not performed.']},null,2));
  console.log(JSON.stringify({phase,checks:results.length,failures:failures.length,output}));
  if (phase!=='before' && failures.length) process.exitCode=1;
}
