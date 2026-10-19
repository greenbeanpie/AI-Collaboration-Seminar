import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Conservative expression analysis, not a Kotlin compiler or business-parity test.
// Unknown state, branches and unresolved prefixes stay explicitly unverified.
const verbs=new Set(['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']);
const repositoryMethods=new Set(['get','networkJson','request','requestDurably']);
const receivers=new Set(['repository','repo']);
const unknown=reason=>({reason});
const isValue=value=>typeof value==='string';
const uuidName=name=>/^(?:id|project|projectId|.*Id)$/.test(name);

function quotedEnd(source,start){
 if(source.startsWith('"""',start)){const end=source.indexOf('"""',start+3);return end<0?source.length:end+3;}
 const quote=source[start];let i=start+1;
 while(i<source.length){if(source[i]==='\\'){i+=2;continue;}if(quote==='"'&&source[i]==='$'&&source[i+1]==='{'){i=interpolationEnd(source,i+2)+1;continue;}if(source[i]===quote)return i+1;i++;}return i;
}
function interpolationEnd(source,start){let depth=1,i=start;while(i<source.length){if(source[i]==='"'||source[i]==="'"){i=quotedEnd(source,i);continue;}if(source[i]==='{')depth++;if(source[i]==='}'&&--depth===0)return i;i++;}return source.length;}
function tokenize(source){
 const tokens=[];let i=0;
 while(i<source.length){const start=i,ch=source[i];if(/\s/.test(ch)){i++;continue;}if(source.startsWith('//',i)){i=source.indexOf('\n',i);if(i<0)break;continue;}if(source.startsWith('/*',i)){let depth=1;i+=2;while(i<source.length&&depth){if(source.startsWith('/*',i)){depth++;i+=2;}else if(source.startsWith('*/',i)){depth--;i+=2;}else i++;}continue;}
  if(ch==='"'||ch==="'"){i=quotedEnd(source,i);tokens.push({kind:ch==='"'?'string':'char',text:source.slice(start,i),start,end:i});continue;}
  if(/[A-Za-z_]/.test(ch)){i++;while(i<source.length&&/[A-Za-z0-9_]/.test(source[i]))i++;tokens.push({kind:'id',text:source.slice(start,i),start,end:i});continue;}
  i++;tokens.push({kind:'punct',text:ch,start,end:i});
 }
 const stack=[],scopes=[];for(let n=0;n<tokens.length;n++){const token=tokens[n];token.scope=scopes.at(-1)??-1;if(['(','[','{'].includes(token.text)){stack.push(n);if(token.text==='{')scopes.push(n);}else if([')',']','}'].includes(token.text)){const opening=stack.pop();if(opening!==undefined){token.pair=opening;tokens[opening].pair=n;}if(token.text==='}')scopes.pop();}}
 return tokens;
}
function split(tokens,start,end,separator=','){
 const result=[];let begin=start;for(let i=start;i<end;i++){if(tokens[i].text===separator){result.push([begin,i]);begin=i+1;}else if(['(','[','{'].includes(tokens[i].text)&&tokens[i].pair!==undefined)i=tokens[i].pair;}result.push([begin,end]);return result;
}
function expressionEnd(file,start,stop=file.tokens.length){
 const {tokens,source}=file;let i=start;for(;i<stop;i++){if([';',',','}'].includes(tokens[i].text))break;if(i>start&&source.slice(tokens[i-1].end,tokens[i].start).includes('\n')&&!['+','=',':','.'].includes(tokens[i-1].text))break;if(['(','[','{'].includes(tokens[i].text)&&tokens[i].pair!==undefined)i=tokens[i].pair;}return i;
}
function parseFile(name,source){
 const file={name,source,tokens:tokenize(source),variables:[],functions:[],calls:[]};const {tokens}=file;
 for(let i=0;i<tokens.length;i++){
  if(tokens[i].text==='val'&&tokens[i+1]?.kind==='id'){
   let equal=i+2;while(equal<tokens.length&&!['=',';','by','{','}'].includes(tokens[equal].text)&&!source.slice(tokens[equal-1].end,tokens[equal].start).includes('\n'))equal++;
   if(tokens[equal]?.text==='=')file.variables.push({name:tokens[i+1].text,start:i,scope:tokens[i].scope,expression:[equal+1,expressionEnd(file,equal+1)],global:tokens[i].scope===-1&&tokens[i-1]?.text==='const'});
  }
  if(tokens[i].text==='fun'){
   let open=i+1;while(open<tokens.length&&tokens[open].text!=='('&&tokens[open].text!=='{')open++;if(tokens[open]?.text!=='('||tokens[open].pair===undefined)continue;const close=tokens[open].pair;
   const params=split(tokens,open+1,close).filter(([a,b])=>a<b).map(([a,b])=>{const colon=tokens.findIndex((t,n)=>n>=a&&n<b&&t.text===':');const eq=tokens.findIndex((t,n)=>n>=a&&n<b&&t.text==='=');return {name:colon>=0?tokens[colon-1].text:tokens[a].text,default:eq>=0?[eq+1,b]:null};});
   let body=close+1;while(body<tokens.length&&!['=','{',';','}'].includes(tokens[body].text)&&!source.slice(tokens[body-1].end,tokens[body].start).includes('\n'))body++;if(!['=','{'].includes(tokens[body]?.text))continue;
   const end=tokens[body].text==='{'?tokens[body].pair:expressionEnd(file,body+1);if(end===undefined)continue;file.functions.push({name:tokens[open-1].text,start:i,open,scope:tokens[i].scope,body,end,params,expression:tokens[body].text==='='?[body+1,end]:null,file});
  }
 }
 for(let i=0;i<tokens.length-1;i++)if(tokens[i].kind==='id'&&tokens[i+1].text==='('&&tokens[i+1].pair!==undefined&&!file.functions.some(fn=>fn.open===i+1)){const receiver=tokens[i-1]?.text==='.'?tokens[i-2]?.text:null;file.calls.push({name:tokens[i].text,index:i,end:tokens[i+1].pair,args:split(tokens,i+2,tokens[i+1].pair),receiver,file});}
 return file;
}
function scopeAncestors(file,index){const result=new Set([-1]);let scope=file.tokens[index]?.scope??-1;while(scope!==-1){result.add(scope);scope=file.tokens[scope].scope;}return result;}
function normalize(route){const trimmed=route.split('?')[0];return trimmed.startsWith('/api/')?trimmed:'/api/v1/'+trimmed.replace(/^\/+/, '');}
function canonicalPath(route,spec){const parts=route.split('/');return Object.keys(spec.paths).sort((a,b)=>b.split('/').filter(v=>v&&!v.startsWith('{')).length-a.split('/').filter(v=>v&&!v.startsWith('{')).length).find(candidate=>{const target=candidate.split('/');return parts.length===target.length&&parts.every((part,i)=>/^\{[^{}]+\}$/.test(part)?/^\{[^{}]+\}$/.test(target[i]):part===target[i]||/^\{[^{}]+\}$/.test(target[i]));});}

