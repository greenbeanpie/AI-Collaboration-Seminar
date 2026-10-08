import { env } from './helpers/env';
import { SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { seedUser, seedProject, authCookie } from './helpers/seed';
import { newId, nowIso } from '../src/core/db';
it('looks up one known upload without scanning or exposing another project',async()=>{
 const user=await seedUser(),project=await seedProject(user.userId),foreign=await seedProject(user.userId),ids=[newId(),newId()];
 for(const id of ids)await env.DB.prepare("INSERT INTO files(id,project_id,uploader_user_id,r2_key,mime_declared,ext,status,created_at,original_name) VALUES(?1,?2,?3,?1,'text/plain','.txt','pending',?4,'upload.txt')").bind(id,project,user.userId,nowIso()).run();
 const get=(p:string,id:string)=>SELF.fetch('https://example.com/api/v1/projects/'+p+'/files?fileId='+id+'&limit=1',{headers:{cookie:authCookie(user.token)}});
 const response=await get(project,ids[0]!);expect(response.status).toBe(200);const data=(await response.json() as any).data;expect(data.items.map((item:any)=>item.fileId)).toEqual([ids[0]]);expect(data.nextCursor).toBeNull();
 expect((await (await get(foreign,ids[0]!)).json() as any).data.items).toEqual([]);
});
it('searches paged source fragments and locates a citation beyond the first page',async()=>{
 const user=await seedUser(),project=await seedProject(user.userId),source=newId(),version=newId(),time=nowIso(),target=newId();
 await env.DB.prepare("INSERT INTO sources(id,project_id,kind,title,created_by,created_at,updated_at) VALUES(?1,?2,'paste','text',?3,?4,?4)").bind(source,project,user.userId,time).run();
 await env.DB.prepare("INSERT INTO source_versions(id,source_id,project_id,revision,origin,status,created_at) VALUES(?1,?2,?3,1,'paste','ready',?4)").bind(version,source,project,time).run();
 for(let seq=1;seq<=3;seq++)await env.DB.prepare("INSERT INTO source_fragments(id,source_version_id,project_id,seq,content,kind,created_at) VALUES(?1,?2,?3,?4,?5,'text',?6)").bind(seq===3?target:newId(),version,project,seq,seq===3?'Needle fragment':'ordinary',time).run();
 const base='https://example.com/api/v1/projects/'+project+'/sources/'+source+'/versions/'+version+'/fragments';
 const get=(query:string)=>SELF.fetch(base+query,{headers:{cookie:authCookie(user.token)}});
 const first=(await (await get('?limit=1')).json() as any).data;expect(first.items[0].seq).toBe(1);expect(first.nextCursor).toBe('1');
 const searched=(await (await get('?q=NEEDLE&limit=1')).json() as any).data;expect(searched.items[0].fragmentId).toBe(target);expect(searched.nextCursor).toBeNull();
 const located=(await (await get('?fragmentId='+target)).json() as any).data;expect(located.items).toHaveLength(1);expect(located.items[0].seq).toBe(3);
 const outsider=await seedUser();await seedProject(outsider.userId);
 expect((await SELF.fetch(base,{headers:{cookie:authCookie(outsider.token)}})).status).toBe(403);
 expect((await get('?cursor=abc')).status).toBe(400);
});
