import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { newId, nowIso } from '../src/core/db';

describe('server list search and aggregates',()=>{
  it('paginates members with identical timestamps without duplicates and reports complete totals/workload',async()=>{
    const owner=await seedUser(),projectId=await seedProject(owner.userId),cookie=authCookie(owner.token),now=nowIso();
    const users=[];
    for(let i=0;i<5;i++){
      const user=await seedUser(undefined,`Selector ${i}`);users.push(user);
      await env.DB.prepare("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES(?1,?2,?3,'member',?4)").bind(newId(),projectId,user.userId,now).run();
    }
    for(let i=0;i<4;i++) await env.DB.prepare("INSERT INTO tasks(id,project_id,title,detail,status,assignee_id,created_by,created_at,updated_at) VALUES(?1,?2,'Task','','todo',?3,?4,?5,?5)").bind(newId(),projectId,users[0]!.userId,owner.userId,now).run();
    let cursor:string|null=null;const ids:string[]=[];
    do{
      const url=new URL(`${BASE}/api/v1/projects/${projectId}/members?limit=2&q=selector`);if(cursor)url.searchParams.set('cursor',cursor);
      const res=await SELF.fetch(url,{headers:{cookie}});expect(res.status).toBe(200);const data=(await res.json() as any).data;
      expect(data.totalCount).toBe(5);expect(data.workload[users[0]!.userId]).toBe(4);
      ids.push(...data.items.map((item:any)=>item.userId));cursor=data.nextCursor;
    }while(cursor);
    expect(ids).toHaveLength(5);expect(new Set(ids).size).toBe(5);
  });
  it('retrieves a source directly beyond the first page, searches server-side and rejects another project',async()=>{
    const owner=await seedUser(),projectId=await seedProject(owner.userId),foreignId=await seedProject(owner.userId),cookie=authCookie(owner.token);
    const sourceId=newId();
    await env.DB.prepare("INSERT INTO sources(id,project_id,kind,title,created_by,created_at,updated_at) VALUES(?1,?2,'paste','Unique needle',?3,?4,?4)").bind(sourceId,projectId,owner.userId,nowIso()).run();
    const result=await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/sources/${sourceId}`,{headers:{cookie}});expect(result.status).toBe(200);expect((await result.json() as any).data.title).toBe('Unique needle');
    const search=await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/sources?q=NEEDLE&limit=1`,{headers:{cookie}});expect(search.status).toBe(200);expect((await search.json() as any).data.items).toHaveLength(1);
    expect((await SELF.fetch(`${BASE}/api/v1/projects/${foreignId}/sources/${sourceId}`,{headers:{cookie}})).status).toBe(404);
  });
});
