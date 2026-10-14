import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,basename,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
const script=fileURLToPath(new URL('../inventory-resource-storage.mjs',import.meta.url));
async function fixture(mode){
 const dir=await mkdtemp(join(tmpdir(),'storage-census-test-')),output=join(dir,'.local-secrets','output'),mock=join(dir,'mock.mjs'),auth=join(dir,'auth.toml');
 await writeFile(auth,'oauth_token="synthetic-census-token"');
 await writeFile(mock,`const mode=${JSON.stringify(mode)};globalThis.fetch=async(url,init)=>{
  const u=new URL(url);if(u.hostname!=='api.cloudflare.com')throw Error('No network allowed');let data;
  if(u.pathname.endsWith('/r2/buckets/ai-office-files-production/objects')){
   if(mode==='denied')return Response.json({success:false,errors:[{code:9109}]},{status:403});
   data={success:true,result:{objects:[{key:'synthetic.txt',size:5,etag:'test'}]},...(mode==='objects-truncated'?{result_info:{is_truncated:true}}:{})};
  }else if(u.pathname.includes('/d1/database/')&&u.pathname.endsWith('/query')){
   const sql=JSON.parse(init.body).sql;if(!sql.trimStart().startsWith('SELECT'))throw Error('Read-only census');
   data={success:true,result:[{results:sql.includes('COUNT(*) count')?[{count:mode==='pending'?1:0},{count:0},{count:0}]:[]}]};
  }else throw Error('Other buckets and account metrics must not be queried');return Response.json(data);
 };`);
 const result=spawnSync(process.execPath,['--import',pathToFileURL(mock).href,script,'--production','--output',output],{encoding:'utf8',env:{...process.env,CLOUDFLARE_API_TOKEN:'synthetic-census-token',WRANGLER_AUTH_FILE:auth},windowsHide:true});return {dir,output,result};
}
async function cleanup(dir){const target=resolve(dir);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('storage-census-test-'));await rm(target,{recursive:true,force:true});}
test('census only reads the current application bucket and never sets external quotas',async()=>{
 const f=await fixture('complete');try{assert.equal(f.result.status,0,f.result.stderr);const data=JSON.parse(await readFile(join(f.output,'storage-inventory.private.json'),'utf8'));assert.equal(data.objects.length,1);assert.equal(data.summaries.length,1);assert.equal(data.summaries[0].bytes,5);assert.equal('externalBytes' in data,false);assert.doesNotMatch(await readFile(join(f.output,'storage-inventory.sql'),'utf8'),/externalStorageBytes/);}finally{await cleanup(f.dir);}
});
for(const mode of ['denied','objects-truncated','pending'])test('incomplete '+mode+' census never prepares activation SQL',async()=>{
 const f=await fixture(mode);try{assert.notEqual(f.result.status,0);assert.match(f.result.stderr,mode==='denied'?/Cloudflare metadata request failed/:mode==='objects-truncated'?/Truncated objects require a cursor/:/Current-bucket writes require reconciliation/);await assert.rejects(access(join(f.output,'storage-inventory.sql')));}finally{await cleanup(f.dir);}
});
