import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';

interface ProjectData {
  data: {
    id: string;
    name: string;
    description: string;
    deadlineDate: string | null;
    status: string;
    revision: number;
    myRole: string;
  };
}

async function createProject(cookie: string, name: string): Promise<{ res: Response; body: ProjectData }> {
  const res = await SELF.fetch(`${BASE}/api/v1/projects`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name, description: '比赛项目' }),
  });
  const body = (await res.json()) as ProjectData;
  return { res, body };
}

describe('项目生命周期', () => {
  it('创建 → 列表 → 详情 → 更新（乐观锁）→ 归档', async () => {
    const owner = await seedUser();
    const { res, body } = await createProject(authCookie(owner.token), 'AI 教育赛项目');
    expect(res.status).toBe(201);
    expect(body.data.myRole).toBe('owner');
    expect(body.data.revision).toBe(1);
    // 团队人数上限取自比赛模板（种子 5），存为项目字段而非硬编码
    const limitRow = await env.DB.prepare('SELECT team_size_limit FROM projects WHERE id = ?1')
      .bind(body.data.id)
      .first<{ team_size_limit: number | null }>();
    expect(limitRow?.team_size_limit).toBe(5);
    const pid = body.data.id;

    const list = await SELF.fetch(`${BASE}/api/v1/projects`, { headers: { cookie: authCookie(owner.token) } });
    const listBody = (await list.json()) as { data: { items: ProjectData['data'][]; nextCursor: string | null } };
    expect(listBody.data.items.some((p) => p.id === pid)).toBe(true);

    const detail = await SELF.fetch(`${BASE}/api/v1/projects/${pid}`, { headers: { cookie: authCookie(owner.token) } });
    expect(detail.status).toBe(200);

    // 乐观锁：错误 expectedRevision → 409 + 服务器当前版本
    const conflict = await SELF.fetch(`${BASE}/api/v1/projects/${pid}`, {
      method: 'PATCH',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 99, name: '新名' }),
    });
    expect(conflict.status).toBe(409);
    const conflictBody = (await conflict.json()) as { error: { code: string; details?: { currentRevision?: number } } };
    expect(conflictBody.error.code).toBe('VERSION_CONFLICT');
    expect(conflictBody.error.details?.currentRevision).toBe(1);

    // 正确 revision 更新
    const ok = await SELF.fetch(`${BASE}/api/v1/projects/${pid}`, {
      method: 'PATCH',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1, name: '改名后的项目' }),
    });
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as ProjectData;
    expect(okBody.data.name).toBe('改名后的项目');
    expect(okBody.data.revision).toBe(2);

    // 归档后默认列表不显示，status=all 可见
    const archive = await SELF.fetch(`${BASE}/api/v1/projects/${pid}`, {
      method: 'PATCH',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 2, status: 'archived' }),
    });
    expect(archive.status).toBe(200);
    const listDefault = await SELF.fetch(`${BASE}/api/v1/projects`, { headers: { cookie: authCookie(owner.token) } });
    const listDefaultBody = (await listDefault.json()) as { data: { items: { id: string }[] } };
    expect(listDefaultBody.data.items.some((p) => p.id === pid)).toBe(false);
    const listAll = await SELF.fetch(`${BASE}/api/v1/projects?status=all`, { headers: { cookie: authCookie(owner.token) } });
    const listAllBody = (await listAll.json()) as { data: { items: { id: string }[] } };
    expect(listAllBody.data.items.some((p) => p.id === pid)).toBe(true);
  });

  it('非成员 403 / 项目不存在 404 / 未登录 401', async () => {
    const owner = await seedUser();
    const outsider = await seedUser();
    const { body } = await createProject(authCookie(owner.token), '私有项目');
    const pid = body.data.id;

    const foreigner = await SELF.fetch(`${BASE}/api/v1/projects/${pid}`, {
      headers: { cookie: authCookie(outsider.token) },
    });
    expect(foreigner.status).toBe(403);

    const missing = await SELF.fetch(`${BASE}/api/v1/projects/00000000-0000-4000-8000-000000000000`, {
      headers: { cookie: authCookie(owner.token) },
    });
    expect(missing.status).toBe(404);

    const anon = await SELF.fetch(`${BASE}/api/v1/projects`);
    expect(anon.status).toBe(401);

    void outsider;
  });
});

describe('成员与权限矩阵', () => {
  it('owner 更新成员信息、移除成员后立即失去访问权', async () => {
    const owner = await seedUser();
    const member = await seedUser();
    const pid = await seedProject(owner.userId);
    // 直接把成员加入项目
    await env.DB.prepare(
      "INSERT INTO project_members (id, project_id, user_id, role, joined_at) VALUES (?1, ?2, ?3, 'member', '2026-09-29T00:00:00.000Z')",
    )
      .bind(crypto.randomUUID(), pid, member.userId)
      .run();

    const list = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/members`, {
      headers: { cookie: authCookie(owner.token) },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { data: { items: { role: string; userId: string }[] } };
    expect(listBody.data.items).toHaveLength(2);

    // 成员维护技能与投入时间
    const patchMe = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/members/me`, {
      method: 'PATCH',
      headers: { cookie: authCookie(member.token), 'content-type': 'application/json' },
      body: JSON.stringify({ skills: ['前端', '文档'], hoursPerWeek: 6 }),
    });
    expect(patchMe.status).toBe(200);
    const meBody = (await patchMe.json()) as { data: { skills: string[]; hoursPerWeek: number } };
    expect(meBody.data.skills).toEqual(['前端', '文档']);
    expect(meBody.data.hoursPerWeek).toBe(6);

    // 成员不能 PATCH 项目（非 owner）
    const memberPatchProject = await SELF.fetch(`${BASE}/api/v1/projects/${pid}`, {
      method: 'PATCH',
      headers: { cookie: authCookie(member.token), 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1, name: '劫持' }),
    });
    expect(memberPatchProject.status).toBe(403);

    // owner 移除成员 → 成员立即失去访问权
    const remove = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/members/${member.userId}`, {
      method: 'DELETE',
      headers: { cookie: authCookie(owner.token) },
    });
    expect(remove.status).toBe(200);
    const after = await SELF.fetch(`${BASE}/api/v1/projects/${pid}`, {
      headers: { cookie: authCookie(member.token) },
    });
    expect(after.status).toBe(403);

    // owner 不可移除自己
    const removeSelf = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/members/${owner.userId}`, {
      method: 'DELETE',
      headers: { cookie: authCookie(owner.token) },
    });
    expect(removeSelf.status).toBe(409);

    // owner 不可退出
    const leave = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/members/me`, {
      method: 'DELETE',
      headers: { cookie: authCookie(owner.token) },
    });
    expect(leave.status).toBe(409);
  });

  it('普通成员可退出项目', async () => {
    const owner = await seedUser();
    const member = await seedUser();
    const pid = await seedProject(owner.userId);
    await env.DB.prepare(
      "INSERT INTO project_members (id, project_id, user_id, role, joined_at) VALUES (?1, ?2, ?3, 'member', '2026-09-29T00:00:00.000Z')",
    )
      .bind(crypto.randomUUID(), pid, member.userId)
      .run();
    const leave = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/members/me`, {
      method: 'DELETE',
      headers: { cookie: authCookie(member.token) },
    });
    expect(leave.status).toBe(200);
  });
});
