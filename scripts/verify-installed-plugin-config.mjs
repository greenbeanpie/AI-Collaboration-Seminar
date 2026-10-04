/** Install the built package through actual DSH RC2 into an isolated profile.
 * Verify the installed-package detail UI using a real browser. No personal profile or model calls.
 * node scripts/verify-installed-plugin-config.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir,mkdtemp,readFile,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { createHash } from 'node:crypto';
const root=resolve('.'),out=join(root,'output/plugin-installed-config');await mkdir(out,{recursive:true});
const home=await mkdtemp(join(out,'isolated-dsh-'));
const exe=join(process.env.LOCALAPPDATA,'Programs/DeepSeek Harness/DeepSeek Harness.exe');
const cli=join(process.env.LOCALAPPDATA,'Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
const clean=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/(API[_]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(k)));
const env={...clean,ELECTRON_RUN_AS_NODE:'1',DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1'};
const run=args=>spawn(exe,['--expose-internals',cli,...args],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
const pkg=join(root,'frontend/public/plugins/dsh-team-office-bridge-0.1.1.tgz');
const install=run(['plugin','--profile','web','add',pkg]);let installOutput='';install.stdout.on('data',b=>{installOutput+=b;});install.stderr.on('data',b=>{installOutput+=b;});
const code=await new Promise((done,reject)=>{const timer=setTimeout(()=>{install.kill();reject(new Error('Isolated install timed out'));},90000);install.once('error',reject);install.once('exit',c=>{clearTimeout(timer);done(c);});});
await writeFile(join(out,'install.log'),installOutput);assert.equal(code,0,'Official isolated install failed');
const manifest=JSON.parse(await readFile(join(home,'profiles/web/package.json'),'utf8'));assert(manifest.dsh.profile.bundles.includes('@greenbeanpie/dsh-team-office-bridge'));
const host=run(['--profile','web','--no-open','--port','0']);let stdout='',stderr='';host.stderr.on('data',b=>{stderr+=b;});let browser,activePage;
const report={passed:false,personalProfileTouched:false,paidRequests:0,installedViaOfficialManager:true,version:'0.1.1',packageSha256:createHash('sha256').update(await readFile(pkg)).digest('hex'),checks:[]};
try{
 const url=await new Promise((done,reject)=>{const timer=setTimeout(()=>reject(new Error('Isolated host startup timed out')),30000);host.stdout.on('data',b=>{stdout+=b;const match=stdout.match(/dsh web: (http:\/\/[^\s]+)/);if(match){clearTimeout(timer);done(match[1]);}});host.once('error',reject);host.once('exit',()=>{clearTimeout(timer);reject(new Error('Isolated host exited'));});});
 assert(['localhost','127.0.0.1'].includes(new URL(url).hostname));
 const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/hmz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
 browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});activePage=page;page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(url);await page.getByRole('button',{name:'继续',exact:true}).click();
 await page.getByRole('button',{name:'稍后配置',exact:true}).click();
 await page.getByRole('button',{name:'插件',exact:true}).click();
 const installed=page.getByText('@greenbeanpie/dsh-team-office-bridge',{exact:true});await installed.waitFor();
 assert.equal(await page.getByText('补位桥接器',{exact:true}).count(),0,'Duplicate official configuration entry returned');
 await page.screenshot({path:join(out,'installed-list.png'),fullPage:true});await installed.click();
 const connect=page.getByRole('button',{name:'连接网站',exact:true});await connect.waitFor();assert(await connect.isEnabled());
 await page.getByText('尚未连接',{exact:true}).waitFor();await page.screenshot({path:join(out,'installed-details.png'),fullPage:true});
 // Exercise the actual built client handler while replacing only the local test endpoint response.
 // This avoids creating a production device or transmitting a real authorization request.
 let posts=0;const actions=[];
 await page.context().route('https://approval-fixture.invalid/**',route=>route.fulfill({status:200,contentType:'text/html',body:'<h1>授权跳转测试</h1>'}));
 await page.route('**/api/team-office-bridge/config',async route=>{
  if(route.request().method()==='POST'){posts++;const body=route.request().postDataJSON();actions.push(body);assert(['connect','bind'].includes(body.action));}
  else if(!posts)return route.continue();
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({compatible:true,configured:true,paired:true,approvalUrl:'https://approval-fixture.invalid/confirm',projects:[{projectId:'fixture-project',name:'目录入口测试',bound:actions.some(a=>a.action==='bind'),localLabel:'测试目录'}]})});
 });
 const popupPromise=page.waitForEvent('popup');await connect.click();const popup=await popupPromise;
 await popup.waitForURL('https://approval-fixture.invalid/confirm');assert.equal(posts,1);await popup.close();
 await page.getByRole('button',{name:'选择本地目录',exact:true}).click();assert.equal(posts,2);assert.deepEqual(actions[1],{action:'bind',projectId:'fixture-project'});
 await page.getByRole('button',{name:'更换目录',exact:true}).waitFor();await page.screenshot({path:join(out,'installed-directory.png'),fullPage:true});
 report.checks=['actual RC2 official manager installation','installed package entry opens configuration','no duplicate upper official entry','connection button enabled','actual connection handler posts once and opens approval page with fixture','directory action posts expected project binding with fixture','no model requests'];
 report.limitations=['Authorization response and directory action mocked; no production pairing and no real native directory selection.'];
 assert.deepEqual(errors,[]);report.passed=true;
}catch(error){if(activePage){await writeFile(join(out,'failure.txt'),await activePage.locator('body').innerText());await activePage.screenshot({path:join(out,'failure.png'),fullPage:true});}report.error=error.message;throw error;}
finally{await browser?.close();host.kill();await writeFile(join(out,'host.log'),stderr);await writeFile(join(out,'verification.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify({passed:report.passed,evidence:join(out,'verification.json'),version:report.version,paidRequests:0,personalProfileTouched:false}));
