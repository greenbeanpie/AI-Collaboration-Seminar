import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { docToMarkdown, markdownToDoc } from '../src/services/tiptap';

async function createTask(cookie: string, pid: string, body: Record<string, unknown>): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/tasks`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: ((await res.json()) as { data: Record<string, unknown> }).data };
}

describe('任务与评论', () => {
  it('任务和评论游标分页不会跳过溢出行', async () => {
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const cookie = authCookie(owner.token);
    const taskIds: string[] = [];
    for (let index = 0; index < 5; index++) {
      const created = await createTask(cookie, pid, { title: `分页任务 ${index}` });
      expect(created.status).toBe(201);
      taskIds.push(String(created.data.taskId));
    }

    const taskAll = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/tasks?limit=100`, { headers: { cookie } });
    const allTaskIds = ((await taskAll.json()) as { data: { items: { taskId: string }[] } }).data.items.map((item) => item.taskId);
    const pagedTaskIds: string[] = [];
    let taskCursor: string | null = null;
    do {
      const url = new URL(`${BASE}/api/v1/projects/${pid}/tasks?limit=2`);
      if (taskCursor) url.searchParams.set('cursor', taskCursor);
      const page = await SELF.fetch(url, { headers: { cookie } });
      const pageData = (await page.json()) as { data: { items: { taskId: string }[]; nextCursor: string | null } };
      pagedTaskIds.push(...pageData.data.items.map((item) => item.taskId));
      taskCursor = pageData.data.nextCursor;
    } while (taskCursor);
    expect(pagedTaskIds).toEqual(allTaskIds);

    const commentTargetId = taskIds[0]!;
    for (let index = 0; index < 5; index++) {
      const response = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/comments`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ targetType: 'task', targetId: commentTargetId, body: `分页评论 ${index}` }),
      });
      expect(response.status).toBe(201);
    }
    const commentUrl = new URL(`${BASE}/api/v1/projects/${pid}/comments?targetType=task&targetId=${commentTargetId}&limit=100`);
    const commentAll = await SELF.fetch(commentUrl, { headers: { cookie } });
    const allCommentIds = ((await commentAll.json()) as { data: { items: { commentId: string }[] } }).data.items.map((item) => item.commentId);
    const pagedCommentIds: string[] = [];
    let commentCursor: string | null = null;
    do {
      const url = new URL(`${BASE}/api/v1/projects/${pid}/comments?targetType=task&targetId=${commentTargetId}&limit=2`);
      if (commentCursor) url.searchParams.set('cursor', commentCursor);
      const page = await SELF.fetch(url, { headers: { cookie } });
      const pageData = (await page.json()) as { data: { items: { commentId: string }[]; nextCursor: string | null } };
      pagedCommentIds.push(...pageData.data.items.map((item) => item.commentId));
      commentCursor = pageData.data.nextCursor;
    } while (commentCursor);
    expect(pagedCommentIds).toEqual(allCommentIds);
  });

  it('创建 → 列表 → 更新（乐观锁 + 状态事件）', async () => {
    const owner = await seedUser();
    const member = await seedUser();
    const pid = await seedProject(owner.userId);

    const created = await createTask(authCookie(owner.token), pid, {
      title: '撰写作品介绍', detail: '含教育痛点与创新点', dueDate: '2026-10-08',
    });
    expect(created.status).toBe(201);
    const task = created.data as unknown as {
      taskId: string; revision: number; status: string; title: string;
    };
    expect(task.status).toBe('todo');

    // 项目成员可以被指派；非本项目用户不会作为负责人写入。
    await env.DB.prepare(
      "INSERT INTO project_members (id, project_id, user_id, role, joined_at) VALUES (?1, ?2, ?3, 'member', '2026-09-29T00:00:00.000Z')",
    )
      .bind(crypto.randomUUID(), pid, member.userId)
      .run();
    const list = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/tasks`, { headers: { cookie: authCookie(member.token) } });
    const listBody = (await list.json()) as { data: { items: Array<{ taskId: string; title: string }> } };
    expect(listBody.data.items.some((t) => t.taskId === task.taskId)).toBe(true);

    // 错误 revision → 409
    const conflict = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/tasks/${task.taskId}`, {
      method: 'PATCH',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 5, status: 'doing' }),
    });
    expect(conflict.status).toBe(409);

    // 正确 revision → doing，且写入状态变更事件
    const ok = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/tasks/${task.taskId}`, {
      method: 'PATCH',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1, status: 'doing', assigneeId: member.userId }),
    });
    expect(ok.status).toBe(200);
    const updated = (await ok.json()) as { data: { revision: number; status: string; assigneeId: string } };
    expect(updated.data.status).toBe('doing');
    expect(updated.data.revision).toBe(2);
    const event = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE type = 'task.status_changed' AND entity_id = ?1",
    )
      .bind(task.taskId)
      .first<{ n: number }>();
    expect(event?.n).toBe(1);

    // 显式 null 表示清空日期和负责人。
    const clear = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/tasks/${task.taskId}`, {
      method: 'PATCH',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 2, assigneeId: null, dueDate: null }),
    });
    expect(clear.status).toBe(200);
    const cleared = (await clear.json() as { data: { revision: number; status: string; assigneeId: string | null; dueDate: string | null } }).data;
    expect(cleared).toMatchObject({ revision: 3, status: 'doing', assigneeId: null, dueDate: null });

    const outsider = await seedUser();
    const invalidAssignee = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/tasks/${task.taskId}`, {
      method: 'PATCH',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 3, assigneeId: outsider.userId }),
    });
    expect(invalidAssignee.status).toBe(400);
    expect((await invalidAssignee.json() as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
  });

  it('拒绝跨项目负责人或要求关联，失败时不写入或修改任务', async () => {
    const owner = await seedUser();
    const otherOwner = await seedUser();
    const otherMember = await seedUser();
    const projectId = await seedProject(owner.userId);
    const otherProjectId = await seedProject(otherOwner.userId);
    const cookie = authCookie(owner.token);
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO project_members (id, project_id, user_id, role, joined_at) VALUES (?1, ?2, ?3, 'member', ?4)",
    ).bind(crypto.randomUUID(), otherProjectId, otherMember.userId, now).run();

    const requirementSetId = crypto.randomUUID();
    const requirementId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO requirement_sets (id, project_id, status, revision, created_at, updated_at) VALUES (?1, ?2, 'draft', 1, ?3, ?3)")
        .bind(requirementSetId, otherProjectId, now),
      env.DB.prepare("INSERT INTO requirements (id, requirement_set_id, project_id, seq, category, title, updated_at) VALUES (?1, ?2, ?3, 1, 'other', '外项目要求', ?4)")
        .bind(requirementId, requirementSetId, otherProjectId, now),
    ]);

    const invalidAssigneeCreate = await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/tasks`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: '错误负责人', assigneeId: otherMember.userId }),
    });
    expect(invalidAssigneeCreate.status).toBe(400);
    const invalidRequirementCreate = await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/tasks`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: '错误要求', requirementId }),
    });
    expect(invalidRequirementCreate.status).toBe(400);
    const countBefore = await env.DB.prepare('SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?1')
      .bind(projectId).first<{ count: number }>();
    expect(countBefore?.count).toBe(0);

    const created = await createTask(cookie, projectId, { title: '保持原样' });
    const taskId = String(created.data.taskId);
    const patchBadAssignee = await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1, title: '不得写入', assigneeId: otherMember.userId }),
    });
    expect(patchBadAssignee.status).toBe(400);
    const patchBadRequirement = await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1, title: '同样不得写入', requirementId }),
    });
    expect(patchBadRequirement.status).toBe(400);
    const current = await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/tasks/${taskId}`, { headers: { cookie } });
    expect((await current.json() as { data: { title: string; assigneeId: string | null; requirementId: string | null; revision: number } }).data)
      .toMatchObject({ title: '保持原样', assigneeId: null, requirementId: null, revision: 1 });
  });

  it('评论：发表与按目标查询', async () => {
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const task = await createTask(authCookie(owner.token), pid, { title: '预审材料' });
    const taskId = (task.data as unknown as { taskId: string }).taskId;

    const post = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/comments`, {
      method: 'POST',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
      body: JSON.stringify({ targetType: 'task', targetId: taskId, body: '第一条评论' }),
    });
    expect(post.status).toBe(201);
    const list = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/comments?targetType=task&targetId=${taskId}`, {
      headers: { cookie: authCookie(owner.token) },
    });
    const listBody = (await list.json()) as { data: { items: Array<{ body: string; authorName: string }> } };
    expect(listBody.data.items).toHaveLength(1);
    expect(listBody.data.items[0]?.body).toBe('第一条评论');
  });
});

describe('材料与版本', () => {
  it('材料列表游标分页不会跳过溢出行', async () => {
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const cookie = authCookie(owner.token);
    for (let index = 0; index < 5; index++) {
      const response = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/materials`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ title: `分页材料 ${index}` }),
      });
      expect(response.status).toBe(201);
    }

    const all = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/materials?limit=100`, { headers: { cookie } });
    const allIds = ((await all.json()) as { data: { items: { materialId: string }[] } }).data.items.map((item) => item.materialId);
    const pagedIds: string[] = [];
    let cursor: string | null = null;
    do {
      const url = new URL(`${BASE}/api/v1/projects/${pid}/materials?limit=2`);
      if (cursor) url.searchParams.set('cursor', cursor);
      const page = await SELF.fetch(url, { headers: { cookie } });
      const pageData = (await page.json()) as { data: { items: { materialId: string }[]; nextCursor: string | null } };
      pagedIds.push(...pageData.data.items.map((item) => item.materialId));
      cursor = pageData.data.nextCursor;
    } while (cursor);

    expect(allIds).toHaveLength(5);
    expect(pagedIds).toEqual(allIds);
  });

  it('创建 → 保存（乐观锁）→ 版本历史 → 409 冲突', async () => {
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);

    const create = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/materials`, {
      method: 'POST',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
      body: JSON.stringify({ title: '作品介绍' }),
    });
    expect(create.status).toBe(201);
    const material = ((await create.json()) as { data: { materialId: string; revision: number } }).data;
    expect(material.revision).toBe(1);

    const doc = markdownToDoc('# 作品介绍\n\n本作品面向组队作业场景。\n\n- 创新点一\n- 创新点二');
    const save = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/materials/${material.materialId}`, {
      method: 'PUT',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1, doc }),
    });
    expect(save.status).toBe(201);
    const v2 = (await save.json()) as { data: { revision: number; markdown: string; origin: string } };
    expect(v2.data.revision).toBe(2);
    expect(v2.data.origin).toBe('manual');
    expect(v2.data.markdown).toContain('# 作品介绍');

    // 旧 revision 再保存 → 409 + 服务器当前版本
    const stale = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/materials/${material.materialId}`, {
      method: 'PUT',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1, doc }),
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { details?: { currentRevision?: number } } }).error.details?.currentRevision).toBe(2);

    const versions = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/materials/${material.materialId}/versions`, {
      headers: { cookie: authCookie(owner.token) },
    });
    const versionsBody = (await versions.json()) as { data: { items: Array<{ revision: number }> } };
    expect(versionsBody.data.items.map((v) => v.revision)).toEqual([2, 1]);
  });

  it('非法 doc 形状 → 400', async () => {
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const create = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/materials`, {
      method: 'POST',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'AI 使用声明' }),
    });
    const materialId = ((await create.json()) as { data: { materialId: string } }).data.materialId;
    const bad = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/materials/${materialId}`, {
      method: 'PUT',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1, doc: { type: 'not-doc' } }),
    });
    expect(bad.status).toBe(400);
  });
});

describe('Markdown ↔ Tiptap 转换（纯函数）', () => {
  it('往返转换保持结构', () => {
    const md = '# 标题一\n\n普通段落，含 **粗体** 与 *斜体*。\n\n- 项目甲\n- 项目乙\n\n1. 第一步\n2. 第二步\n\n> 引用说明';
    const doc = markdownToDoc(md);
    expect(doc.type).toBe('doc');
    const types = doc.content?.map((n) => n.type);
    expect(types).toEqual(['heading', 'paragraph', 'bulletList', 'orderedList', 'blockquote']);

    const back = docToMarkdown(doc);
    expect(back).toContain('# 标题一');
    expect(back).toContain('**粗体**');
    expect(back).toContain('- 项目甲');
    expect(back).toContain('1. 第一步');
    expect(back).toContain('> 引用说明');
  });

  it('空与非法输入不抛异常', () => {
    expect(markdownToDoc('').content).toEqual([]);
    expect(docToMarkdown(null)).toBe('');
    expect(docToMarkdown({ type: 'nope' })).toBe('');
  });
});
