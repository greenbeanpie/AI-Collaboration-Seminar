import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {apply,compatibility,DEFAULT_API,DshAdapter} from '../src/index.js';
import {hash} from '../src/runner.js';
test('compatibility enumerates required public capabilities',()=>{assert.ok(compatibility({}).includes('sessionController.inspect'));assert.ok(compatibility({}).includes('connection.fetch.register'));});
test('host pairing stores origin-pinned credential and exposes only approval info',async()=>{
 const previousHome=process.env.DSH_HOME,previousFetch=globalThis.fetch;process.env.DSH_HOME=await mkdtemp(join(tmpdir(),'bridge-host-'));let record=null,route,cleanup;const requests=[];
 const ctx={credentials:{async readRecord(){return record;},async modifyRecord(_key,fn){record=await fn();},async deleteRecord(){record=null;}},sessionController:Object.fromEntries(['create','prompt','follow','control','inspect','resolveAgent','cancel','updateQueue'].map(k=>[k,()=>{}])),agents:{get(){}},tools:{},directoryPicker:{capability(){return{kind:'native',async pick(){return undefined;}};}},connection:{fetch:{register(value){route=value;}}},effect(fn){cleanup=fn();}};
 globalThis.fetch=async(url,init)=>{requests.push({url,init});if(url.endsWith('/pairings'))return Response.json({pairingId:'id',approvalUrl:'https://greenbp-team-office.hddhp.workers.dev/app/agent-bridges/connect?pairing=id',expiresAt:new Date(Date.now()+100000).toISOString()});return Response.json({paired:false,protocolVersion:1,projects:[]});};
 try{await apply(ctx);const first=await route.fetch(new Request('http://localhost/api/team-office-bridge/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'connect'})}));const body=await first.json();assert.equal(first.status,200);assert.equal(body.configured,true);assert.equal(JSON.stringify(body).includes(record.payload.secret),false);const pairing=JSON.parse(requests.find(r=>r.url.endsWith('/pairings')).init.body);assert.equal(pairing.credentialHash,hash(record.payload.secret));assert.equal(record.payload.apiBase,DEFAULT_API);
 const secret=record.payload.secret;await route.fetch(new Request('http://localhost/api/team-office-bridge/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'connect',apiBase:'https://other.example/api/v1/agent-bridges'})}));assert.notEqual(record.payload.secret,secret);assert.equal(requests.some(r=>r.url.startsWith('https://other.example')&&r.init.headers.Authorization===`Bearer ${secret}`),false);const keep=record;globalThis.fetch=async()=>{throw new Error('offline');};const disconnected=await route.fetch(new Request('http://localhost/api/team-office-bridge/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'disconnect'})}));assert.equal(disconnected.status,400);assert.equal(record,keep);
 }finally{await cleanup?.();globalThis.fetch=previousFetch;if(previousHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previousHome;}
});

test('cancellation removes owned pending prompt and waits for actual idle',async()=>{const calls=[];const adapter=new DshAdapter({agents:{get(){return{inbox:{nextTurn:[{id:'m',source:{rpcId:'id'}}],nextStep:[]},async whenIdle(){calls.push('idle');}};}},sessionController:{async updateQueue(){calls.push('remove');},async cancel(){calls.push('cancel');}}});await adapter.cancel('bridge-id');assert.deepEqual(calls,['remove','cancel','idle']);});
