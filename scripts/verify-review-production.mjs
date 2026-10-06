import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
const web = 'https://greenbp-team-office.hddhp.workers.dev';
const api = 'https://greenbp-team-office-backend.hddhp.workers.dev';
const version = process.env.RELEASE_SHA;
assert(/^[a-f0-9]{40}$/.test(version ?? ''), 'Set RELEASE_SHA to the deployed Git SHA');
const report = {releaseSha:version,checkedAt:new Date().toISOString(),browserUsed:false,checks:[],customDomain:null};
async function call(url, options={}) {
 const origin = new URL(url).origin;
 for (let attempt=0;attempt<5;attempt++) {
  const response = await fetch(url,{...options,signal:AbortSignal.timeout(20000),redirect:'manual'});
  if (![301,302,303,307,308].includes(response.status)) return response;
  assert(!options.method || options.method==='GET', 'Authentication endpoints must not redirect');
  const next = new URL(response.headers.get('location'),url);
  assert.equal(next.origin,origin,'Only same-origin asset canonicalization may redirect');url=next.href;
 }
 throw new Error('Too many redirects');
}
function checked(name){report.checks.push(name);}
function headers(response) {
 assert.equal(response.headers.get('x-content-type-options'),'nosniff');
 assert.equal(response.headers.get('referrer-policy'),'strict-origin-when-cross-origin');
 const csp=response.headers.get('content-security-policy')??'';
 assert(csp.includes("frame-ancestors 'none'"));assert(csp.includes("object-src 'none'"));
 assert(!csp.includes("script-src 'self' 'unsafe-inline'"));assert(response.headers.get('permissions-policy')?.includes('microphone=(self)'));
}
const page=await call(web+'/login',{headers:{'Sec-Fetch-Mode':'navigate'}});
assert.equal(page.status,200);headers(page);const html=await page.text();assert(html.includes('id="root"'));
const asset=html.match(/src="([^"]*\/assets\/[^"]+\.js)"/)?.[1];assert(asset);
for(const path of [asset,'/sw.js','/guest/index.html','/guest/demo.js']){
 const response=await call(web+path);assert.equal(response.status,200);headers(response);const bytes=Buffer.from(await response.arrayBuffer());
 const local=readFileSync(join('frontend/dist',path.slice(1)));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),createHash('sha256').update(local).digest('hex'));
 if(path==='/sw.js')assert(response.headers.get('cache-control')?.includes('no-store'));
 checked('Deployed asset headers and SHA-256: '+path);
}
const capabilities=await call(web+'/api/v1/capabilities');assert.equal(capabilities.status,200);
const data=(await capabilities.json()).data;assert.equal(data.environment,'production');
assert.equal(data.authentication.turnstileRequired,true);assert(data.authentication.turnstileSiteKey);checked('Production Service Binding and enabled authentication capabilities');
const unauthenticated=await call(web+'/api/v1/projects');assert.equal(unauthenticated.status,401);checked('Unauthenticated project access rejected');
for(const [path,body] of [
 ['/auth/sessions',{account:'review_'+randomUUID().slice(0,8),password:'Review-negative-test-only'}],
 ['/auth/register',{username:'review_'+randomUUID().slice(0,8),password:'Review-negative-test-only',invitationCode:'AAAAAAAAAAAAAAAA'}],
]){
 const response=await call(api+'/api/v1'+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:web,'X-Request-Id':randomUUID(),'Idempotency-Key':randomUUID()},body:JSON.stringify(body)});
 assert.equal(response.status,403);assert(!response.headers.get('set-cookie'));
 assert.equal((await response.json()).error.code,'PERMISSION_DENIED');checked('Missing Turnstile rejected without session cookie: '+path);
}
const custom=await call('https://team.greenbp.dpdns.org/login',{headers:{'Sec-Fetch-Mode':'navigate'}});
const customBody=await custom.text();
report.customDomain={status:custom.status,challenge:custom.headers.get('cf-mitigated')==='challenge',verified:false};
if(custom.status===200&&customBody.includes('id="root"')){headers(custom);assert.equal(customBody.match(/src="([^"]*\/assets\/[^"]+\.js)"/)?.[1],asset);
 const nonce=custom.headers.get('content-security-policy')?.match(/'nonce-([^']+)'/)?.[1];
 if(customBody.includes('__CF$cv$params')) {
  assert(nonce && customBody.includes('nonce="'+nonce+'"'),'Cloudflare injected scripts must carry the response nonce');
  report.customDomain.cloudflareInjectedScriptNonceVerified=true;
 }
 report.customDomain.verified=true;checked('Custom domain matches deployed application');}
report.limitations=['No browser/visual verification','No real human Turnstile success or replay verification','No paid provider calls or production business-data mutations'];
const output='docs/evidence/repository-review-release-20261007.json';mkdirSync('docs/evidence',{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:report.checks.length,customDomain:report.customDomain,output}));
