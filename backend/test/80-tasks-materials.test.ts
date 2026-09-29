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
  it('创建 → 列表 → 更新（乐观锁 + 状态事件）', async () => {
    const owner = await seedUser();
    const member = await seedUser();
    const pid = await seedProject(owner.userId);

    const created = await createTask(authCookie(owner.token), pid, { title: '撰写作品介绍', detail: '含教育痛点与创新点' });
    expect(created.status).toBe(201);
    const task = created.data as unknown as {
      taskId: string; revision: number; status: string; title: string;
    };
    expect(task.status).toBe('todo');

    // 指派成员（成员必须在项目中才能被指派？v1 不做成员校验，仅存 ID——先加入成员再指派）
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
