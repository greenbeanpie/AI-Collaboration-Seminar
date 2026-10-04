import type { Env } from '../env';
import { invalidState, notFound } from '../core/errors';
import { sourceLifecycleGuard } from './source-lifecycle';

export type ResourceIndexType = 'source' | 'material';
export interface ResourceIndexTarget { resourceType: ResourceIndexType; versionId: string }
interface Resource { resourceId:string; title:string; revision:number; coverage:string }
interface State { cursor:number; next_seq:number; heading:string; status:string }
interface Block { id:string; seq:number; fragment_id:string|null; page_number:number|null; heading:string; start_offset:number; end_offset:number; content:string }
const BLOCK=1800, PAGE=20;

export async function assertIndexedResource(env:Env, projectId:string, target:ResourceIndexTarget):Promise<Resource> {
 const row=target.resourceType==='source'
  ? await env.DB.prepare(`SELECT s.id resourceId,s.title,s.lifecycle_version revision,COALESCE(p.text_status,'pending') coverage FROM source_versions v JOIN sources s ON s.id=v.source_id LEFT JOIN source_processing p ON p.source_version_id=v.id WHERE v.id=?1 AND v.project_id=?2 AND s.project_id=?2 AND ${sourceLifecycleGuard('v.id','NULL')}`).bind(target.versionId,projectId).first<Resource>()
  : await env.DB.prepare(`SELECT m.id resourceId,m.title,v.revision,'ready' coverage FROM material_versions v JOIN materials m ON m.id=v.material_id WHERE v.id=?1 AND v.project_id=?2 AND m.project_id=?2`).bind(target.versionId,projectId).first<Resource>();
 if(!row)throw notFound('资料版本不存在、已回收或不属于当前项目');
 return row;
}

/** Called after text changes within a source version (OCR/import); no AI calls. */
export async function invalidateResourceIndex(env:Env, projectId:string,target:ResourceIndexTarget) {
 await env.DB.batch([
  env.DB.prepare('DELETE FROM resource_index_blocks WHERE project_id=?1 AND resource_type=?2 AND version_id=?3').bind(projectId,target.resourceType,target.versionId),
  env.DB.prepare('DELETE FROM resource_index_state WHERE project_id=?1 AND resource_type=?2 AND version_id=?3').bind(projectId,target.resourceType,target.versionId),
 ]);
}

