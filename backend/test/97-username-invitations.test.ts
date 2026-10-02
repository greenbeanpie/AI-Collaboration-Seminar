import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { env, BASE } from './helpers/env';
import { seedUser, seedProject, authCookie } from './helpers/seed';
import { newId } from '../src/core/db';
const req = (token: string, path: string, body?: unknown) => SELF.fetch(BASE + '/api/v1' + path, {
  method: body ? 'POST' : 'GET', headers: {
    cookie: authCookie(token), 'content-type': 'application/json', 'idempotency-key': newId()
  }, ...(body ? {
    body: JSON.stringify(body)
  } : {})
});
const data = async (r: Response) => (await r.json() as {
  data: any;
}).data;
const username = (id: string) => `fixture-${id}`;
describe('username invitations', () => {
  it('a one-person plan never becomes a capacity and more than five members can accept invitations', async () => {
    const owner = await seedUser();
    const recipients = [];
    for (let i=0;i<6;i++) recipients.push(await seedUser());
    const drafted = await data(await req(owner.token, '/creation-drafts', {name:'无人数上限项目',teamSize:1,inviteUsernames:recipients.slice(0,2).map(r=>username(r.userId))}));
    const ready = await data(await req(owner.token, `/creation-drafts/${drafted.id}/preview`, {expectedRevision:drafted.revision,mode:'manual',tasks:[]}));
    const created = await data(await req(owner.token, `/creation-drafts/${drafted.id}/commit`, {expectedRevision:ready.revision,confirmed:true}));
    expect(await env.DB.prepare('SELECT team_size_limit FROM projects WHERE id=?1').bind(created.projectId).first()).toEqual({team_size_limit:null});
    for (const recipient of recipients) {
      const response = await req(owner.token, `/projects/${created.projectId}/username-invitations`, {username:username(recipient.userId)});
      expect(response.status).toBe(201);
      const invite = await data(response);
      expect((await req(recipient.token, `/invitations/inbox/${invite.id}`, {action:'accept'})).status).toBe(200);
    }
    expect((await env.DB.prepare('SELECT COUNT(*) count FROM project_members WHERE project_id=?1').bind(created.projectId).first<{count:number}>())!.count).toBe(7);
    expect((await data(await req(owner.token, '/capabilities'))).competitionTemplate.teamSizeLimit).toBeNull();
  });
  it('reports one verified cause for an explicitly limited legacy project and an existing member', async () => {
    const owner=await seedUser(),recipient=await seedUser(),projectId=await seedProject(owner.userId);
    await env.DB.prepare('UPDATE projects SET team_size_limit=1 WHERE id=?1').bind(projectId).run();
    const full=await req(owner.token,`/projects/${projectId}/username-invitations`,{username:username(recipient.userId)});
    expect(full.status).toBe(409);
    const fullBody=await full.json() as {error:{code:string;message:string}};
    expect(fullBody.error).toMatchObject({code:'QUOTA_EXCEEDED',message:'项目人数已达到上限：1/1（含负责人）'});
    expect(fullBody.error.message).not.toContain('或');
    await env.DB.prepare('UPDATE projects SET team_size_limit=NULL WHERE id=?1').bind(projectId).run();
    const sent=await data(await req(owner.token,`/projects/${projectId}/username-invitations`,{username:username(recipient.userId)}));
    await req(recipient.token,`/invitations/inbox/${sent.id}`,{action:'accept'});
    const member=await req(owner.token,`/projects/${projectId}/username-invitations`,{username:username(recipient.userId)});
    expect(member.status).toBe(409);
    expect((await member.json() as {error:{message:string}}).error.message).toBe('对方已经是项目成员');
  });
  it('allows the same intent key after a confirmed no-write rejection without duplicating a successful invitation',async()=>{
    const owner=await seedUser(),recipient=await seedUser(),projectId=await seedProject(owner.userId),key=newId();
    const send=()=>SELF.fetch(`${BASE}/api/v1/projects/${projectId}/username-invitations`,{method:'POST',headers:{cookie:authCookie(owner.token),'content-type':'application/json','idempotency-key':key},body:JSON.stringify({username:username(recipient.userId)})});
    await env.DB.prepare('UPDATE projects SET team_size_limit=1 WHERE id=?1').bind(projectId).run();
    expect((await send()).status).toBe(409);
    expect(await env.DB.prepare('SELECT 1 FROM idempotency_records WHERE idempotency_key=?1').bind(key).first()).toBeNull();
    await env.DB.prepare('UPDATE projects SET team_size_limit=NULL WHERE id=?1').bind(projectId).run();
    const one=await send(),two=await send();expect(one.status).toBe(201);expect(two.status).toBe(201);
    expect((await data(one)).id).toBe((await data(two)).id);
    expect((await env.DB.prepare('SELECT COUNT(*) count FROM project_username_invitations WHERE project_id=?1').bind(projectId).first<{count:number}>())!.count).toBe(1);
  });
  it('exact login names create private inbox entries, accepting adds only a member once, and wrong recipients cannot act', async () => {
    const owner = await seedUser(), recipient = await seedUser(), stranger = await seedUser(), p = await seedProject(owner.userId);
    const path = `/projects/${p}/username-invitations`;
    expect((await req(owner.token, path, {
      username: '测试用户'
    })).status).toBe(400);
    expect((await req(owner.token, path, {
      username: username(owner.userId)
    })).status).toBe(400);
    expect((await req(stranger.token, path, {
      username: username(recipient.userId)
    })).status).toBe(403);
    const sent = await data(await req(owner.token, path, {
      username: username(recipient.userId)
    }));
    expect((await data(await req(owner.token, path, {
      username: username(recipient.userId)
    }))).id).toBe(sent.id);
    const inbox = await data(await req(recipient.token, '/invitations/inbox'));
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]).toMatchObject({
      projectName: '测试项目', role: 'member', status: 'pending'
    });
    expect(inbox.items[0]).not.toHaveProperty('description');
    const notifications = await data(await req(recipient.token, '/notifications'));
    expect(notifications.items.some((n: any) => n.kind === 'project_invitation')).toBe(true);
    expect((await req(recipient.token, `/projects/${p}/files/${newId()}/content`)).status).toBe(403);
    expect((await req(stranger.token, `/invitations/inbox/${sent.id}`, {
      action: 'accept'
    })).status).toBe(404);
    expect((await req(recipient.token, `/invitations/inbox/${sent.id}`, {
      action: 'accept'
    })).status).toBe(200);
    expect((await req(recipient.token, `/invitations/inbox/${sent.id}`, {
      action: 'accept'
    })).status).toBe(200);
    expect(await env.DB.prepare('SELECT role FROM project_members WHERE project_id=?1 AND user_id=?2').bind(p, recipient.userId).first()).toEqual({
      role: 'member'
    });
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM project_members WHERE project_id=?1').bind(p).first<{
      n: number;
    }>())?.n).toBe(2);
  });
  it('decline/revoke/expiry remain idempotent and never grant membership', async () => {
    const owner = await seedUser(), recipient = await seedUser(), p = await seedProject(owner.userId), path = `/projects/${p}/username-invitations`;
    const first = await data(await req(owner.token, path, {
      username: username(recipient.userId)
    }));
    expect((await req(recipient.token, `/invitations/inbox/${first.id}`, {
      action: 'decline'
    })).status).toBe(200);
    expect((await req(recipient.token, `/invitations/inbox/${first.id}`, {
      action: 'decline'
    })).status).toBe(200);
    expect((await req(recipient.token, `/invitations/inbox/${first.id}`, {
      action: 'accept'
    })).status).toBe(409);
    const second = await data(await req(owner.token, path, {
      username: username(recipient.userId)
    }));
    expect((await req(owner.token, path + `/${second.id}/revoke`, {})).status).toBe(200);
    expect((await req(owner.token, path + `/${second.id}/revoke`, {})).status).toBe(200);
    expect((await req(recipient.token, `/invitations/inbox/${second.id}`, {
      action: 'accept'
    })).status).toBe(409);
    const third = await data(await req(owner.token, path, {
      username: username(recipient.userId)
    }));
    await env.DB.prepare("UPDATE project_username_invitations SET expires_at='2000-01-01' WHERE id=?1").bind(third.id).run();
    expect((await req(recipient.token, `/invitations/inbox/${third.id}`, {
      action: 'accept'
    })).status).toBe(409);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM project_members WHERE project_id=?1').bind(p).first<{
      n: number;
    }>())?.n).toBe(1);
  });
  it('pending invites do not reserve membership slots and concurrent acceptance obeys project capacity', async () => {
    const owner = await seedUser(), a = await seedUser(), b = await seedUser(), p = await seedProject(owner.userId);
    await env.DB.prepare('UPDATE projects SET team_size_limit=2 WHERE id=?1').bind(p).run();
    const path = `/projects/${p}/username-invitations`, one = await data(await req(owner.token, path, {
      username: username(a.userId)
    })), two = await data(await req(owner.token, path, {
      username: username(b.userId)
    }));
    const responses = await Promise.all([req(a.token, `/invitations/inbox/${one.id}`, {
        action: 'accept'
      }), req(b.token, `/invitations/inbox/${two.id}`, {
        action: 'accept'
      })]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM project_members WHERE project_id=?1').bind(p).first<{
      n: number;
    }>())?.n).toBe(2);
  });
  it('username and legacy code acceptance share an atomic project capacity limit', async () => {
    const owner = await seedUser(), a = await seedUser(), b = await seedUser(), p = await seedProject(owner.userId);
    await env.DB.prepare('UPDATE projects SET team_size_limit=2 WHERE id=?1').bind(p).run();
    const one = await data(await req(owner.token, `/projects/${p}/username-invitations`, {
      username: username(a.userId)
    })), code = await data(await req(owner.token, `/projects/${p}/invitations`, {
      maxUses: 1
    }));
    const responses = await Promise.all([req(a.token, `/invitations/inbox/${one.id}`, {
        action: 'accept'
      }), req(b.token, '/invitations/accept', {
        code: code.code
      })]);
    expect(responses.filter(r => r.status === 200)).toHaveLength(1);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM project_members WHERE project_id=?1').bind(p).first<{
      n: number;
    }>())?.n).toBe(2);
  });
  it('draft invitations are dispatched only in the final successful transaction', async () => {
    const owner = await seedUser(), recipient = await seedUser();
    let draft = await data(await req(owner.token, '/creation-drafts', {
      name: '草稿邀请', teamSize: 2, inviteUsernames: [username(recipient.userId)]
    }));
    expect((await data(await req(recipient.token, '/invitations/inbox'))).items).toHaveLength(0);
    draft = await data(await req(owner.token, `/creation-drafts/${draft.id}/preview`, {
      expectedRevision: 1, mode: 'manual', tasks: []
    }));
    const commit = await req(owner.token, `/creation-drafts/${draft.id}/commit`, {
      expectedRevision: 1, confirmed: true
    });
    expect(commit.status).toBe(201);
    expect((await data(await req(recipient.token, '/invitations/inbox'))).items).toHaveLength(1);
    await req(owner.token, `/creation-drafts/${draft.id}/commit`, {
      expectedRevision: 1, confirmed: true
    });
    expect((await data(await req(recipient.token, '/invitations/inbox'))).items).toHaveLength(1);
  });
});
