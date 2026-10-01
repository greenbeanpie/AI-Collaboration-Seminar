import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { configureGoFixture } from './helpers/provider-config';
import { mockGatewayFetch } from './helpers/ai-mock';

afterEach(() => vi.unstubAllGlobals());
async function fixture(status:'waiting_input'|'running') {
  await configureGoFixture();
  const owner=await seedUser();const projectId=await seedProject(owner.userId);const cookie=authCookie(owner.token);
  const response=await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/sources`,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({kind:'paste',text:'比赛通知：提交截止 2026-10-08，队伍人数最多五人。'})});
  const ids=(await response.json() as {data:{sourceId:string;sourceVersionId:string}}).data;
  const jobId=crypto.randomUUID();const now=new Date().toISOString();
  await env.DB.prepare('INSERT INTO jobs(id,project_id,kind,status,input_json,attempts,created_by,created_at,updated_at) VALUES (?1,?2,\'parse_source\',?3,?4,0,?5,?6,?6)').bind(jobId,projectId,status,JSON.stringify({...ids,phase:'extract'}),owner.userId,now).run();
  return {...ids,projectId,cookie,jobId,path:`${BASE}/api/v1/projects/${projectId}/sources/${ids.sourceId}`};
}
describe('server-derived source recovery',()=>{
  it('exposes server waiting state and replaces only the selected version wait after explicit reread',async()=>{
    const f=await fixture('waiting_input');vi.stubGlobal('fetch',mockGatewayFetch());
    const version=await SELF.fetch(`${f.path}/versions/${f.sourceVersionId}`,{headers:{cookie:f.cookie}});
    expect((await version.json() as {data:{processingJob:{jobId:string;status:string}}}).data.processingJob).toMatchObject({jobId:f.jobId,status:'waiting_input'});
    const reread=await SELF.fetch(`${f.path}/parse`,{method:'POST',headers:{cookie:f.cookie,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify({sourceVersionId:f.sourceVersionId})});
    expect(reread.status).toBe(202);
    expect((await env.DB.prepare('SELECT status FROM jobs WHERE id=?1').bind(f.jobId).first<{status:string}>())?.status).toBe('cancelled');
  });
  it('rejects a duplicate parse while the same source version has a server-running job without paid requests',async()=>{
    const f=await fixture('running');const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    const reread=await SELF.fetch(`${f.path}/parse`,{method:'POST',headers:{cookie:f.cookie,'content-type':'application/json'},body:JSON.stringify({sourceVersionId:f.sourceVersionId})});
    expect(reread.status).toBe(409);expect(fetch).not.toHaveBeenCalled();
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs WHERE project_id=?1').bind(f.projectId).first<{n:number}>())?.n).toBe(1);
  });
});
