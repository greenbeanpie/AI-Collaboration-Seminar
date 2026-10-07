
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { env } from './helpers/env';
import { configureGoFixture } from './helpers/provider-config';
import { seedProject, seedUser } from './helpers/seed';
import { loadAiConfig } from '../src/ai/config';
import { aiJsonCall } from '../src/services/agent';
import { assignmentSchemaFor } from '../src/services/assignment';
import { reviewSchemaFor } from '../src/services/review';
import { adjustmentSchemaFor, decompositionSchemaFor, evaluationSchemaFor, type CollaborationAiInput } from '../src/services/collaboration-ai';

await configureGoFixture();
afterEach(() => vi.unstubAllGlobals());
const taskId = '11111111-1111-4111-8111-111111111111';
const memberId = '22222222-2222-4222-8222-222222222222';
const unknownId = '33333333-3333-4333-8333-333333333333';
const planning = {operation:'collaboration.decompose',projectId:taskId,requestedBy:memberId,settingsRevision:1,brief:'验证'} satisfies CollaborationAiInput;
const task = {title:'验证',detail:'工时估算假设：未知',criteria:'完成验证',effortHours:1};
const material = {versionId:taskId,markdown:'实际成果正文',attachments:[]};
const report = {decision:'accept',feedback:'完成',evidence:[{materialVersionId:taskId,quote:'实际成果正文'}],limitations:[],coverage:'complete'};
function issues(schema:z.ZodType, output:unknown) { const result=schema.safeParse(output); expect(result.success).toBe(false); return !result.success ? result.error.issues : []; }

describe('business output validation participates in automatic model repair', () => {
  it('feeds task/member errors back to model and accepts only corrected snapshot IDs', async () => {
    const user=await seedUser(), projectId=await seedProject(user.userId);
    const config=(await loadAiConfig(env.DB))!;
    const schema=assignmentSchemaFor({tasks:[{taskId} as never],members:[{userId:memberId}]});
    const fetch=vi.fn(async (_url:RequestInfo|URL, init?:RequestInit) => {
      const body=JSON.parse(String(init?.body)) as {messages:Array<{content:string}>};
      if (fetch.mock.calls.length===2) {
        expect(body.messages.at(-1)?.content).toContain('assignments');
        expect(body.messages.at(-1)?.content).toContain(memberId);
      }
      return Response.json({choices:[{message:{content:JSON.stringify({assignments:[{taskId,assigneeId:fetch.mock.calls.length===1 ? unknownId : memberId}]})}}],usage:{prompt_tokens:20,completion_tokens:10}});
    });
    vi.stubGlobal('fetch',fetch);
    const out=await aiJsonCall(env,{projectId,purpose:'textEconomy',configVersionId:config.id,model:config.config.textEconomy.model,modelConfig:config.config.textEconomy,promptVersion:'business-repair-regression',messages:[{role:'user',content:'建议分工'}],schema});
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(out.data.assignments).toEqual([{taskId,assigneeId:memberId}]);
  });
  it('reports missing/duplicate tasks and preserves null assignment', () => {
    const schema=assignmentSchemaFor({tasks:[{taskId} as never],members:[{userId:memberId}]});
    expect(issues(schema,{assignments:[]})[0]?.path).toEqual(['assignments']);
    expect(issues(schema,{assignments:[{taskId,assigneeId:null},{taskId,assigneeId:null}]})[0]?.path).toEqual(['assignments',1,'taskId']);
    expect(schema.safeParse({assignments:[{taskId,assigneeId:null}]}).success).toBe(true);
  });
  it('rejects unknown or duplicate adjustment IDs within correction schema', () => {
    const schema=adjustmentSchemaFor({...planning,taskIds:[taskId],tasks:[{...task,taskId,revision:1}]});
    expect(issues(schema,{tasks:[],updates:[{...task,taskId:unknownId}]})[0]?.path).toEqual(['updates',0,'taskId']);
    expect(schema.safeParse({tasks:[],updates:[{...task,taskId}]}).success).toBe(true);
  });
  it('repairs duplicate keys, cyclic dependencies and archived task reuse', () => {
    const schema=decompositionSchemaFor(planning,{taskIds:[],edges:[]});
    expect(issues(schema,{tasks:[{...task,key:'t1',dependsOn:['t2']},{...task,title:'第二任务',key:'t2',dependsOn:['t1']}]})[0]?.message).toContain('循环');
    expect(issues(schema,{reusedTaskIds:[taskId],tasks:[task]})[0]?.path).toEqual(['reusedTaskIds']);
    expect(issues(schema,{tasks:[{...task,key:'t1'},{...task,title:'第二任务',key:'t1'}]})[0]?.path).toEqual(['tasks',1,'key']);
    expect(schema.safeParse({tasks:[{...task,key:'t1'},{...task,title:'第二任务',key:'t2',dependsOn:['t1']}]}).success).toBe(true);
  });
  it('checks source grounding inside repair and permits no-change progression', () => {
    const sourceVersionId=taskId, fragmentId=memberId;
    const input={...planning,sourceSnapshots:[{sourceVersionId,fragments:[{fragmentId,pageNumber:null,content:'实际要求'}]} as never]};
    const schema=decompositionSchemaFor(input,{taskIds:[],edges:[]});
    expect(issues(schema,{tasks:[{...task,citations:[{sourceVersionId,fragmentId,pageNumber:null,quote:'虚构要求'}]}]})[0]?.message).toContain('固定版本原文');
    expect(schema.safeParse({tasks:[{...task,citations:[{sourceVersionId,fragmentId,pageNumber:null,quote:'实际要求'}]}]}).success).toBe(true);
    expect(adjustmentSchemaFor({...input,progression:true}).safeParse({tasks:[],updates:[]}).success).toBe(true);
  });
  it('repairs review rubric coverage and wrong immutable evidence before publication', () => {
    const schema=reviewSchemaFor([{key:'a'}],[{materialVersionId:taskId,markdown:material.markdown}]);
    const output={scores:[{key:'a',score:80,confidence:.9,evidence:report.evidence}],overall:{summary:'总体评价'}};
    expect(issues(schema,{...output,scores:[{...output.scores[0],key:'unknown'}]})[0]?.path).toEqual(['scores']);
    expect(issues(schema,{...output,scores:[{...output.scores[0],evidence:[{materialVersionId:unknownId,quote:'实际成果正文'}]}]})[0]?.path).toEqual(['scores',0,'evidence',0]);
    expect(schema.safeParse(output).success).toBe(true);
  });
  it('checks task evaluation evidence inside correction schema without relaxing fixed quotes', () => {
    const schema=evaluationSchemaFor([material],null);
    expect(issues(schema,{...report,evidence:[{materialVersionId:taskId,quote:'虚构成果'}]})[0]?.path).toEqual(['evidence',0]);
    expect(schema.safeParse(report).success).toBe(true);
  });
});
