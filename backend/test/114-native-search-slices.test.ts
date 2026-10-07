import { afterEach,describe,expect,it,vi } from 'vitest';
import { env } from './helpers/env';
import { seedProject,seedUser } from './helpers/seed';
import { loadAiConfig } from '../src/ai/config';
import { seal } from '../src/ai/secrets';
import { nativeSearchCapability } from '../src/ai/tool-transport';
import { newId,nowIso } from '../src/core/db';
import { reserveAiSlot } from '../src/services/ai-reservations';
import { projectToolConversation } from '../src/services/project-ai-tools';
import { InvestigationContinuation,loadInvestigation,saveInvestigation } from '../src/services/project-investigation';
afterEach(()=>vi.unstubAllGlobals());
const query='公开校园节能案例',citation={url:'https://example.com/evidence',title:'公开来源'};
const calls=[{id:'search-1',name:'web_search',input:{query}},...Array.from({length:4},(_,i)=>({id:`read-${i}`,name:'list_project_resources',input:{offset:i*20}})),{id:'search-2',name:'web_search',input:{query}}];
async function fixture(privateContext=true,rejectFirstSearch=false){
  const owner=await seedUser(),projectId=await seedProject(owner.userId),jobId=newId(),loaded=(await loadAiConfig(env.DB))!;
  const model={...loaded.config.review,provider:'openai-compatible',providerPreset:'deepseek-anthropic' as const,apiProtocol:'messages' as const,model:'deepseek-v4-pro',apiUrl:'https://api.deepseek.com/anthropic/v1/messages',apiKeyEncrypted:await seal('fixture-search-key',env.AUTH_SECRET),supportsJson:false};
  delete model.goHeaders;delete model.goUsageAcknowledged;
  await env.DB.prepare('UPDATE ai_config_versions SET config_json=?2,enabled=1 WHERE id=?1').bind(loaded.id,JSON.stringify({searchEnabled:true,routingMode:'advanced',textEconomy:model,visionEconomy:model,review:model})).run();
  expect(nativeSearchCapability(model).supported).toBe(true);
  await reserveAiSlot(env,{projectId,jobId,purpose:'review_run',maxCalls:24});
  await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_at,updated_at) VALUES(?1,?2,'review_run','running','{}',?3,?3)").bind(jobId,projectId,nowIso()).run();
  const params={context:{projectId,userId:owner.userId,jobId,allowSearch:true,searchQuery:query},config:model,configVersionId:loaded.id,purpose:'review' as const,privateContext,messages:[{role:'user' as const,content:'按实际依据输出总结'}],promptVersion:'native-search-slice-fixture'};
  let modelCalls=0,searchCalls=0;
  const fetch=vi.fn(async(_url:unknown,init?:RequestInit)=>{
    const body=JSON.parse(String(init?.body)) as {tools?:Array<{type?:string}>};
    const usage={input_tokens:20,output_tokens:10};
    if(body.tools?.some(tool=>tool.type?.startsWith('web_search_'))){
      searchCalls++;
      if(rejectFirstSearch && searchCalls===1)return new Response('',{status:503});
      return Response.json({stop_reason:'end_turn',content:[{type:'server_tool_use',id:'native-1',name:'web_search',input:{query}},{type:'web_search_tool_result',tool_use_id:'native-1',content:[{type:'web_search_result',...citation}]},{type:'text',text:'可核对的公开搜索结果'}],usage:{...usage,server_tool_use:{web_search_requests:1}}});
    }
    modelCalls++;
    return Response.json({stop_reason:modelCalls===1?'tool_use':'end_turn',content:modelCalls===1?calls.map(call=>({type:'tool_use',...call})):[{type:'text',text:'{"summary":"调查完成","referenceIds":[],"decisionReferences":[]}'}],usage});
  });
  vi.stubGlobal('fetch',fetch);
  return {params,fetch,projectId,jobId,id:jobId+'-'+params.promptVersion,context:params.context,counts:()=>({modelCalls,searchCalls})};
}
async function complete(f:Awaited<ReturnType<typeof fixture>>){
  for(let slice=0;slice<12;slice++)try{return await projectToolConversation({...env,AI_EXECUTION_SLICE:true},f.params);}catch(error){expect(error).toBeInstanceOf(InvestigationContinuation);}
  throw new Error('fixture did not finish');
}
describe('native search survives investigation slices',()=>{
  it('blocks forged search requests when administrator disables search',async()=>{
    const f=await fixture();const loaded=(await loadAiConfig(env.DB))!;
    await env.DB.prepare('UPDATE ai_config_versions SET config_json=?2 WHERE id=?1').bind(loaded.id,JSON.stringify({...loaded.config,searchEnabled:false})).run();
    const result=await complete(f);expect(f.counts().searchCalls).toBe(0);expect(result.citations).toEqual([]);
    expect(result.trace.filter(item=>item.name==='web_search').every(item=>item.status==='failed')).toBe(true);
  });
  it('resumes an explicitly rejected native request without replaying the main model response',async()=>{
    const f=await fixture(true,true);
    await expect(projectToolConversation({...env,AI_EXECUTION_SLICE:true},f.params)).rejects.toBeInstanceOf(InvestigationContinuation);
    await expect(projectToolConversation({...env,AI_EXECUTION_SLICE:true},f.params)).rejects.toBeInstanceOf(InvestigationContinuation);
    const saved=(await loadInvestigation(env,f.id))!;
    expect(saved).toMatchObject({pendingDispatch:false,searchUsed:false,providerRetry:{attempt:1}});
    expect(saved.pendingOutput?.toolOutput?.toolCalls).toHaveLength(6);
    const result=await complete(f);
    expect(result.citations).toEqual([citation]);expect(f.counts()).toEqual({modelCalls:2,searchCalls:2});
  });
  it('retains the main tool response, finishes remaining reads, searches once and returns saved links',async()=>{
    const f=await fixture();
    await expect(projectToolConversation({...env,AI_EXECUTION_SLICE:true},f.params)).rejects.toBeInstanceOf(InvestigationContinuation);
    await expect(projectToolConversation({...env,AI_EXECUTION_SLICE:true},f.params)).rejects.toBeInstanceOf(InvestigationContinuation);
    const partial=(await loadInvestigation(env,f.id))!;
    expect(partial.pendingOutput?.toolOutput?.toolCalls).toHaveLength(6);expect(partial.pendingResults).toHaveLength(4);expect(partial.searchUsed).toBe(true);expect(partial.citations).toEqual([citation]);
    const result=await complete(f);
    expect(JSON.parse(result.content).summary).toBe('调查完成');expect(result.citations).toEqual([citation]);expect(result.trace).toHaveLength(6);expect(result.trace.at(-1)).toEqual({name:'web_search',status:'failed'});expect(f.counts()).toEqual({modelCalls:2,searchCalls:1});
    expect((await env.DB.prepare("SELECT COUNT(*) count FROM ai_tool_calls WHERE job_id=?1 AND name='list_project_resources'").bind(f.jobId).first<{count:number}>())!.count).toBe(4);
    expect((await projectToolConversation({...env,AI_EXECUTION_SLICE:true},f.params)).citations).toEqual([citation]);expect(f.fetch).toHaveBeenCalledTimes(3);
  });
  it('reuses a paid native response checkpointed before its tool result was saved',async()=>{
    const f=await fixture(false);
    await expect(projectToolConversation({...env,AI_EXECUTION_SLICE:true},f.params)).rejects.toBeInstanceOf(InvestigationContinuation);
    let interrupted=false;
    const files=new Proxy(env.FILES,{get(target,key){if(key==='put')return async(...args:Parameters<R2Bucket['put']>)=>{
      if(interrupted)throw new Error('fixture checkpoint interruption');
      const result=await target.put(...args);
      if((await loadInvestigation({...env,FILES:target},f.id,true,f.jobId))?.pendingSearchOutput){interrupted=true;throw new Error('fixture checkpoint interruption');}
      return result;
    };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
    await expect(projectToolConversation({...env,FILES:files,AI_EXECUTION_SLICE:true},f.params)).rejects.toThrow('fixture checkpoint interruption');
    const stored=(await loadInvestigation(env,f.id))!;
    expect(stored.pendingSearchOutput?.toolOutput?.citations).toEqual([citation]);expect(stored.pendingOutput?.toolOutput?.toolCalls).toHaveLength(6);expect(stored.pendingResults).toEqual([]);
    const result=await complete(f);expect(result.citations).toEqual([citation]);expect(f.counts()).toEqual({modelCalls:2,searchCalls:1});
  });
  it('still rejects an uncertain native dispatch before any paid response replay',async()=>{
    const f=await fixture();
    await expect(projectToolConversation({...env,AI_EXECUTION_SLICE:true},f.params)).rejects.toBeInstanceOf(InvestigationContinuation);
    const state=(await loadInvestigation(env,f.id))!;
    await saveInvestigation(env,f.context,f.id,f.params.promptVersion,{...state,searchUsed:true,pendingDispatch:true},true);
    await expect(projectToolConversation({...env,AI_EXECUTION_SLICE:true},f.params)).rejects.toThrow('结果未确认');expect(f.fetch).toHaveBeenCalledTimes(1);
  });
});