export function analyzeRoutes(sources,spec){
 const files=sources.map(({name,source})=>parseFile(name,source));const functions=files.flatMap(file=>file.functions);const constants=files.flatMap(file=>file.variables.filter(v=>v.global).map(v=>({...v,file})));const verified=[],unresolved=[],invalid=[];
 function evaluator(file,position,bindings={},depth=0,seen=new Set()){
  const {tokens}=file;const ancestors=scopeAncestors(file,position);
  function evaluate(range,query=true){
   if(depth>16)return unknown('expression/helper recursion limit');let [start,end]=range;while(tokens[start]?.text==='('&&tokens[start].pair===end-1){start++;end--;}if(start>=end)return unknown('empty expression');
   const sums=split(tokens,start,end,'+');if(sums.length>1){let result='';for(const part of sums){const value=evaluate(part,query);if(!isValue(value))return value;result+=value;if(query&&result.includes('?'))return result.split('?')[0];}return result;}
   const first=tokens[start];if(first.kind==='string'&&start+1===end)return literal(first.text,query);if(first.kind==='id'&&start+1===end)return identifier(first.text,query);
   let open=start;while(open<end&&tokens[open].text!=='(')open++;if(open<end&&tokens[open].pair===end-1){const name=tokens[open-1].text;const args=split(tokens,open+1,end-1);
    if(name==='encode'&&tokens.slice(start,open).map(t=>t.text).join('')==='Uri.encode'){const value=evaluate(args[0],false);return isValue(value)?(/^\{[^{}]+\}$/.test(value)?value:encodeURIComponent(value)):'{encodedSegment}';}
    if(name==='resolvePath'){const value=evaluate(args[0],query);return isValue(value)?normalize(value):value;}
    const fn=selectFunction(name,file,position);if(fn?.expression){const env=bindArguments(fn,args,file,position,bindings,depth+1);return evaluator(fn.file,fn.body,env,depth+1,seen).evaluate(fn.expression,query);}
   }return unknown('dynamic expression or branch');
  }
  function identifier(name,query){
   if(Object.hasOwn(bindings,name))return bindings[name];const marker=`${file.name}:${position}:${name}`;if(seen.has(marker))return unknown('recursive variable');const nextSeen=new Set(seen).add(marker);
   const declaration=file.variables.filter(v=>v.name===name&&v.start<position&&ancestors.has(v.scope)).sort((a,b)=>b.start-a.start)[0];if(declaration)return evaluator(file,declaration.start,bindings,depth+1,nextSeen).evaluate(declaration.expression,query);
   const global=constants.filter(v=>v.name===name);if(global.length===1)return evaluator(global[0].file,global[0].start,bindings,depth+1,nextSeen).evaluate(global[0].expression,query);return unknown(`unresolved variable ${name}`);
  }
  function literal(raw,query){
   const triple=raw.startsWith('"""');let value=raw.slice(triple?3:1,triple?-3:-1);if(query){for(let q=0;q<value.length;q++){if(value[q]==='\\'){q++;continue;}if(value[q]==='$'&&value[q+1]==='{'){q=interpolationEnd(value,q+2);continue;}if(value[q]==='?'){value=value.slice(0,q);break;}}}let result='';
   for(let i=0;i<value.length;){if(value[i]==='\\'){const escape=value[i+1];result+=({n:'\n',r:'\r',t:'\t'}[escape]??escape??'');i+=2;continue;}if(value[i]!=='$'){result+=value[i++];continue;}
    if(value[i+1]==='{'){const end=interpolationEnd(value,i+2);const expression=value.slice(i+2,end);const fragment=parseFile(`${file.name}:interpolation`,expression);let resolved;
     if(/^Uri\.encode\(/.test(expression.trim()))resolved='{encodedSegment}';else if(/^[A-Za-z_]\w*$/.test(expression.trim())){resolved=identifier(expression.trim(),false);if(!isValue(resolved)&&uuidName(expression.trim()))resolved=`{${expression.trim()}}`;}else resolved=evaluator(fragment,fragment.tokens.length,bindings,depth+1,seen).evaluate([0,fragment.tokens.length],false);
     if(!isValue(resolved))return unknown(`unresolved interpolation ${expression}`);result+=resolved;i=end+1;
    }else{const match=/^\$([A-Za-z_]\w*)/.exec(value.slice(i));if(!match)return unknown('unreadable interpolation');let resolved=identifier(match[1],false);if(!isValue(resolved)&&uuidName(match[1]))resolved=`{${match[1]}}`;if(!isValue(resolved))return resolved;result+=resolved;i+=match[0].length;}
   }return result;
  }return {evaluate};
 }
 function selectFunction(name,file,position){const ancestors=scopeAncestors(file,position);const local=file.functions.filter(fn=>fn.name===name&&ancestors.has(fn.scope)).sort((a,b)=>Number(b.scope!==-1)-Number(a.scope!==-1)||b.start-a.start);if(local.length)return local[0];const external=functions.filter(fn=>fn.name===name&&fn.scope===-1);return external.length===1?external[0]:null;}
 function bindArguments(fn,args,file,position,bindings,depth){
  const named=new Map(),positional=[];for(const arg of args){if(file.tokens[arg[0]+1]?.text==='=')named.set(file.tokens[arg[0]].text,[arg[0]+2,arg[1]]);else positional.push(arg);}
  const env={};for(let i=0;i<fn.params.length;i++){const parameter=fn.params[i],arg=named.get(parameter.name)??positional[i];env[parameter.name]=arg?evaluator(file,position,bindings,depth).evaluate(arg,false):parameter.default?evaluator(fn.file,fn.body,env,depth).evaluate(parameter.default,false):unknown(`missing argument ${parameter.name}`);}return env;
 }
 function methodGuard(call,env){
  const tokens=call.file.tokens;let prefix=call.index-3,negated=false;
  if(tokens[prefix]?.text==='else'){const preceding=call.file.calls.find(candidate=>candidate.end===prefix-1&&requestShape(candidate));if(!preceding)return null;prefix=preceding.index-3;negated=true;}
  if(tokens[prefix]?.text!==')')return null;const open=tokens[prefix].pair;if(tokens[open-1]?.text!=='if')return null;
  const condition=tokens.slice(open+1,prefix);if(condition.length!==4||condition[0].text!=='method'||condition[1].text!=='='||condition[2].text!=='='||condition[3].kind!=='string')return null;
  const left=env.method;if(!isValue(left))return 'unknown';const right=condition[3].text.slice(1,-1);return negated?left!==right:left===right;
 }

 function requestShape(call){if(receivers.has(call.receiver)&&repositoryMethods.has(call.name))return call.name==='get'?{method:'GET',path:call.args[0]}:call.name==='requestDurably'?{method:call.args[1],path:call.args[2]}:{method:call.args[0],path:call.args[1]};if(!call.receiver&&['action','operation'].includes(call.name)&&call.args[0]&&call.file.tokens[call.args[0][0]]?.kind==='string'&&verbs.has(call.file.tokens[call.args[0][0]].text.slice(1,-1)))return {method:call.args[0],path:call.args[1]};return null;}
 function check(call,shape,env={},site=call){
  const guarded=methodGuard(call,env);if(guarded===false)return;
  const evaluate=evaluator(call.file,call.index,env).evaluate;const method=typeof shape.method==='string'?shape.method:shape.method?evaluate(shape.method,false):unknown('missing method');const route=shape.path?evaluate(shape.path):unknown('missing URL');const record={file:site.file.name,line:site.file.source.slice(0,site.file.tokens[site.index].start).split('\n').length,callee:site.name};
  if(isValue(method)&&!verbs.has(method)){invalid.push({...record,method,path:isValue(route)?normalize(route):'<unresolved URL>',reason:'unsupported literal HTTP method'});return;}
  if(guarded==='unknown'||!isValue(method)||!isValue(route)){unresolved.push({...record,reason:guarded==='unknown'?'dynamic method branch':!isValue(method)?method.reason:route.reason,expression:site.file.source.slice(site.file.tokens[site.index].start,site.file.tokens[site.end].end).replace(/\s+/g,' ').slice(0,200)});return;}
  const normalized=normalize(route);const canonical=canonicalPath(normalized,spec);if(!canonical||!spec.paths[canonical]?.[method.toLowerCase()])invalid.push({...record,method,path:normalized,reason:canonical?`method is not declared for ${canonical}`:'path is not declared in OpenAPI'});else verified.push({...record,method,path:canonical});
 }
 const forwarding=functions.filter(fn=>fn.params.some(p=>/^(method|path|url|tail|base|prefix)$/.test(p.name))).map(fn=>({...fn,requests:fn.file.calls.filter(call=>call.index>fn.body&&call.end<=fn.end&&requestShape(call))})).filter(fn=>fn.requests.length);
 for(const file of files)for(const call of file.calls){const shape=requestShape(call);if(shape){check(call,shape);continue;}if(call.receiver)continue;const fn=selectFunction(call.name,file,call.index);const helper=fn&&forwarding.find(candidate=>candidate.file===fn.file&&candidate.start===fn.start);if(helper){const env=bindArguments(helper,call.args,file,call.index,{},0);for(const request of helper.requests)check(request,requestShape(request),env,call);}}
 return {files:files.length,verified,uniqueOperations:[...new Set(verified.map(v=>`${v.method} ${v.path}`))].sort(),unresolved,invalid};
}

export function assertRouteReport(report){
 if(report.invalid.length)throw new Error(report.invalid.map(item=>`${item.file}:${item.line}: ${item.method} ${item.path}: ${item.reason}`).join('\n'));
 if(report.verified.length<11)throw new Error(`Route scan found only ${report.verified.length} verified bindings; expected at least 11. Dynamic URLs do not satisfy this gate.`);return report;
}
function kotlinFiles(directory){return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?kotlinFiles(path.join(directory,entry.name)):entry.name.endsWith('.kt')&&!entry.name.startsWith('Generated')?[path.join(directory,entry.name)]:[]);}
function main(){
 const args=process.argv.slice(2);let root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');const option=args.indexOf('--root');if(option>=0){if(!args[option+1])throw new Error('--root needs a repository directory');root=path.resolve(args[option+1]);}
 const spec=JSON.parse(fs.readFileSync(path.join(root,'backend/openapi/openapi.json'),'utf8'));const sources=kotlinFiles(path.join(root,'android-native/app/src/main/java/cn/buwei/nativeapp')).map(file=>({name:path.relative(root,file).replaceAll('\\','/'),source:fs.readFileSync(file,'utf8')}));
 const report=analyzeRoutes(sources,spec);if(args.includes('--json'))console.log(JSON.stringify(report,null,2));else {console.log(`${report.verified.length} statically resolved request bindings (${report.uniqueOperations.length} unique OpenAPI operations) verified across ${report.files} Kotlin files.`);console.log(`${report.unresolved.length} dynamic request bindings remain UNVERIFIED; this is not a complete business/API acceptance result.`);for(const item of report.unresolved)console.log(`UNVERIFIED ${item.file}:${item.line} ${item.callee}: ${item.reason} | ${item.expression}`);for(const item of report.invalid)console.error(`INVALID ${item.file}:${item.line} ${item.method} ${item.path}: ${item.reason}`);}assertRouteReport(report);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{main();}catch(error){console.error(error.message);process.exitCode=1;}}
