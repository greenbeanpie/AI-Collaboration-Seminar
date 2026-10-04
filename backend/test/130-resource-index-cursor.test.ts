import {describe,it,expect} from 'vitest';
import {env} from './helpers/env';
import {seedUser,seedProject} from './helpers/seed';
import {newId,nowIso} from '../src/core/db';
import {buildResourceIndexBatch,sourceIndexChunkSql,readResourceSection} from '../src/services/resource-index';
it('seeks source fragments by indexed sequence and resumes Unicode offsets without full-source window scans',async()=>{
 const user=await seedUser(),project=await seedProject(user.userId),source=newId(),version=newId(),time=nowIso();
 await env.DB.batch([
  env.DB.prepare("INSERT INTO sources(id,project_id,kind,title,created_by,created_at,updated_at) VALUES(?1,?2,'paste','大资料',?3,?4,?4)").bind(source,project,user.userId,time),
  env.DB.prepare("INSERT INTO source_versions(id,source_id,project_id,revision,origin,status,created_at) VALUES(?1,?2,?3,1,'paste','ready',?4)").bind(version,source,project,time),
  env.DB.prepare("INSERT INTO source_processing(source_version_id,project_id,text_status,updated_at) VALUES(?1,?2,'ready',?3)").bind(version,project,time),
 ]);
 const ids:string[]=[];
 for(let group=0;group<10;group++){
  const batch=[];
  for(let i=0;i<20;i++){const seq=group*20+i,id=newId();ids.push(id);batch.push(env.DB.prepare("INSERT INTO source_fragments(id,source_version_id,project_id,page_number,seq,kind,content,created_at,heading_path) VALUES(?1,?2,?3,?4,?4,'text',?5,?6,?7)").bind(id,version,project,seq,'😀'.repeat(1801)+`第${seq}段`,time,JSON.stringify(['章节',`第${seq}段`])));}
  await env.DB.batch(batch);
 }
 const plan=await env.DB.prepare('EXPLAIN QUERY PLAN '+sourceIndexChunkSql).bind(version,project,100,0).all<{detail:string}>();
 const details=plan.results.map(p=>p.detail).join(';');expect(details).toContain('SEARCH source_fragments USING INDEX');expect(details).toMatch(/source_version_id=\?.*seq>\?/u);expect(details).not.toMatch(/SCAN source_fragments|TEMP B-TREE/);
 const probe=await env.DB.prepare(sourceIndexChunkSql).bind(version,project,100,0).all();
 expect(probe.results).toHaveLength(1);expect(probe.meta.rows_read).toBe(1);
 console.info(`Source cursor query: ${details}; D1 rows_read=${probe.meta.rows_read} for 200 fragments`);
 const target={resourceType:'source' as const,versionId:version};
 const first=await buildResourceIndexBatch(env,project,target);expect(first.next_seq).toBe(20);expect(first.source_seq).toBe(10);expect(first.source_offset).toBe(0);
 let state=first;for(let i=0;i<25&&state.status!=='ready';i++)state=await buildResourceIndexBatch(env,project,target);expect(state.status).toBe('ready');expect(state.next_seq).toBe(400);
 const block=await env.DB.prepare('SELECT id,start_offset,end_offset,content,fragment_id,heading FROM resource_index_blocks WHERE version_id=?1 AND seq=201').bind(version).first<{id:string;start_offset:number;end_offset:number;content:string;fragment_id:string;heading:string}>();
 expect(block!.content).toBe('😀第100段');expect(block!.fragment_id).toBe(ids[100]);expect(block!.heading).toBe('章节 / 第100段');
 const lengths=Array.from({length:100},(_,i)=>1801+Array.from(`第${i}段`).length+1).reduce((a,b)=>a+b,0);
 expect(block!.start_offset).toBe(lengths+1800);expect(block!.end_offset).toBe(lengths+1801+Array.from('第100段').length);
 const read=await readResourceSection(env,project,target,block!.id);expect('fragments' in read&&read.fragments[0]).toMatchObject({fragmentId:ids[100],pageNumber:100,quote:'😀第100段'});
});
