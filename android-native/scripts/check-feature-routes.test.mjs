import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {analyzeRoutes,assertRouteReport} from './check-feature-routes.mjs';

const source=code=>[{name:'Feature.kt',source:code}];
const spec=paths=>({paths});
const analyze=(code,paths)=>analyzeRoutes(source(code),spec(paths));
const enough=Array.from({length:11},()=> 'repository.get("/api/v1/known")').join('\n');

test('direct repository APIs resolve their actual argument slots and remove query parameters',()=>{
 const report=analyze(`fun screen() {
 repository.get("/api/v1/known?cursor=$opaque")
 repository.networkJson("GET", "/api/v1/known")
 repository.request("PATCH", "/api/v1/known", body)
 repository.requestDurably("not-a-route", "POST", "/api/v1/known", body)
 }`,{'/api/v1/known':{get:{},patch:{},post:{}}});
 assert.equal(report.invalid.length,0);assert.equal(report.unresolved.length,0);
 assert.deepEqual(report.verified.map(row=>row.method),['GET','GET','PATCH','POST']);
 assert.ok(report.verified.every(row=>row.path==='/api/v1/known'));
});

test('a nonexistent URL fails even when enough other bindings are valid',()=>{
 const report=analyze(`${enough}\nrepository.get("/api/v1/missing")`,{'/api/v1/known':{get:{}}});
 assert.equal(report.invalid.length,1);assert.throws(()=>assertRouteReport(report),/missing.*not declared/);
});

test('wrong method and misspelled literal method fail rather than count as dynamic coverage',()=>{
 for(const method of ['DELETE','POZT']){
  const report=analyze(`${enough}\nrepository.request("${method}","/api/v1/known")`,{'/api/v1/known':{get:{}}});
  assert.equal(report.invalid.length,1);assert.throws(()=>assertRouteReport(report),new RegExp(method));
 }
});

test('unknown prefixes and state-derived URLs remain unverified and cannot satisfy the gate',()=>{
 const report=analyze('fun screen(){ repository.get("$base/items"); repository.request(method, selectedPath) }',{'/api/v1/items':{get:{}}});
 assert.equal(report.verified.length,0);assert.equal(report.invalid.length,0);assert.equal(report.unresolved.length,2);
 assert.throws(()=>assertRouteReport(report),/only 0 verified bindings/);
});

test('question marks inside Kotlin interpolation are not mistaken for URL query delimiters',()=>{
 const report=analyze('repository.get("/api/v1/users/${Uri.encode(user?.id)}/profile?cursor=$unknown")',{'/api/v1/users/{userId}':{get:{}}});
 assert.equal(report.verified.length,0);assert.equal(report.invalid.length,1);
 assert.match(report.invalid[0].path,/\/profile$/);
 const encoded=analyze('repository.get("/api/v1/files/" + Uri.encode("a/b?c") + "/content")',{'/api/v1/files/{fileId}/content':{get:{}}});
 assert.equal(encoded.invalid.length,0);assert.equal(encoded.verified.length,1);
});

test('same-named base variables are resolved in their own lexical scopes',()=>{
 const report=analyze(`fun alpha(){val base="/api/v1/alpha";repository.get("$base/items")}
 fun beta(){val base="/api/v1/beta";repository.request("POST","$base/items")}`,
 {'/api/v1/alpha/items':{get:{}},'/api/v1/beta/items':{post:{}}});
 assert.equal(report.invalid.length,0);assert.equal(report.unresolved.length,0);
 assert.deepEqual(report.verified.map(row=>`${row.method} ${row.path}`),['GET /api/v1/alpha/items','POST /api/v1/beta/items']);
});

test('prefix helpers are read from their declarations, including cross-file constants',()=>{
 const report=analyzeRoutes([
  {name:'Prefix.kt',source:'internal const val bridgeBase="/api/v1/agent-bridges"\ninternal fun twBase(project:String)="/api/v1/projects/${Uri.encode(project)}"'},
  {name:'Feature.kt',source:'fun task(projectId:String){val base=twBase(projectId);repository.get("$base/tasks/${Uri.encode(taskId)}?limit=$unknown");repository.get("$bridgeBase/devices")}'},
 ],spec({'/api/v1/projects/{projectId}/tasks/{taskId}':{get:{}},'/api/v1/agent-bridges/devices':{get:{}}}));
 assert.equal(report.invalid.length,0);assert.equal(report.unresolved.length,0);assert.equal(report.verified.length,2);
});

test('forwarding helpers bind positional/default/named arguments and respect a method branch',()=>{
 const code=`fun action(path:String,method:String="POST") { val result=if(method=="GET")repository.get(path)else repository.requestDurably("intent",method,path) }
 fun screen(){action("/api/v1/create");action("/api/v1/remove",method="DELETE")}`;
 const report=analyze(code,{'/api/v1/create':{post:{}},'/api/v1/remove':{delete:{}}});
 assert.equal(report.invalid.length,0);assert.equal(report.verified.length,2);
 assert.deepEqual(report.uniqueOperations,['DELETE /api/v1/remove','POST /api/v1/create']);
 assert.ok(report.unresolved.length>0,'dynamic helper definitions must still be reported');
});

test('literal routes take precedence over parameter routes with a different method',()=>{
 const report=analyze('repository.request("POST","/api/v1/files/${Uri.encode(fileId)}/multipart/complete")',{
  '/api/v1/files/{fileId}/multipart/{partNumber}':{put:{}},
  '/api/v1/files/{fileId}/multipart/complete':{post:{}},
 });
 assert.equal(report.invalid.length,0);assert.equal(report.verified[0].path,'/api/v1/files/{fileId}/multipart/complete');
});

test('comments, text content and unresolved branches are not mistaken for request bindings',()=>{
 const report=analyze(`// repository.get("/api/v1/not-real")
 val text="repository.get(\\\"/api/v1/not-real\\\")"
 repository.get(if(selected) "/api/v1/known" else unknownPath)`,{'/api/v1/known':{get:{}}});
 assert.equal(report.invalid.length,0);assert.equal(report.verified.length,0);assert.equal(report.unresolved.length,1);
});

test('CLI reads the supplied repository root and exits unsuccessfully for a nonexistent source URL',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'native-route-check-'));
 const script=fileURLToPath(new URL('./check-feature-routes.mjs',import.meta.url));
 try {
  const feature=path.join(directory,'android-native/app/src/main/java/cn/buwei/nativeapp/features/Fixture.kt');
  const specification=path.join(directory,'backend/openapi/openapi.json');
  fs.mkdirSync(path.dirname(feature),{recursive:true});fs.mkdirSync(path.dirname(specification),{recursive:true});
  fs.writeFileSync(specification,JSON.stringify(spec({'/api/v1/known':{get:{}}})));fs.writeFileSync(feature,enough);
  const valid=spawnSync(process.execPath,[script,'--root',directory,'--json'],{encoding:'utf8'});
  assert.equal(valid.status,0,valid.stderr);const report=JSON.parse(valid.stdout);assert.equal(report.verified.length,11);assert.equal(report.uniqueOperations.length,1);
  fs.appendFileSync(feature,'\nrepository.get("/api/v1/nonexistent")');
  const invalid=spawnSync(process.execPath,[script,'--root',directory],{encoding:'utf8'});
  assert.equal(invalid.status,1);assert.match(invalid.stderr,/nonexistent.*not declared/);
 } finally {
  assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('native-route-check-'));
  fs.rmSync(directory,{recursive:true,force:true});
 }
});
