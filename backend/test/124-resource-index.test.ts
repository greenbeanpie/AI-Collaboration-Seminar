import { SELF } from 'cloudflare:test';
import { authCookie } from './helpers/seed';
import { assertToolAccess } from '../src/services/project-ai-tools';
import { describe,it,expect } from 'vitest';
import { env } from './helpers/env';
import { seedUser,seedProject } from './helpers/seed';
import { newId,nowIso } from '../src/core/db';
import { getResourceIndex,searchResource,readResourceSection,buildResourceIndexBatch,invalidateResourceIndex } from '../src/services/resource-index';
import { referencesFromRead,validateReadReferences } from '../src/services/project-evidence';
import { discoveryToolDefinitions,parseDiscoveryArgs,executeDiscoveryTool } from '../src/services/project-context';

async function material(text:string) {
 const user=await seedUser(),projectId=await seedProject(user.userId),id=newId(),versionId=newId();
 await env.DB.batch([
  env.DB.prepare("INSERT INTO materials(id,project_id,title,created_by,created_at,updated_at,current_version_id) VALUES(?1,?2,'资料',?3,?4,?4,?5)").bind(id,projectId,user.userId,nowIso(),versionId),
  env.DB.prepare("INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at) VALUES(?1,?2,?3,1,'{}',?4,'manual',?5,?6)").bind(versionId,id,projectId,text,user.userId,nowIso()),
 ]);return {projectId,id,target:{resourceType:'material' as const,versionId},user};
}
describe('version bound internal resource index',()=>{
 it('allows members to read archived material indexes without permitting archived AI execution',async()=>{
  const f=await material('# 归档资料\n保留的原文');await env.DB.prepare("UPDATE projects SET status='archived' WHERE id=?1").bind(f.projectId).run();
  const url=`https://example.com/api/v1/projects/${f.projectId}/resource-index/material/${f.target.versionId}`;
  const response=await SELF.fetch(url,{headers:{cookie:authCookie(f.user.token)}});expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
  await expect(assertToolAccess(env,{projectId:f.projectId,userId:f.user.userId})).rejects.toThrow();
 });

 it('finds text spanning block boundaries without counting overlap as duplicate matches',async()=>{
  const f=await material('x'.repeat(1798)+'跨块中文检索'+ 'z'.repeat(1900));
  const found=await searchResource(env,f.projectId,f.target,'跨块中文检索');expect(found.items).toHaveLength(1);
  const read=await readResourceSection(env,f.projectId,f.target,String(found.items[0]!.sectionId),1798,true);
  expect('text' in read&&read.text.startsWith('跨块中文检索')).toBe(true);
  expect((await searchResource(env,f.projectId,f.target,'中文检索')).items).toHaveLength(1);
 });
 it('uses real FTS trigram for Chinese/English and literal short searches; search alone creates no evidence',async()=>{
  const f=await material('# 第一章\n这是完整中文检索。Alpha beta。特殊"字符 %_ 不作为通配符。');
  for(const query of ['完整中文','中文','检','ALPHA','特殊"字符','%_']){
   const found=await searchResource(env,f.projectId,f.target,query);
   expect(found.items).toHaveLength(1);expect(referencesFromRead(found)).toEqual([]);
  }
  expect((await searchResource(env,f.projectId,f.target,'不存在')).items).toHaveLength(0);
  const index=await getResourceIndex(env,f.projectId,f.target);expect(index.indexStatus).toBe('ready');
  const read=await readResourceSection(env,f.projectId,f.target,String(index.items[0]!.sectionId));
  const refs=referencesFromRead(read);expect(refs).toHaveLength(1);await expect(validateReadReferences(env,f.projectId,refs)).resolves.toBeUndefined();
 });
 it('resumes bounded batches idempotently and counts Unicode code points',async()=>{
  const text='😀'.repeat(40000)+'\n终点';const f=await material(text);
  const first=await buildResourceIndexBatch(env,f.projectId,f.target);expect(first.next_seq).toBe(20);expect(first.status).toBe('building');
  const second=await buildResourceIndexBatch(env,f.projectId,f.target);expect(second.status).toBe('ready');
  await buildResourceIndexBatch(env,f.projectId,f.target);
  const index=await getResourceIndex(env,f.projectId,f.target);expect(index.items[0]).toMatchObject({startOffset:0,endOffset:1800});
  const read=await readResourceSection(env,f.projectId,f.target,String(index.items[0]!.sectionId),1799);
  expect('text' in read?read.text:null).toBe('😀');
  const count=await env.DB.prepare('SELECT count(*) n FROM resource_index_blocks WHERE version_id=?1').bind(f.target.versionId).first<{n:number}>();expect(count!.n).toBe(second.next_seq);
 });
 it('isolates project and immutable old versions',async()=>{
  const f=await material('原版本正文');const other=await material('新版本正文');
  await expect(searchResource(env,other.projectId,f.target,'正文')).rejects.toThrow('不属于');
  await expect(getResourceIndex(env,f.projectId,{...f.target,versionId:other.target.versionId})).rejects.toThrow();
  await env.DB.prepare('UPDATE materials SET current_version_id=NULL WHERE id=?1').bind(f.id).run();
  expect((await searchResource(env,f.projectId,f.target,'原版本')).items).toHaveLength(1);
  await invalidateResourceIndex(env,f.projectId,f.target);expect((await getResourceIndex(env,f.projectId,f.target)).items).toHaveLength(1);
 });
 it('preserves genuine PDF fragment/page references and forbids deleted source reads',async()=>{
  const f=await material('unused'),sourceId=newId(),versionId=newId(),fragmentId=newId(),time=nowIso();
  await env.DB.batch([
   env.DB.prepare("INSERT INTO sources(id,project_id,kind,title,created_by,created_at,updated_at) VALUES(?1,?2,'paste','PDF fixture',?3,?4,?4)").bind(sourceId,f.projectId,f.user.userId,time),
   env.DB.prepare("INSERT INTO source_versions(id,source_id,project_id,revision,origin,status,created_at) VALUES(?1,?2,?3,1,'paste','ready',?4)").bind(versionId,sourceId,f.projectId,time),
   env.DB.prepare("INSERT INTO source_fragments(id,source_version_id,project_id,page_number,seq,kind,content,created_at) VALUES(?1,?2,?3,7,0,'text','真实原文中文。',?4)").bind(fragmentId,versionId,f.projectId,time),
  ]);
  const target={resourceType:'source' as const,versionId};const index=await getResourceIndex(env,f.projectId,target);
  const result=await readResourceSection(env,f.projectId,target,String(index.items[0]!.sectionId));
  const refs=referencesFromRead(result);expect(refs[0]).toMatchObject({fragmentId,pageNumber:7,quote:'真实原文中文。'});await validateReadReferences(env,f.projectId,refs);
  await env.DB.prepare('UPDATE sources SET deleted_at=?2,lifecycle_version=lifecycle_version+1 WHERE id=?1').bind(sourceId,time).run();
  await expect(readResourceSection(env,f.projectId,target,String(index.items[0]!.sectionId))).rejects.toThrow('回收');
  await expect(searchResource(env,f.projectId,target,'中文')).rejects.toThrow('回收');
 });
 it('uses minimal shared schema, rejects wrong scope and supports revalidation',async()=>{
  const f=await material('测试正文');
  for(const name of ['get_resource_index','search_resource','read_resource_section'])expect(discoveryToolDefinitions.find(t=>t.name===name)?.parameters.required).toEqual(expect.arrayContaining(['resourceType','versionId']));
  expect(()=>parseDiscoveryArgs('get_resource_index',{...f.target,projectId:f.projectId},f.projectId)).toThrow();
  const args=parseDiscoveryArgs('search_resource',{...f.target,query:'正文'},f.projectId);
  expect((await executeDiscoveryTool(env,f.projectId,'search_resource',args)).items).toHaveLength(1);
 });
});