/** At most 20 blocks per invocation. CAS cursor and atomic batch make retries/concurrent reads idempotent. */
export async function buildResourceIndexBatch(env:Env,projectId:string,target:ResourceIndexTarget) {
 const resource=await assertIndexedResource(env,projectId,target);
 await env.DB.prepare('INSERT OR IGNORE INTO resource_index_state(project_id,resource_type,version_id) VALUES(?1,?2,?3)').bind(projectId,target.resourceType,target.versionId).run();
 const state=(await env.DB.prepare('SELECT * FROM resource_index_state WHERE project_id=?1 AND resource_type=?2 AND version_id=?3').bind(projectId,target.resourceType,target.versionId).first<State>())!;
 if(state.status==='ready')return state;
 let cursor=state.cursor,seq=state.next_seq,heading=state.heading,done=false;
 let headingLevels:string[]=[];
 try { headingLevels=JSON.parse(heading||'[]') as string[]; } catch { headingLevels=[heading]; }
 const blocks:Array<{text:string;searchText:string;fragmentId:string|null;pageNumber:number|null;start:number;heading:string;seq:number}>=[];
 for(let i=0;i<PAGE;i++) {
  const row=target.resourceType==='material'
   ? await env.DB.prepare('SELECT substr(markdown,?3+1,2000) text,NULL fragmentId,NULL pageNumber,?3 start FROM material_versions WHERE id=?1 AND project_id=?2').bind(target.versionId,projectId,cursor).first<{text:string;fragmentId:string|null;pageNumber:number|null;start:number}>()
   : await env.DB.prepare(`SELECT substr(content,MAX(1,?3-start+1),2000) text,id fragmentId,page_number pageNumber,MAX(?3,start) start FROM (SELECT id,page_number,seq,content,COALESCE(SUM(length(content)+1) OVER(ORDER BY seq,id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) start FROM source_fragments WHERE source_version_id=?1 AND project_id=?2) WHERE start+length(content)>?3 ORDER BY seq,id LIMIT 1`).bind(target.versionId,projectId,cursor).first<{text:string;fragmentId:string|null;pageNumber:number|null;start:number}>();
  if(!row?.text){done=true;break;}
  const chars=Array.from(row.text);let length=Math.min(BLOCK,chars.length);
  // Preserve paragraph boundaries when possible; offsets always count Unicode code points.
  if(chars.length>BLOCK){const newline=chars.slice(0,BLOCK).lastIndexOf('\n');if(newline>BLOCK/2)length=newline+1;}
  // A block belongs to one heading path; never label pre-heading text with a later heading.
  const candidate=chars.slice(0,length).join('');
  const boundary=/\n(?=#{1,6}\s+)/.exec(candidate);
  if(boundary)length=Array.from(candidate.slice(0,boundary.index+1)).length;
  const text=chars.slice(0,length).join('');
  const title=/^(#{1,6})\s+(.+)(?:\n|$)/.exec(text);
  if(title){const level=title[1]!.length;headingLevels=headingLevels.slice(0,level-1);headingLevels[level-1]=title[2]!;heading=JSON.stringify(headingLevels);}
  blocks.push({text,searchText:chars.slice(0,length+199).join(''),fragmentId:row.fragmentId,pageNumber:row.pageNumber,start:row.start,heading:headingLevels.filter(Boolean).join(' / '),seq:seq++});
  cursor=row.start+length;
 }
 await assertIndexedResource(env,projectId,target);
 const statements=blocks.map(b=>env.DB.prepare(`INSERT OR IGNORE INTO resource_index_blocks(id,project_id,resource_type,version_id,seq,fragment_id,page_number,heading,start_offset,end_offset,content,search_content) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?13 WHERE EXISTS(SELECT 1 FROM resource_index_state WHERE project_id=?2 AND resource_type=?3 AND version_id=?4 AND cursor=?12)`)
  .bind(`${target.resourceType}:${target.versionId}:${b.seq}`,projectId,target.resourceType,target.versionId,b.seq,b.fragmentId,b.pageNumber,b.heading,b.start,b.start+Array.from(b.text).length,b.text,state.cursor,b.searchText));
 statements.push(env.DB.prepare(`UPDATE resource_index_state SET cursor=?4,next_seq=?5,heading=?6,status=?7 WHERE project_id=?1 AND resource_type=?2 AND version_id=?3 AND cursor=?8`).bind(projectId,target.resourceType,target.versionId,cursor,seq,heading,done&&resource.coverage==='ready'?'ready':'building',state.cursor));
 await env.DB.batch(statements);
 await assertIndexedResource(env,projectId,target);
 return {cursor,next_seq:seq,heading,status:done&&resource.coverage==='ready'?'ready':'building'};
}

export async function getResourceIndex(env:Env,projectId:string,target:ResourceIndexTarget,offset=0) {
 const state=await buildResourceIndexBatch(env,projectId,target);
 const rows=await env.DB.prepare('SELECT id sectionId,seq,heading,page_number pageNumber,start_offset startOffset,end_offset endOffset FROM resource_index_blocks WHERE project_id=?1 AND resource_type=?2 AND version_id=?3 ORDER BY seq LIMIT 21 OFFSET ?4').bind(projectId,target.resourceType,target.versionId,offset).all();
 const resource=await assertIndexedResource(env,projectId,target);
 return {untrustedData:true,directoryOnly:true,...target,...resource,indexStatus:state.status,items:rows.results.slice(0,PAGE),nextOffset:rows.results.length>PAGE?offset+PAGE:null};
}

export async function searchResource(env:Env,projectId:string,target:ResourceIndexTarget,query:string,offset=0) {
 if(!query.trim()||Array.from(query).length>200)throw invalidState('请输入1至200字符的检索文字');
 const state=await buildResourceIndexBatch(env,projectId,target);
 const long=Array.from(query).length>=3;
 const rows=await env.DB.prepare(`SELECT b.id sectionId,b.heading,b.page_number pageNumber,b.start_offset startOffset,substr(b.search_content,MAX(1,instr(lower(b.search_content),lower(?4))-80),240) excerpt FROM resource_index_blocks b ${long?'JOIN resource_index_fts f ON f.rowid=b.rowid':''} WHERE b.project_id=?1 AND b.resource_type=?2 AND b.version_id=?3 AND ${long?'resource_index_fts MATCH ?5 AND ':''}instr(lower(b.search_content),lower(?4)) BETWEEN 1 AND length(b.content) ORDER BY b.seq LIMIT 21 OFFSET ?${long?'6':'5'}`).bind(projectId,target.resourceType,target.versionId,query,...(long?[`"${query.replaceAll('"','""')}"`,offset]:[offset])).all();
 const resource=await assertIndexedResource(env,projectId,target);
 return {untrustedData:true,directoryOnly:true,...target,...resource,indexStatus:state.status,items:rows.results.slice(0,PAGE),nextOffset:rows.results.length>PAGE?offset+PAGE:null};
}

export async function readResourceSection(env:Env,projectId:string,target:ResourceIndexTarget,sectionId:string,offset=0,neighbors=false) {
 const resource=await assertIndexedResource(env,projectId,target);
 const block=await env.DB.prepare('SELECT seq FROM resource_index_blocks WHERE id=?1 AND project_id=?2 AND resource_type=?3 AND version_id=?4').bind(sectionId,projectId,target.resourceType,target.versionId).first<{seq:number}>();
 if(!block)throw notFound('章节不存在或不属于指定版本');
 const rows=await env.DB.prepare('SELECT * FROM resource_index_blocks WHERE project_id=?1 AND resource_type=?2 AND version_id=?3 AND seq BETWEEN ?4 AND ?5 ORDER BY seq').bind(projectId,target.resourceType,target.versionId,block.seq-(neighbors?1:0),block.seq+(neighbors?1:0)).all<Block>();
 let skip=offset,remaining=6000,total=0;const fragments:Array<{fragmentId:string;pageNumber:number|null;quote:string}>=[];let text='';
 for(const b of rows.results){const chars=Array.from(b.content);total+=chars.length;if(skip>=chars.length){skip-=chars.length;continue;}const quote=chars.slice(skip,skip+remaining).join('');skip=0;remaining-=Array.from(quote).length;text+=quote;if(quote&&b.fragment_id)fragments.push({fragmentId:b.fragment_id,pageNumber:b.page_number,quote});}
 const after=await assertIndexedResource(env,projectId,target);if(after.revision!==resource.revision)throw invalidState('资料生命周期已变化');
 return {untrustedData:true,...target,...resource,sectionId,offset,nextOffset:total>offset+6000?offset+6000:null,...(target.resourceType==='source'?{fragments}:{text})};
}

/** A cron slice, bounded by versions and blocks; retries resume each stored cursor. */
export async function backfillResourceIndexes(env:Env,limit=5) {
 const rows=await env.DB.prepare(`SELECT * FROM (SELECT v.project_id projectId,'source' resourceType,v.id versionId FROM source_versions v JOIN source_processing p ON p.source_version_id=v.id WHERE p.text_status='ready' AND ${sourceLifecycleGuard('v.id','NULL')} UNION ALL SELECT project_id,'material',id FROM material_versions) r WHERE NOT EXISTS(SELECT 1 FROM resource_index_state s WHERE s.project_id=r.projectId AND s.resource_type=r.resourceType AND s.version_id=r.versionId AND s.status='ready') ORDER BY versionId LIMIT ?1`).bind(Math.min(10,Math.max(1,limit))).all<{projectId:string;resourceType:ResourceIndexType;versionId:string}>();
 for(const row of rows.results)await buildResourceIndexBatch(env,row.projectId,row);
 return rows.results.length;
}
