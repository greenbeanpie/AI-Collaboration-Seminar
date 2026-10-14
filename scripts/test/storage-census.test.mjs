import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,basename,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
const script=fileURLToPath(new URL('../inventory-resource-storage.mjs',import.meta.url));
async function fixture(mode){
 const dir=await mkdtemp(join(tmpdir(),'storage-census-test-')),output=join(dir,'.local-secrets','output');
 const mock=join(dir,'mock.mjs'),auth=join(dir,'auth.toml');await writeFile(auth,'oauth_token="synthetic-census-token"');
 await writeFile(mock,`const mode=${JSON.stringify(mode)};globalThis.fetch=async(url,init)=>{
  const u=new URL(url);if(u.hostname!=='api.cloudflare.com')throw Error('No network allowed');
  const j=new Headers(init.headers).get('cf-r2-jurisdiction')??'default';let data;
  if(u.pathname.endsWith('/r2/buckets')){
   if(mode==='denied'&&j==='eu')return Response.json({success:false,errors:[{code:9109}]},{status:403});
   const names=j==='default'?['ai-office-files-production']:j==='eu'?['ai-office-files-production']:['other'];
   data={success:true,result:{buckets:names.map(name=>({name}))},...(mode==='buckets-truncated'?{result_info:{is_truncated:true}}:{})};
  }else if(u.pathname.includes('/objects')){
   const size=j==='default'?5:j==='eu'?7:9;
   data={success:true,result:{objects:[{key:'synthetic.txt',size,etag:'test'}]},...(mode==='objects-truncated'?{result_info:{is_truncated:true}}:{})};
  }else if(u.pathname.endsWith('/r2/metrics'))data={success:true,result:{standard:{uploaded:mode==='metrics-incomplete'?{}:{objects:mode==='empty-multipart'?1:0,payloadSize:0,metadataSize:0}},infrequentAccess:{uploaded:{objects:0,payloadSize:0,metadataSize:0}}}};
  else if(u.pathname.includes('/d1/database/')&&u.pathname.endsWith('/query')){
   if(!JSON.parse(init.body).sql.trimStart().startsWith('SELECT'))throw Error('Read-only census');
   data={success:true,result:[{results:[]}]};
  }else throw Error('Unexpected API path');return Response.json(data);
 };`);
 const result=spawnSync(process.execPath,['--import',pathToFileURL(mock).href,script,'--production','--output',output],{encoding:'utf8',env:{...process.env,CLOUDFLARE_API_TOKEN:'synthetic-census-token',WRANGLER_AUTH_FILE:auth},windowsHide:true});
 return {dir,output,result};
}
async function cleanup(dir){const target=resolve(dir);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('storage-census-test-'));await rm(target,{recursive:true,force:true});}
test('metadata census includes default/eu/us and same-name external buckets',async()=>{
 const f=await fixture('complete');try{assert.equal(f.result.status,0,f.result.stderr);const data=JSON.parse(await readFile(join(f.output,'storage-inventory.private.json'),'utf8'));assert.equal(data.objects.length,1);assert.equal(data.objects[0].size,5);assert.equal(data.externalBytes,16);assert.deepEqual(data.summaries.map(b=>b.jurisdiction),['default','eu','us']);}finally{await cleanup(f.dir);}
});
for(const mode of ['denied','buckets-truncated','objects-truncated','metrics-incomplete','empty-multipart'])test('incomplete '+mode+' census never prepares an activation SQL',async()=>{
 const f=await fixture(mode);try{assert.notEqual(f.result.status,0);assert.match(f.result.stderr,mode==='denied'?/Cloudflare metadata request failed/:mode==='buckets-truncated'?/Truncated bucket inventory requires a cursor/:mode==='objects-truncated'?/Truncated objects require a cursor/:mode==='metrics-incomplete'?/Complete pending-upload metrics are required/:/Uncompleted account uploads require explicit S3 reconciliation/);await assert.rejects(access(join(f.output,'storage-inventory.sql')));}finally{await cleanup(f.dir);}
});
