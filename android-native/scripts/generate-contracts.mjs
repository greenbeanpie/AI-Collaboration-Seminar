import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const spec=JSON.parse(fs.readFileSync(path.join(root,'backend/openapi/openapi.json'),'utf8'));
const target=path.join(root,'android-native/app/src/main/java/cn/buwei/nativeapp/features');
fs.mkdirSync(target,{recursive:true});
const quote=s=>JSON.stringify(s).replace(/\$/g,'\\$');
const resolve=(v,seen=new Set())=>{
  if(Array.isArray(v))return v.map(x=>resolve(x,seen));
  if(!v||typeof v!=='object')return v;
  if(v.$ref){if(seen.has(v.$ref))return {};const n=new Set(seen);n.add(v.$ref);return resolve(v.$ref.split('/').slice(1).reduce((x,k)=>x[k],spec),n);}
  return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,resolve(x,seen)]));
};
const operations=[];
for(const [url,methods] of Object.entries(spec.paths))for(const [method,op] of Object.entries(methods)){
 if(!['get','post','put','patch','delete'].includes(method))continue;
 const content=op.requestBody?.content||{};
 operations.push({method:method.toUpperCase(),path:url,title:op.summary||`${method.toUpperCase()} ${url.split('/').slice(3).join(' / ')}`,tag:op.tags?.[0]||'other',parameters:resolve(op.parameters||[]),schema:resolve(content['application/json']?.schema||{}),binary:!!op.requestBody&&!content['application/json']});
}
const chunks=[];for(let i=0;i<operations.length;i+=12)chunks.push(operations.slice(i,i+12));
const output=`// Generated from backend/openapi/openapi.json. Run node android-native/scripts/generate-contracts.mjs.\npackage cn.buwei.nativeapp.features\n\nimport kotlinx.serialization.json.*\n\ninternal data class NativeOperation(val method:String,val path:String,val title:String,val tag:String,val parameters:JsonArray,val schema:JsonObject,val binary:Boolean)\ninternal object NativeContracts {\n val operations:List<NativeOperation> by lazy { ${chunks.map((_,i)=>`chunk${i}()`).join(' + ')} }\n${chunks.map((ops,i)=>` private fun chunk${i}():List<NativeOperation> = listOf(\n${ops.map(o=>` NativeOperation(${quote(o.method)},${quote(o.path)},${quote(o.title)},${quote(o.tag)},Json.parseToJsonElement(${quote(JSON.stringify(o.parameters))}).jsonArray,Json.parseToJsonElement(${quote(JSON.stringify(o.schema))}).jsonObject,${o.binary})`).join(',\n')}\n )`).join('\n')}\n}\n`;
const out=path.join(target,'GeneratedContracts.kt');
if(process.argv.includes('--check')){if(!fs.existsSync(out)||fs.readFileSync(out,'utf8')!==output){console.error('Native contracts are stale');process.exit(1);}}else fs.writeFileSync(out,output);
console.log(`${operations.length} native operation contracts verified`);
