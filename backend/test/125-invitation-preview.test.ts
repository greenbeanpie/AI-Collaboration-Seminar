import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { env, BASE } from './helpers/env';
import { seedUser, seedProject, authCookie } from './helpers/seed';

const request = (token:string,path:string,body?:unknown) => SELF.fetch(`${BASE}/api/v1${path}`, {
  method:body ? 'POST':'GET',headers:{cookie:authCookie(token),'content-type':'application/json'},
  ...(body ? {body:JSON.stringify(body)} : {}),
});
const data = async (response:Response) => (await response.json() as {data:any}).data;
async function fixture() {
  const owner=await seedUser(),recipient=await seedUser(),stranger=await seedUser(),pid=await seedProject(owner.userId,'可核对的项目');
  await env.DB.batch([
    env.DB.prepare('UPDATE projects SET description=?2 WHERE id=?1').bind(pid,'项目介绍全文'),
    env.DB.prepare('INSERT INTO project_goals(project_id,title,detail,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)').bind(pid,'主目标','目标详细正文',new Date().toISOString()),
  ]);
  const username=await data(await request(owner.token,`/projects/${pid}/username-invitations`,{username:`fixture-${recipient.userId}`}));
  const code=await data(await request(owner.token,`/projects/${pid}/invitations`,{maxUses:1}));
  return {owner,recipient,stranger,pid,username,code};
}
describe('invitation project preview',()=>{
  it('returns only project description and goal, without membership or invitation writes',async()=>{
    const f=await fixture();
    const expected={projectId:f.pid,projectName:'可核对的项目',description:'项目介绍全文',goal:{title:'主目标',detail:'目标详细正文'}};
    expect(await data(await request(f.recipient.token,`/invitations/inbox/${f.username.id}/preview`))).toEqual(expected);
    expect(await data(await request(f.recipient.token,'/invitations/preview',{code:f.code.code}))).toEqual(expected);
    expect(await data(await request(f.recipient.token,'/invitations/preview',{code:f.code.code}))).toEqual(expected);
    expect(await env.DB.prepare('SELECT used_count FROM invitations WHERE id=?1').bind(f.code.invitationId).first()).toEqual({used_count:0});
    expect(await env.DB.prepare('SELECT status,handled_at FROM project_username_invitations WHERE id=?1').bind(f.username.id).first()).toEqual({status:'pending',handled_at:null});
    expect(await env.DB.prepare('SELECT 1 FROM project_members WHERE project_id=?1 AND user_id=?2').bind(f.pid,f.recipient.userId).first()).toBeNull();
    expect((await request(f.recipient.token,`/projects/${f.pid}/members`)).status).toBe(403);
    expect((await request(f.stranger.token,`/invitations/inbox/${f.username.id}/preview`)).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/api/v1/invitations/preview`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:f.code.code})})).status).toBe(401);
  });
  it.each(['revoked','expired','archived','full'] as const)('rechecks %s after preview for both acceptance paths',async state=>{
    const f=await fixture();
    expect((await request(f.recipient.token,`/invitations/inbox/${f.username.id}/preview`)).status).toBe(200);
    expect((await request(f.stranger.token,'/invitations/preview',{code:f.code.code})).status).toBe(200);
    if(state==='revoked') await env.DB.batch([
      env.DB.prepare("UPDATE project_username_invitations SET status='revoked' WHERE id=?1").bind(f.username.id),
      env.DB.prepare("UPDATE invitations SET revoked_at='2026-01-01' WHERE id=?1").bind(f.code.invitationId),
    ]);
    if(state==='expired') await env.DB.batch([
      env.DB.prepare("UPDATE project_username_invitations SET expires_at='2000-01-01' WHERE id=?1").bind(f.username.id),
      env.DB.prepare("UPDATE invitations SET expires_at='2000-01-01' WHERE id=?1").bind(f.code.invitationId),
    ]);
    if(state==='archived') await env.DB.prepare("UPDATE projects SET status='archived' WHERE id=?1").bind(f.pid).run();
    if(state==='full') await env.DB.prepare('UPDATE projects SET team_size_limit=1 WHERE id=?1').bind(f.pid).run();
    expect((await request(f.recipient.token,`/invitations/inbox/${f.username.id}/preview`)).status).toBeGreaterThanOrEqual(400);
    expect((await request(f.stranger.token,'/invitations/preview',{code:f.code.code})).status).toBeGreaterThanOrEqual(400);
    expect((await request(f.recipient.token,`/invitations/inbox/${f.username.id}`,{action:'accept'})).status).toBeGreaterThanOrEqual(400);
    expect((await request(f.stranger.token,'/invitations/accept',{code:f.code.code})).status).toBeGreaterThanOrEqual(400);
    expect(await env.DB.prepare('SELECT used_count FROM invitations WHERE id=?1').bind(f.code.invitationId).first()).toEqual({used_count:0});
  });
  it('reads current values, supports empty fields, and validates consumed codes',async()=>{
    const f=await fixture();
    await env.DB.batch([env.DB.prepare("UPDATE projects SET name='新名称',description='' WHERE id=?1").bind(f.pid),env.DB.prepare('DELETE FROM project_goals WHERE project_id=?1').bind(f.pid)]);
    expect(await data(await request(f.recipient.token,`/invitations/inbox/${f.username.id}/preview`))).toEqual({projectId:f.pid,projectName:'新名称',description:'',goal:{title:'',detail:''}});
    expect((await request(f.recipient.token,'/invitations/accept',{code:f.code.code})).status).toBe(200);
    expect((await request(f.stranger.token,'/invitations/preview',{code:f.code.code})).status).toBe(409);
  });
});
