import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedUser } from './helpers/seed';
import { newId, sha256Hex } from '../src/core/db';
import { creationPayload } from '../src/services/creation-drafts';
const request = (token:string,path:string,body:unknown,key:string) => SELF.fetch(BASE+'/api/v1'+path,{method:'POST',headers:{cookie:authCookie(token),'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body)});
const data = async (response:Response) => (await response.json() as {data:any}).data;
describe('creation idempotency across default changes', () => {
  it('replays old canonical draft request without changing old settings or duplicating the draft', async () => {
    const owner=await seedUser(),key=newId(),body={name:'旧草稿请求',aiCollaborationEnabled:false};
    const first=await data(await request(owner.token,'/creation-drafts',body,key));
    const oldPayload=creationPayload.parse(body);
    await env.DB.prepare('UPDATE project_creation_drafts SET payload_json=?2 WHERE id=?1').bind(first.id,JSON.stringify(oldPayload)).run();
    const oldResult={...first,payload:oldPayload};
    await env.DB.prepare('UPDATE idempotency_records SET request_hash=?4,response_body=?5 WHERE idempotency_key=?1 AND user_id=?2 AND operation=?3').bind(key,owner.userId,'creation-draft.create',await sha256Hex(JSON.stringify(oldPayload)),JSON.stringify(oldResult)).run();
    const replay=await request(owner.token,'/creation-drafts',body,key);
    expect(replay.status).toBe(201);expect(await data(replay)).toEqual(oldResult);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM project_creation_drafts WHERE owner_id=?1').bind(owner.userId).first<{n:number}>())!.n).toBe(1);
    expect((await request(owner.token,'/creation-drafts',{...body,planningMode:'automatic'},key)).status).toBe(409);
  });
  it('replays old direct project request and preserves its completed result without duplicates', async () => {
    const owner=await seedUser(),key=newId(),body={name:'旧项目请求',aiCollaborationEnabled:false};
    const first=await data(await request(owner.token,'/projects',body,key));
    const canonical={name:body.name,description:'',deadlinePrecision:'unknown',aiCollaborationEnabled:false};
    await env.DB.prepare('UPDATE idempotency_records SET request_hash=?4 WHERE idempotency_key=?1 AND user_id=?2 AND operation=?3').bind(key,owner.userId,'projects.create',await sha256Hex(JSON.stringify(canonical))).run();
    const replay=await request(owner.token,'/projects',body,key);
    expect(replay.status).toBe(201);expect(await data(replay)).toEqual(first);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM projects WHERE created_by=?1').bind(owner.userId).first<{n:number}>())!.n).toBe(1);
    expect((await request(owner.token,'/projects',{...body,assignmentMode:'manual'},key)).status).toBe(409);
  });
  it('keeps new omitted-default requests distinct from explicit AI disablement', async () => {
    const owner=await seedUser();
    for(const path of ['/projects','/creation-drafts']) {
      const key=newId(),body={name:'新默认'};
      expect((await request(owner.token,path,body,key)).status).toBe(201);
      expect((await request(owner.token,path,{...body,aiCollaborationEnabled:false},key)).status).toBe(409);
    }
  });
});
