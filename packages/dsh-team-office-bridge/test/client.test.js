import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function fixture(state=null){
 const registrations=[],requests=[],popups=[];let plugin;
 const React={createElement:(tag,props,...children)=>({tag,props:props??{},children}),useState:value=>[typeof value==='boolean'?false:typeof value==='string'?'':state,()=>{}],useEffect(){}};
 const window={__ModuleLoader__:{load(module){plugin=module.factory(name=>{assert.equal(name,'react');return React;});}},open(url){assert.equal(url,'about:blank');const popup={opener:{},location:{href:url},close(){this.closed=true;}};popups.push(popup);return popup;}};
 const fetch=async(path,options)=>{requests.push({path,options});return{ok:true,json:async()=>({approvalUrl:'https://example.invalid/approve'})};};
 vm.runInNewContext(await readFile(new URL('../lib/client.js',import.meta.url),'utf8'),{window,fetch,setInterval,clearInterval});
 plugin.apply({slots:{inject(name,callback){registrations.push({injected:name});return callback();},register(options,component){registrations.push({options,component});}}});
 const entry=registrations.find(r=>r.component);
 return{registrations,requests,popups,view:entry.component({view:'page'})};
}
function all(node){return[node,...(node?.children??[]).flat(Infinity).filter(child=>child&&typeof child==='object').flatMap(all)];}
test('configuration belongs to installed package, with no duplicate official entry',async()=>{
 const f=await fixture();const entry=f.registrations.find(r=>r.options);
 assert.equal(entry.options.name,'plugins.bundle.config');assert.equal(entry.options.key,'@greenbeanpie/dsh-team-office-bridge');
 assert(!f.registrations.some(r=>r.injected==='plugins.item'));assert.equal(f.requests.length,0);
 const connect=all(f.view).find(n=>n.tag==='button'&&n.children[0]==='连接网站');assert(connect);
 await connect.props.onClick();assert.equal(f.requests.length,1);assert.equal(f.requests[0].path,'/api/team-office-bridge/config');assert.equal(JSON.parse(f.requests[0].options.body).action,'connect');
 assert.equal(f.popups[0].location.href,'https://example.invalid/approve');assert.equal(f.popups[0].opener,null);
});
test('installed package configuration includes native project directory action',async()=>{
 const f=await fixture({paired:true,configured:true,projects:[{projectId:'p1',name:'项目',bound:false}]});
 assert(!all(f.view).some(n=>n.tag==='button'&&n.children[0]==='连接网站'));
 const bind=all(f.view).find(n=>n.tag==='button'&&n.children[0]==='选择本地目录');assert(bind);await bind.props.onClick();
 assert.deepEqual(JSON.parse(f.requests[0].options.body),{action:'bind',projectId:'p1'});
});
