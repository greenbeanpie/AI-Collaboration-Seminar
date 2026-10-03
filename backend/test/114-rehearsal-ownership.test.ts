import { saveStandard } from '../src/services/project-simplification';
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { configureGoFixture } from './helpers/provider-config';
import { newId, nowIso } from '../src/core/db';

await configureGoFixture();

async function fixture() {
  const owner=await seedUser(), peer=await seedUser(), projectId=await seedProject(owner.userId), id=newId(), jobId=newId(), now=nowIso();
  const standard=await saveStandard(env,projectId,owner.userId,{requirements:[{title:'交付',detail:'交付完整成果'}],weights:[{key:'quality',label:'质量',weight:100}]});
  await env.DB.batch([
    env.DB.prepare("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES(?1,?2,?3,'member',?4)").bind(newId(),projectId,peer.userId,now),
    env.DB.prepare("INSERT INTO rehearsals(id,project_id,scope,material_version_ids_json,status,created_by,created_at,processing_job_id) VALUES(?1,?2,'all','[]','active',?3,?4,?5)").bind(id,projectId,owner.userId,now,jobId),
    env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,attempts,created_by,created_at,updated_at) VALUES(?1,?2,'rehearsal_turn','failed',?3,1,?4,?5,?5)").bind(jobId,projectId,JSON.stringify({rehearsalId:id,projectId,phase:'question'}),owner.userId,now),
  ]);
  await env.DB.prepare('UPDATE rehearsals SET reference_inputs_json=?2 WHERE id=?1').bind(id,JSON.stringify({standardsVersionId:standard.standardsVersionId})).run();
  return {owner,peer,projectId,id,jobId};
}

describe('shared rehearsals with exclusive respondent',()=>{
  it('preserves historical reads while rejecting continuation and retry after a newer standard is saved',async()=>{
    const f=await fixture(),cookie=authCookie(f.owner.token);
    await saveStandard(env,f.projectId,f.owner.userId,{requirements:[],weights:[{key:'replacement',label:'新标准',weight:100}]});
    const read=await SELF.fetch(`${BASE}/api/v1/projects/${f.projectId}/rehearsals/${f.id}`,{headers:{cookie}});expect(read.status).toBe(200);await read.text();
    for(const suffix of ['/answers','/finish']){
      const response=await SELF.fetch(`${BASE}/api/v1/projects/${f.projectId}/rehearsals/${f.id}${suffix}`,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({content:'回答'})});expect(response.status).toBe(409);await response.text();
    }
    const retry=await SELF.fetch(`${BASE}/api/v1/jobs/${f.jobId}/retry`,{method:'POST',headers:{cookie}});expect(retry.status).toBe(409);await retry.text();
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM rehearsal_turns WHERE rehearsal_id=?1').bind(f.id).first<{n:number}>())!.n).toBe(0);
  });

  it('all members read owner metadata and processing state, while spectators cannot answer, finish or retry',async()=>{
    const f=await fixture(), cookie=authCookie(f.peer.token), path=`${BASE}/api/v1/projects/${f.projectId}/rehearsals/${f.id}`;
    const read=await SELF.fetch(path,{headers:{cookie}});
    expect(read.status).toBe(200);
    expect((await read.json() as {data:Record<string,unknown>}).data).toMatchObject({initiatorId:f.owner.userId,respondentId:f.owner.userId,canOperate:false,processingJobId:f.jobId,processingStatus:'failed'});
    for(const suffix of ['/answers','/finish']) {
      const response=await SELF.fetch(path+suffix,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({content:'旁观者'})});
      expect(response.status).toBe(403);await response.text();
    }
    const retry=await SELF.fetch(`${BASE}/api/v1/jobs/${f.jobId}/retry`,{method:'POST',headers:{cookie}});
    expect(retry.status).toBe(403);await retry.text();
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM rehearsal_turns WHERE rehearsal_id=?1').bind(f.id).first<{n:number}>())?.n).toBe(0);
  });
  it('accepts only one concurrent answer for the current question',async()=>{
    const f=await fixture(), now=nowIso();
    await env.DB.batch([
      env.DB.prepare('UPDATE rehearsals SET processing_job_id=NULL WHERE id=?1').bind(f.id),
      env.DB.prepare("INSERT INTO rehearsal_turns(id,rehearsal_id,project_id,sequence,kind,content_json,created_at) VALUES(?1,?2,?3,1,'question',?5,?4)").bind(newId(),f.id,f.projectId,now,JSON.stringify({content:"问题"}))
    ]);
    const responses=await Promise.all([1,2].map(n=>SELF.fetch(`${BASE}/api/v1/projects/${f.projectId}/rehearsals/${f.id}/answers`,{method:'POST',headers:{cookie:authCookie(f.owner.token),'content-type':'application/json'},body:JSON.stringify({content:`回答${n}`})})));
    expect(responses.map(r=>r.status).sort()).toEqual([202,409]);
    await Promise.all(responses.map(r=>r.text()));
    const turns=await env.DB.prepare("SELECT author_id FROM rehearsal_turns WHERE rehearsal_id=?1 AND kind='answer'").bind(f.id).all<{author_id:string}>();
    expect(turns.results).toEqual([{author_id:f.owner.userId}]);
  });
  it('owner cannot submit or finish while question processing is unresolved',async()=>{
    const f=await fixture(), cookie=authCookie(f.owner.token);
    for(const suffix of ['/answers','/finish']) {
      const response=await SELF.fetch(`${BASE}/api/v1/projects/${f.projectId}/rehearsals/${f.id}${suffix}`,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({content:'提前提交'})});
      expect(response.status).toBe(409);await response.text();
    }
  });
});
