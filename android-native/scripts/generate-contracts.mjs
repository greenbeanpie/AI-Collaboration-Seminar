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
const output=`// Generated from backend/openapi/openapi.json. Run node android-native/scripts/generate-contracts.mjs.\npackage cn.buwei.nativeapp.features\n\nimport android.content.res.AssetManager\nimport kotlinx.serialization.json.*\n\ninternal data class NativeOperation(val method:String,val path:String,val title:String,val tag:String,val parameters:JsonArray,val schema:JsonObject,val binary:Boolean)\ninternal object NativeContracts {\n private lateinit var assets:AssetManager\n fun initialize(manager:AssetManager) { assets=manager }\n val operations:List<NativeOperation> by lazy { decode(assets.open("native-contracts.json").bufferedReader().use { it.readText() }) }\n fun decode(source:String):List<NativeOperation> = Json.parseToJsonElement(source).jsonArray.map { entry->val o=entry.jsonObject\n  NativeOperation(o["method"]!!.jsonPrimitive.content,o["path"]!!.jsonPrimitive.content,o["title"]!!.jsonPrimitive.content,o["tag"]!!.jsonPrimitive.content,o["parameters"]!!.jsonArray,o["schema"]!!.jsonObject,o["binary"]!!.jsonPrimitive.boolean)\n }\n}\n`;
const out=path.join(target,'GeneratedContracts.kt');
const asset=path.join(root,'android-native/app/src/main/assets/native-contracts.json');
const assetContent=JSON.stringify(operations)+'\n';
if(process.argv.includes('--check')){if(!fs.existsSync(out)||fs.readFileSync(out,'utf8')!==output||!fs.existsSync(asset)||fs.readFileSync(asset,'utf8')!==assetContent){console.error('Native contracts are stale');process.exit(1);}}else {fs.mkdirSync(path.dirname(asset),{recursive:true});fs.writeFileSync(out,output);fs.writeFileSync(asset,assetContent);}
console.log(`${operations.length} native operation contracts verified`);
