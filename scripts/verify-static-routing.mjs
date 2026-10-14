import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(new URL('../backend/package.json',import.meta.url));
const {experimental_readRawConfig}=require('wrangler');
const config=experimental_readRawConfig({config:join(root,'frontend/wrangler.jsonc')}).rawConfig;
const scratch=await mkdtemp(join(tmpdir(),'audit-assets-'));
const port=await new Promise((resolvePort,reject)=>{const server=createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolvePort(port));});});
let processHandle,logs='';
try {
  // Import the actual Worker. Only the upstream service is replaced with a local no-network fixture.
  const worker=join(root,'frontend/src/worker.ts').replaceAll('\\','/');
  await writeFile(join(scratch,'worker.ts'),`import worker from ${JSON.stringify(worker)}; export default {async fetch(request,env){const response=await worker.fetch(request,{...env,API:{fetch:async()=>new Response(JSON.stringify({error:{code:'UNAUTHENTICATED'}}),{status:401,headers:{'content-type':'application/json'}})}});const headers=new Headers(response.headers);headers.set('x-verification-worker','invoked');return new Response(response.body,{status:response.status,headers});}};`);
  await writeFile(join(scratch,'wrangler.json'),JSON.stringify({name:'audit-assets-local',main:'worker.ts',compatibility_date:config.compatibility_date,assets:{...config.assets,directory:join(root,'frontend/dist')}}));
  const cli=join(dirname(require.resolve('wrangler/package.json')),'bin/wrangler.js');
  processHandle=spawn(process.execPath,[cli,'dev','--local','--config',join(scratch,'wrangler.json'),'--port',String(port),'--show-interactive-dev-session=false'],{cwd:root,env:{...process.env,WRANGLER_SEND_METRICS:'false'},windowsHide:true});
  for(const stream of [processHandle.stdout,processHandle.stderr])stream.on('data',data=>{logs+=data;});
  const origin=`http://127.0.0.1:${port}`;
  let ready=false;
  for(let attempt=0;attempt<100;attempt++){
    if(processHandle.exitCode!==null)throw new Error(`Local Wrangler exited: ${logs}`);
    try{const response=await fetch(origin);if(response.ok){ready=true;break;}}catch{}
    await new Promise(resolveDelay=>setTimeout(resolveDelay,100));
  }
  assert.ok(ready,`Local Wrangler did not become ready: ${logs}`);
  const asset=(await readdir(join(root,'frontend/dist/assets'))).find(name=>/^index-.+\.js$/.test(name));assert.ok(asset);
  for(let repeat=0;repeat<2;repeat++){
    const response=await fetch(`${origin}/assets/${asset}`);
    assert.equal(response.status,200);assert.equal(response.headers.get('x-verification-worker'),null,'Matching assets must bypass the Worker');
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.ok(response.headers.get('content-security-policy')?.includes("object-src 'none'"));
  }
  for(const path of ['/','/login','/help','/password-reset/','/password-forgot','/email-verify','/app/join?code=fixture','/app/projects/example/tasks','/guest/index.html']){
    const response=await fetch(origin+path,{headers:{'sec-fetch-mode':'navigate'}});
    assert.equal(response.status,200);assert.equal(response.headers.get('x-verification-worker'),'invoked');
    assert.equal(response.headers.get('cache-control'),'no-store');assert.match(response.headers.get('content-security-policy'),/'nonce-[^']+'/);
  }
  for(const path of ['/api','/api/v1/auth/session']){
    const response=await fetch(origin+path);assert.equal(response.status,401);assert.equal(response.headers.get('x-verification-worker'),'invoked');assert.equal(response.headers.get('content-type'),'application/json');
  }
  const update=await fetch(origin+'/sw.js');assert.equal(update.headers.get('x-verification-worker'),'invoked');assert.match(update.headers.get('cache-control'),/no-store/);
  for(const path of ['/assets/missing.js','/assets/missing-AbCd0123.js','/missing-page']){
    const missing=await fetch(origin+path,{headers:{'sec-fetch-mode':'navigate'}});assert.equal(missing.status,404);
    assert.ok(!(await missing.text()).includes('<div id="root">'),'Missing routes cannot return the SPA');
  }
  console.log('PASS: local Wrangler routes repeated hashed assets without Worker invocation; static security headers, HTML nonce/no-store, SPA/login/invitation/guest, API errors, PWA update and 404 behavior verified. API uses a local fixture.');
} finally {
  if(processHandle&&processHandle.exitCode===null){processHandle.kill();await new Promise(resolveExit=>processHandle.once('exit',resolveExit));}
  const target=resolve(scratch);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('audit-assets-'));
  await rm(target,{recursive:true,force:true});
}
