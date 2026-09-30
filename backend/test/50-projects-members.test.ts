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
  it('deadlineDate 可清除，项目分页不会遗漏当前页后的第一条记录', async () => {
    const owner = await seedUser();
    const cookie = authCookie(owner.token);
    const projectIds: string[] = [];
    for (let index = 0; index < 5; index++) {
      const { body } = await createProject(cookie, `分页项目 ${index}`);
      projectIds.push(body.data.id);
    }

    const setDeadline = await SELF.fetch(`${BASE}/api/v1/projects/${projectIds[0]}`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1, deadlineDate: '2026-10-08', deadlinePrecision: 'date' }),
    });
    expect(setDeadline.status).toBe(200);
    const clearDeadline = await SELF.fetch(`${BASE}/api/v1/projects/${projectIds[0]}`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 2, deadlineDate: null, deadlinePrecision: 'unknown' }),
    });
    expect(clearDeadline.status).toBe(200);
    expect(((await clearDeadline.json()) as ProjectData).data.deadlineDate).toBeNull();

    const all = await SELF.fetch(`${BASE}/api/v1/projects?status=all&limit=100`, { headers: { cookie } });
    const allIds = ((await all.json()) as { data: { items: { id: string }[] } }).data.items.map((item) => item.id);
    const pagedIds: string[] = [];
    let cursor: string | null = null;
    do {
      const url = new URL(`${BASE}/api/v1/projects?status=all&limit=2`);
      if (cursor) url.searchParams.set('cursor', cursor);
      const page = await SELF.fetch(url, { headers: { cookie } });
      const pageData = (await page.json()) as { data: { items: { id: string }[]; nextCursor: string | null } };
      pagedIds.push(...pageData.data.items.map((item) => item.id));
      cursor = pageData.data.nextCursor;
    } while (cursor);

    expect(allIds).toHaveLength(5);
    expect(pagedIds).toEqual(allIds);
  });

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
  it('成员与负责人维护自己的资料，互不覆盖且不影响其他项目', async () => {
    const owner = await seedUser();
    const member = await seedUser();
    const pid = await seedProject(owner.userId);
    const otherPid = await seedProject(member.userId);
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE project_members SET skills_json = ?2, hours_per_week = 10 WHERE project_id = ?1 AND user_id = ?3",
      ).bind(pid, JSON.stringify(['项目管理']), owner.userId),
      env.DB.prepare(
        "INSERT INTO project_members (id, project_id, user_id, role, skills_json, hours_per_week, joined_at) VALUES (?1, ?2, ?3, 'member', ?4, 5, '2026-09-29T00:00:00.000Z')",
      ).bind(crypto.randomUUID(), pid, member.userId, JSON.stringify(['设计'])),
      env.DB.prepare(
        "UPDATE project_members SET skills_json = ?2, hours_per_week = 12 WHERE project_id = ?1 AND user_id = ?3",
      ).bind(otherPid, JSON.stringify(['研究']), member.userId),
    ]);

    async function patchProfile(token: string, skills: string[], hoursPerWeek: number) {
      const response = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/members/me`, {
        method: 'PATCH',
        headers: { cookie: authCookie(token), 'content-type': 'application/json' },
        body: JSON.stringify({ skills, hoursPerWeek }),
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { data: { skills: string[]; hoursPerWeek: number } }).data)
        .toMatchObject({ skills, hoursPerWeek });
    }

    async function storedProfile(projectId: string, userId: string) {
      return env.DB.prepare(
        'SELECT skills_json, hours_per_week FROM project_members WHERE project_id = ?1 AND user_id = ?2',
      ).bind(projectId, userId).first<{ skills_json: string; hours_per_week: number | null }>();
    }

    await patchProfile(member.token, ['材料编辑', '演讲'], 3);
    expect(await storedProfile(pid, owner.userId))
      .toEqual({ skills_json: JSON.stringify(['项目管理']), hours_per_week: 10 });
    expect(await storedProfile(otherPid, member.userId))
      .toEqual({ skills_json: JSON.stringify(['研究']), hours_per_week: 12 });

    await patchProfile(owner.token, ['统筹'], 8);
    expect(await storedProfile(pid, member.userId))
      .toEqual({ skills_json: JSON.stringify(['材料编辑', '演讲']), hours_per_week: 3 });
  });

  it('投入时间省略时保留，显式 null 清空，零值与空技能列表可保存', async () => {
    const member = await seedUser();
    const pid = await seedProject(member.userId);
    await env.DB.prepare(
      'UPDATE project_members SET skills_json = ?2, hours_per_week = 6 WHERE project_id = ?1 AND user_id = ?3',
    ).bind(pid, JSON.stringify(['文档']), member.userId).run();

    async function patch(body: { skills?: string[]; hoursPerWeek?: number | null }) {
      const response = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/members/me`, {
        method: 'PATCH',
        headers: { cookie: authCookie(member.token), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { data: { skills: string[]; hoursPerWeek: number | null } }).data;
    }

    expect(await patch({ skills: ['前端'] })).toMatchObject({ skills: ['前端'], hoursPerWeek: 6 });
    expect(await patch({ hoursPerWeek: null })).toMatchObject({ skills: ['前端'], hoursPerWeek: null });
    expect(await patch({ hoursPerWeek: 0 })).toMatchObject({ skills: ['前端'], hoursPerWeek: 0 });
    expect(await patch({ skills: [] })).toMatchObject({ skills: [], hoursPerWeek: 0 });
    expect(await patch({})).toMatchObject({ skills: [], hoursPerWeek: 0 });
    expect(await env.DB.prepare(
      'SELECT skills_json, hours_per_week FROM project_members WHERE project_id = ?1 AND user_id = ?2',
    ).bind(pid, member.userId).first()).toEqual({ skills_json: '[]', hours_per_week: 0 });
  });

  it('非成员与匿名用户不能修改成员资料', async () => {
    const owner = await seedUser();
    const outsider = await seedUser();
    const pid = await seedProject(owner.userId);
    for (const [cookie, expectedStatus] of [[authCookie(outsider.token), 403], ['', 401]] as const) {
      const response = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/members/me`, {
        method: 'PATCH',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ skills: ['越权更新'], hoursPerWeek: 168 }),
      });
      expect(response.status).toBe(expectedStatus);
    }
    expect(await env.DB.prepare(
      'SELECT skills_json, hours_per_week FROM project_members WHERE project_id = ?1 AND user_id = ?2',
    ).bind(pid, owner.userId).first()).toEqual({ skills_json: '[]', hours_per_week: null });
  });

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
