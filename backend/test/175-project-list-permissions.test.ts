import { expect, it, vi } from 'vitest';
import { BASE, env } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { createApp } from '../src/app';
import { effectivePermissions } from '../src/services/project-permissions';

it.each([1,20,100])('returns equivalent permission snapshots for %i projects with one list query',async count=>{
  const user=await seedUser();const ids:string[]=[];
  for(let i=0;i<count;i++){
    const id=await seedProject(user.userId);ids.push(id);
    if(i%2)await env.DB.prepare("UPDATE project_members SET role='member',permissions_json=?3,permissions_revision=7 WHERE project_id=?1 AND user_id=?2").bind(id,user.userId,JSON.stringify({resourceManage:true,scoreInitiate:false})).run();
  }
  const prepare=vi.spyOn(env.DB,'prepare');
  const response=await createApp().request(`${BASE}/api/v1/projects?limit=100`,{headers:{cookie:authCookie(user.token)}},env);
  expect(response.status).toBe(200);
  const {data}=await response.json() as {data:{items:Array<{id:string;role:string;permissions:unknown;permissionsRevision:number;canManagePermissions:boolean}>}};
  expect(data.items).toHaveLength(count);
  const sql=prepare.mock.calls.map(call=>call[0]);prepare.mockRestore();
  expect(sql.filter(query=>query.includes('FROM projects p JOIN project_members pm'))).toHaveLength(1);
  expect(sql.filter(query=>query.startsWith('SELECT role,permissions_json,permissions_revision FROM project_members'))).toHaveLength(0);
  for(const item of data.items){
    const index=ids.indexOf(item.id),owner=index%2===0;
    expect(item.permissions).toEqual(effectivePermissions(owner?'owner':'member',owner?null:JSON.stringify({resourceManage:true,scoreInitiate:false})));
    expect(item.canManagePermissions).toBe(owner);expect(item.permissionsRevision).toBe(owner?1:7);
  }
  const listSql=sql.find(query=>query.includes('FROM projects p JOIN project_members pm'))!;
  const oldListSql=listSql.replace(', pm.permissions_json, pm.permissions_revision','');
  const before:number[]=[],after:number[]=[];let oldRowsRead=0,newRowsRead=0;
  for(let sample=0;sample<5;sample++){
    let started=performance.now();
    const list=await env.DB.prepare(oldListSql).bind(user.userId,'active',101).all<{id:string}>();
    let read=list.meta.rows_read;
    for(const row of list.results){
      const permissions=await env.DB.prepare('SELECT role,permissions_json,permissions_revision FROM project_members WHERE project_id=?1 AND user_id=?2').bind(row.id,user.userId).all();
      read+=permissions.meta.rows_read;
    }
    before.push(performance.now()-started);oldRowsRead=read;
    started=performance.now();
    const joined=await env.DB.prepare(listSql).bind(user.userId,'active',101).all();
    after.push(performance.now()-started);newRowsRead=joined.meta.rows_read;
  }
  const percentile=(samples:number[],percent:number)=>[...samples].sort((a,b)=>a-b)[Math.ceil(samples.length*percent)-1];
  expect(newRowsRead).toBeLessThan(oldRowsRead);
  console.log(JSON.stringify({benchmark:'project_list_permissions_local',projects:count,samples:5,queriesBefore:count+1,queriesAfter:1,rowsReadBefore:oldRowsRead,rowsReadAfter:newRowsRead,p50BeforeMs:percentile(before,.5),p95BeforeMs:percentile(before,.95),p50AfterMs:percentile(after,.5),p95AfterMs:percentile(after,.95)}));
});
