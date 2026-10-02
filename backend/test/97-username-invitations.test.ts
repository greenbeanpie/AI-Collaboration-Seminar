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
