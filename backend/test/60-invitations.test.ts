import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';

interface InvitationData {
  data: { invitationId: string; code: string; expiresAt: string; maxUses: number | null };
}

async function createInvitation(token: string, pid: string, body: Record<string, unknown> = {}): Promise<Response> {
  return SELF.fetch(`${BASE}/api/v1/projects/${pid}/invitations`, {
    method: 'POST',
    headers: { cookie: authCookie(token), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function acceptInvitation(token: string, code: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/v1/invitations/accept`, {
    method: 'POST',
    headers: { cookie: authCookie(token), 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
}

describe('邀请生命周期', () => {
  it('创建 → 接受 → 重复接受拒绝', async () => {
    const owner = await seedUser();
    const invitee = await seedUser();
    const pid = await seedProject(owner.userId);

    const create = await createInvitation(owner.token, pid, { maxUses: 3 });
    expect(create.status).toBe(201);
    const inv = ((await create.json()) as InvitationData).data;
    expect(inv.code.length).toBeGreaterThanOrEqual(10);

    const accept = await acceptInvitation(invitee.token, inv.code);
    expect(accept.status).toBe(200);
    const accepted = (await accept.json()) as { data: { projectId: string; projectName: string } };
    expect(accepted.data.projectId).toBe(pid);

    // 已是成员再次接受 → 409
    const again = await acceptInvitation(invitee.token, inv.code);
    expect(again.status).toBe(409);

    // 成员在列表中
    const members = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/members`, {
      headers: { cookie: authCookie(owner.token) },
    });
    const membersBody = (await members.json()) as { data: { items: unknown[] } };
    expect(membersBody.data.items).toHaveLength(2);
  });

  it('成员不能创建邀请（owner only）', async () => {
    const owner = await seedUser();
    const member = await seedUser();
    const pid = await seedProject(owner.userId);
    await env.DB.prepare(
      "INSERT INTO project_members (id, project_id, user_id, role, joined_at) VALUES (?1, ?2, ?3, 'member', '2026-09-29T00:00:00.000Z')",
    )
      .bind(crypto.randomUUID(), pid, member.userId)
      .run();
    const res = await createInvitation(member.token, pid);
    expect(res.status).toBe(403);
  });

  it('maxUses 用尽后失效', async () => {
    const owner = await seedUser();
    const a = await seedUser();
    const b = await seedUser();
    const pid = await seedProject(owner.userId);
    const inv = ((await (await createInvitation(owner.token, pid, { maxUses: 1 })).json()) as InvitationData).data;
    expect((await acceptInvitation(a.token, inv.code)).status).toBe(200);
    const second = await acceptInvitation(b.token, inv.code);
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe('INVALID_STATE');
  });

  it('撤销后失效；过期后失效', async () => {
    const owner = await seedUser();
    const a = await seedUser();
    const b = await seedUser();
    const pid = await seedProject(owner.userId);

    // 撤销
    const inv1 = ((await (await createInvitation(owner.token, pid)).json()) as InvitationData).data;
    const revoke = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/invitations/${inv1.invitationId}`, {
      method: 'DELETE',
      headers: { cookie: authCookie(owner.token) },
    });
    expect(revoke.status).toBe(200);
    expect((await acceptInvitation(a.token, inv1.code)).status).toBe(409);

    // 过期
    const inv2 = ((await (await createInvitation(owner.token, pid)).json()) as InvitationData).data;
    await env.DB.prepare("UPDATE invitations SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?1")
      .bind(inv2.invitationId)
      .run();
    expect((await acceptInvitation(b.token, inv2.code)).status).toBe(409);

    void a;
    void b;
  });

  it('项目人数规则：达到 team_size_limit 后接受 → 429 QUOTA_EXCEEDED', async () => {
    const owner = await seedUser();
    const a = await seedUser();
    const b = await seedUser();
    const pid = await seedProject(owner.userId);
    await env.DB.prepare('UPDATE projects SET team_size_limit = 2 WHERE id = ?1').bind(pid).run();

    const inv = ((await (await createInvitation(owner.token, pid)).json()) as InvitationData).data;
    expect((await acceptInvitation(a.token, inv.code)).status).toBe(200);
    const full = await acceptInvitation(b.token, inv.code);
    expect(full.status).toBe(429);
    expect(((await full.json()) as { error: { code: string } }).error.code).toBe('QUOTA_EXCEEDED');
  });
});
