import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { readTaskPage, readSubmissionPage } from '../src/services/collaboration-read-models';
import type { CollaborationTask, Submission } from '../src/services/collaboration';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { newId, nowIso } from '../src/core/db';

function countingDatabase() {
  let count=0;
  const DB={prepare:()=>({bind:()=>({all:async()=>{count++;return {results:[]};},first:async()=>{count++;return null;}})})} as unknown as D1Database;
  return {env:{DB} as Env,count:()=>count};
}
function tasks(size:number,detail='brief') {
  return Array.from({length:size},(_,index)=>({id:String(index),project_id:'project',detail,criteria:'',source_citations_json:JSON.stringify([{sourceVersionId:'missing'}])})) as CollaborationTask[];
}
describe('bounded task read hydration',()=>{
  it.each(['brief','long '.repeat(30)])('uses a fixed number of queries independent of page size (%s)',async detail=>{
    const small=countingDatabase(),large=countingDatabase();
    const one=await readTaskPage(small.env,tasks(1,detail)),many=await readTaskPage(large.env,tasks(100,detail));
    expect(large.count()).toBe(small.count());
    expect(large.count()).toBeLessThanOrEqual(6);
    expect(one.size).toBe(1);expect(many.size).toBe(100);
    expect(many.get('99')?.citations).toEqual([{sourceVersionId:'missing',availability:'unavailable',deletedAt:null}]);
  });
  it('does not query for an empty page and rejects mixed project hydration',async()=>{
    const counted=countingDatabase();expect((await readTaskPage(counted.env,[])).size).toBe(0);expect(counted.count()).toBe(0);
    await expect(readTaskPage(counted.env,[...tasks(1),{...tasks(1)[0]!,project_id:'other'}])).rejects.toThrow('同一项目');
  });
  it('queries submission versions once for an entire page',async()=>{
    const counted=countingDatabase();
    const rows=Array.from({length:100},()=>({material_versions_json:'["missing"]',ai_report_json:null,human_score_override_json:null})) as Submission[];
    const hydrated=await readSubmissionPage(counted.env,'project',rows);
    expect(hydrated).toHaveLength(100);expect(counted.count()).toBe(1);expect(hydrated[0]?.materialVersions).toEqual([]);
  });
  it('returns full graph and totals independently from task page limits and respects project membership',async()=>{
    const owner=await seedUser(),outsider=await seedUser(),projectId=await seedProject(owner.userId),timestamp=nowIso();
    const ids=Array.from({length:105},()=>newId());
    const statements=ids.map((id,index)=>env.DB.prepare(`INSERT INTO tasks(id,project_id,title,detail,status,revision,created_by,created_at,updated_at,lifecycle_state,criteria,effort_hours) VALUES(?1,?2,?3,'','todo',1,?4,?5,?5,'open','',1)`).bind(id,projectId,`task ${index}`,owner.userId,timestamp));
    for(let index=0;index<statements.length;index+=50)await env.DB.batch(statements.slice(index,index+50));
    await env.DB.prepare('INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,created_at) VALUES(?1,?2,?3,?4)').bind(projectId,ids[1],ids[0],timestamp).run();
    const response=await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/tasks/graph`,{headers:{cookie:authCookie(owner.token)}});
    expect(response.status).toBe(200);
    const {data}=await response.json() as {data:{items:Array<{taskId:string;dependsOnTaskIds:string[]}>;totals:{total:number;todo:number};edges:unknown[];canRegenerate:boolean}};
    expect(data.items).toHaveLength(105);expect(data.totals).toEqual({total:105,todo:105,doing:0,blocked:0,done:0});expect(data.edges).toHaveLength(1);expect(data.items.find(task=>task.taskId===ids[1])?.dependsOnTaskIds).toEqual([ids[0]]);expect(data.canRegenerate).toBe(true);
    expect((await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/tasks/graph`,{headers:{cookie:authCookie(outsider.token)}})).status).toBe(403);
    const filtered=await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/collaboration/tasks?q=task%20104&lifecycleState=open`,{headers:{cookie:authCookie(owner.token)}});
    expect((await filtered.json() as {data:{items:unknown[]}}).data.items).toHaveLength(1);
  });
  it('pages submissions by round without duplicating ties and batches selected versions',async()=>{
    const user=await seedUser(),projectId=await seedProject(user.userId),taskId=newId(),timestamp=nowIso();
    await env.DB.prepare(`INSERT INTO tasks(id,project_id,title,detail,status,revision,created_by,created_at,updated_at,lifecycle_state,criteria,effort_hours) VALUES(?1,?2,'task','','todo',1,?3,?4,?4,'open','',1)`).bind(taskId,projectId,user.userId,timestamp).run();
    for(let round=1;round<=5;round++)await env.DB.prepare(`INSERT INTO task_submissions(id,project_id,task_id,round,submitted_by,body,material_versions_json,criteria,task_revision,status,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'body','[]','',1,'pending',?6,?6)`).bind(newId(),projectId,taskId,round,user.userId,timestamp).run();
    const rounds:number[]=[];let cursor:string|null=null;
    do{
      const url=new URL(`${BASE}/api/v1/projects/${projectId}/tasks/${taskId}/submissions?limit=2`);if(cursor)url.searchParams.set('cursor',cursor);
      const response=await SELF.fetch(url,{headers:{cookie:authCookie(user.token)}});expect(response.status).toBe(200);
      const {data}=await response.json() as {data:{items:Array<{round:number;materialVersions:unknown[]}>;nextCursor:string|null}};
      expect(data.items.every(row=>row.materialVersions.length===0)).toBe(true);rounds.push(...data.items.map(row=>row.round));cursor=data.nextCursor;
    }while(cursor);
    expect(rounds).toEqual([5,4,3,2,1]);
  });

});
