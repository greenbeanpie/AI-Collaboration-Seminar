import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser, type SeededUser } from './helpers/seed';
import { newId, nowIso } from '../src/core/db';
import { managerPermissions, memberPermissions, projectPermissionSql, type ProjectPermissions } from '../src/services/project-permissions';
import { projectGoal, replaceTaskDependencies, saveStandard } from '../src/services/project-simplification';
import { createManualAssessment } from '../src/services/assessment-corrections';

const withPermissions = (overrides: Partial<ProjectPermissions>): ProjectPermissions => ({ ...memberPermissions, ...overrides });
const taskBody = { title: '权限矩阵任务', detail: '由任务管理权限创建', criteria: '可验收', effortHours: 1 };

async function addMember(projectId: string, userId: string, role: 'owner' | 'member' = 'member') {
  await env.DB.prepare('INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES(?1,?2,?3,?4,?5)')
    .bind(newId(), projectId, userId, role, nowIso()).run();
}
async function setAccountRole(userId: string, role: 'admin' | 'super_admin') {
  await env.DB.prepare("UPDATE auth_accounts SET account_role=?2,is_admin=1 WHERE user_id=?1").bind(userId, role).run();
}

async function fixture() {
  const owner = await seedUser(), member = await seedUser(), other = await seedUser();
  const projectId = await seedProject(owner.userId);
  await addMember(projectId, member.userId);
  await addMember(projectId, other.userId);
  const call = (project: string, token: string, path: string, method = 'GET', body?: unknown) =>
    SELF.fetch(`${BASE}/api/v1/projects/${project}${path}`, { method, headers: { cookie: authCookie(token), 'content-type': 'application/json', 'idempotency-key': newId() }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const req = (token: string, path: string, method = 'GET', body?: unknown) => call(projectId, token, path, method, body);
  const revision = async (userId: string) => (await env.DB.prepare('SELECT permissions_revision r FROM project_members WHERE project_id=?1 AND user_id=?2').bind(projectId, userId).first<{ r: number }>())!.r;
  const setPermissions = async (userId: string, permissions: ProjectPermissions, token = owner.token) =>
    req(token, `/members/${userId}/permissions`, 'PATCH', { expectedRevision: await revision(userId), permissions });
  const grant = async (userId: string, permissions: ProjectPermissions) => {
    const response = await setPermissions(userId, permissions);
    expect(response.status).toBe(200);
  };
  const createMaterial = async (token: string) => {
    const response = await req(token, '/materials', 'POST', { title: '协作资料' });
    expect(response.status).toBe(201);
    return (await response.json() as { data: { materialId: string; revision: number } }).data;
  };
  const saveMaterial = (token: string, materialId: string, expectedRevision: number) =>
    req(token, `/materials/${materialId}`, 'PUT', { expectedRevision, doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '资料管理更新' }] }] }, markdown: '资料管理更新' });
  const createSource = async (token: string) => {
    const response = await req(token, '/sources', 'POST', { kind: 'paste', title: '协作来源', text: '来源正文' });
    expect(response.status).toBe(201);
    return (await response.json() as { data: { sourceId: string } }).data.sourceId;
  };
  return { owner, member, other, projectId, call, req, revision, setPermissions, grant, createMaterial, saveMaterial, createSource };
}

describe('project permission matrix', () => {
  it('A. ordinary members cannot escalate permissions, invite, remove members, manage tasks, edit others resources or correct scores', async () => {
    const f = await fixture();
    expect((await f.setPermissions(f.member.userId, managerPermissions, f.member.token)).status).toBe(403);
    expect((await f.setPermissions(f.other.userId, managerPermissions, f.member.token)).status).toBe(403);
    expect((await f.req(f.member.token, '/invitations', 'POST', {})).status).toBe(403);
    expect((await f.req(f.member.token, `/members/${f.other.userId}`, 'DELETE')).status).toBe(403);
    expect((await f.req(f.member.token, '/collaboration/tasks', 'POST', taskBody)).status).toBe(403);
    const material = await f.createMaterial(f.other.token);
    expect((await f.saveMaterial(f.member.token, material.materialId, material.revision)).status).toBe(403);
    expect((await f.req(f.member.token, `/assessments/${newId()}/scores`, 'PATCH', { expectedRevision: 1, scores: [{ key: 'quality', score: 60 }], reason: '越权修正' })).status).toBe(403);
    // 未授权的写入不得落库。
    expect(JSON.parse((await env.DB.prepare("SELECT permissions_json FROM project_members WHERE project_id=?1 AND user_id=?2").bind(f.projectId, f.other.userId).first<{ permissions_json: string }>())!.permissions_json).teamManage).not.toBe(true);
  });

  it('B. teamManage members invite, revoke, approve requests and remove members but still cannot change permissions', async () => {
    const f = await fixture(), outsider = await seedUser();
    await f.grant(f.member.userId, withPermissions({ teamManage: true }));
    const invitation = await f.req(f.member.token, '/invitations', 'POST', {});
    expect(invitation.status).toBe(201);
    const invitationId = (await invitation.json() as { data: { invitationId: string } }).data.invitationId;
    expect((await f.req(f.member.token, `/invitations/${invitationId}`, 'DELETE')).status).toBe(200);
    expect((await f.req(f.member.token, '/username-invitations', 'POST', { username: `fixture-${outsider.userId}` })).status).toBe(201);
    // 普通成员提交申请，具备 teamManage 的成员审批。
    const request = await f.req(f.other.token, '/invitation-requests', 'POST', { username: `fixture-${outsider.userId}` });
    expect(request.status).toBe(201);
    const requestId = (await request.json() as { data: { id: string; revision: number } }).data;
    expect((await f.req(f.member.token, `/invitation-requests/${requestId.id}/decide`, 'POST', { expectedRevision: requestId.revision, action: 'approve' })).status).toBe(200);
    expect((await f.req(f.member.token, `/members/${f.other.userId}`, 'DELETE')).status).toBe(200);
    expect(await env.DB.prepare('SELECT 1 FROM project_members WHERE project_id=?1 AND user_id=?2').bind(f.projectId, f.other.userId).first()).toBeNull();
    expect((await f.setPermissions(f.owner.userId, memberPermissions, f.member.token)).status).toBe(403);
    expect((await f.req(f.member.token, `/members/${f.owner.userId}`, 'DELETE')).status).toBe(403);
  });

  it('C. taskManage members create, edit and reassign tasks without team or resource powers', async () => {
    const f = await fixture();
    await f.grant(f.member.userId, withPermissions({ taskManage: true }));
    const created = await f.req(f.member.token, '/collaboration/tasks', 'POST', taskBody);
    expect(created.status).toBe(201);
    const task = (await created.json() as { data: { taskId: string; revision: number } }).data;
    expect((await f.req(f.member.token, `/collaboration/tasks/${task.taskId}`, 'PATCH', { expectedRevision: task.revision, title: '已修改' })).status).toBe(200);
    expect((await f.req(f.member.token, `/collaboration/tasks/${task.taskId}/assign`, 'POST', { expectedRevision: task.revision + 1, assigneeId: f.other.userId, reason: '重新分配' })).status).toBe(200);
    expect((await f.req(f.member.token, '/invitations', 'POST', {})).status).toBe(403);
    const material = await f.createMaterial(f.other.token);
    expect((await f.saveMaterial(f.member.token, material.materialId, material.revision)).status).toBe(403);
  });

  it('D. resourceManage members edit and delete other members resources without task powers', async () => {
    const f = await fixture();
    await f.grant(f.member.userId, withPermissions({ resourceManage: true }));
    const material = await f.createMaterial(f.other.token);
    expect((await f.saveMaterial(f.member.token, material.materialId, material.revision)).status).toBe(201);
    const sourceId = await f.createSource(f.other.token);
    expect((await f.req(f.member.token, `/sources/${sourceId}`, 'DELETE', { expectedLifecycleVersion: 1 })).status).toBe(200);
    expect((await f.req(f.member.token, '/collaboration/tasks', 'POST', taskBody)).status).toBe(403);
    // 普通成员仍可管理自己创建的资源。
    const own = await f.createMaterial(f.member.token);
    expect((await f.saveMaterial(f.member.token, own.materialId, own.revision)).status).toBe(201);
  });

  it('E. scoreCorrect members correct existing scores while scoreInitiate alone cannot', async () => {
    const f = await fixture();
    const standard = await saveStandard(env, f.projectId, f.owner.userId, { title: '项目标准', requirements: [{ title: '包含案例', detail: '案例有结果', category: 'deliverable' }], weights: [{ key: 'quality', label: '质量', weight: 3 }, { key: 'coverage', label: '覆盖', weight: 1 }] });
    const assessment = await createManualAssessment(env, f.projectId, f.owner.userId, { standardsVersionId: standard.standardsVersionId, scores: [{ key: 'quality', score: 80 }, { key: 'coverage', score: 40 }], reason: '初始人工评分' });
    const body = { expectedRevision: 1, scores: [{ key: 'quality', score: 90 }], reason: '复核修正' };
    expect((await f.req(f.member.token, `/assessments/${assessment.assessmentId}/scores`, 'PATCH', body)).status).toBe(403);
    await f.grant(f.member.userId, withPermissions({ scoreCorrect: true }));
    const corrected = await f.req(f.member.token, `/assessments/${assessment.assessmentId}/scores`, 'PATCH', body);
    expect(corrected.status).toBe(200);
    expect((await corrected.json() as { data: { revision: number } }).data.revision).toBe(2);
    // 默认 scoreInitiate 不受影响：普通成员仍可发起评分。
    expect(memberPermissions.scoreInitiate).toBe(true);
  });

  it('F. owner grants member permissions but cannot downgrade the owner or remove an owner', async () => {
    const f = await fixture(), secondOwner = await seedUser();
    await addMember(f.projectId, secondOwner.userId, 'owner');
    expect((await f.setPermissions(f.member.userId, managerPermissions)).status).toBe(200);
    expect((await f.revision(f.member.userId))).toBe(2);
    expect((await f.setPermissions(f.owner.userId, memberPermissions)).status).toBe(403);
    expect((await f.req(f.owner.token, `/members/${secondOwner.userId}`, 'DELETE')).status).toBe(403);
    expect((await f.req(f.owner.token, `/members/${f.owner.userId}`, 'DELETE')).status).toBe(409);
    expect(await env.DB.prepare('SELECT 1 FROM project_members WHERE project_id=?1 AND user_id=?2').bind(f.projectId, secondOwner.userId).first()).not.toBeNull();
  });

  it('G. platform admins get full project permissions only while they belong to the project', async () => {
    const f = await fixture(), admin = await seedUser(), superAdmin = await seedUser(), external = await seedUser();
    await addMember(f.projectId, admin.userId);
    await addMember(f.projectId, superAdmin.userId);
    await setAccountRole(admin.userId, 'admin');
    await setAccountRole(superAdmin.userId, 'super_admin');
    await setAccountRole(external.userId, 'admin');
    expect((await f.req(admin.token, '/invitations', 'POST', {})).status).toBe(201);
    expect((await f.req(admin.token, '/collaboration/tasks', 'POST', taskBody)).status).toBe(201);
    expect((await f.setPermissions(f.member.userId, managerPermissions, admin.token)).status).toBe(200);
    expect((await f.setPermissions(f.other.userId, managerPermissions, superAdmin.token)).status).toBe(200);
    // 平台管理员身份不能替代项目成员资格。
    expect((await f.req(external.token, '/members')).status).toBe(403);
    expect((await f.setPermissions(f.member.userId, memberPermissions, external.token)).status).toBe(403);
    // 平台管理员的项目权限由平台身份决定，不能通过接口降级。
    expect((await f.setPermissions(admin.userId, memberPermissions)).status).toBe(403);
  });

  it('H. project isolation: an owner of project A cannot change project B members', async () => {
    const f = await fixture(), otherOwner = await seedUser(), target = await seedUser();
    const projectB = await seedProject(otherOwner.userId);
    await addMember(projectB, target.userId);
    expect((await f.call(projectB, f.owner.token, `/members/${target.userId}/permissions`, 'PATCH', { expectedRevision: 1, permissions: managerPermissions })).status).toBe(403);
    expect((await f.call(projectB, f.owner.token, '/members')).status).toBe(403);
    expect(JSON.parse((await env.DB.prepare('SELECT permissions_json FROM project_members WHERE project_id=?1 AND user_id=?2').bind(projectB, target.userId).first<{ permissions_json: string }>())!.permissions_json).teamManage).not.toBe(true);
  });

  it('I. optimistic concurrency returns 409 when another administrator already saved a newer revision', async () => {
    const f = await fixture();
    await env.DB.prepare('UPDATE project_members SET permissions_revision=4 WHERE project_id=?1 AND user_id=?2').bind(f.projectId, f.member.userId).run();
    expect((await f.req(f.owner.token, `/members/${f.member.userId}/permissions`, 'PATCH', { expectedRevision: 4, permissions: managerPermissions })).status).toBe(200);
    const stale = await f.req(f.owner.token, `/members/${f.member.userId}/permissions`, 'PATCH', { expectedRevision: 4, permissions: memberPermissions });
    expect(stale.status).toBe(409);
    expect((await stale.json() as { error: { code: string; details?: { currentRevision?: number } } }).error).toMatchObject({ code: 'VERSION_CONFLICT', details: { currentRevision: 5 } });
    expect((await env.DB.prepare('SELECT permissions_json FROM project_members WHERE project_id=?1 AND user_id=?2').bind(f.projectId, f.member.userId).first<{ permissions_json: string }>())!.permissions_json).toContain('teamManage');
  });

  it('J. revoking taskManage during a request blocks the final database write', async () => {
    const f = await fixture();
    await f.grant(f.member.userId, withPermissions({ taskManage: true }));
    const taskId = newId(), now = nowIso();
    await env.DB.prepare("INSERT INTO tasks(id,project_id,title,status,lifecycle_state,criteria,created_by,created_at,updated_at) VALUES(?1,?2,'并发写入','todo','open','可验收',?3,?4,?4)").bind(taskId, f.projectId, f.owner.userId, now).run();
    // 请求开始：中间件与事务前检查都通过。
    await replaceTaskDependencies(env, f.projectId, f.member.userId, taskId, (await projectGoal(env, f.projectId)).graphRevision, []);
    // 同一事务内先撤销权限，再执行写入路径使用的 projectPermissionSql 守卫。
    const guarded = await env.DB.batch([
      env.DB.prepare('UPDATE project_members SET permissions_json=?3,permissions_revision=permissions_revision+1 WHERE project_id=?1 AND user_id=?2').bind(f.projectId, f.member.userId, JSON.stringify(memberPermissions)),
      env.DB.prepare(`UPDATE tasks SET title='被撤销后写入' WHERE id=?1 AND project_id=?2 AND ${projectPermissionSql('?2','?3','taskManage')}`).bind(taskId, f.projectId, f.member.userId),
    ]);
    expect(guarded[1]!.meta.changes).toBe(0);
    expect((await env.DB.prepare('SELECT title FROM tasks WHERE id=?1').bind(taskId).first<{ title: string }>())!.title).toBe('并发写入');
    // 真实写入路径在权限撤销后同样拒绝。
    await expect(replaceTaskDependencies(env, f.projectId, f.member.userId, taskId, (await projectGoal(env, f.projectId)).graphRevision, [])).rejects.toThrow('权限');
  });

  it('records a complete audit event and notifies the member whose permissions changed', async () => {
    const f = await fixture();
    await f.grant(f.member.userId, withPermissions({ teamManage: true, taskManage: true }));
    const event = await env.DB.prepare("SELECT project_id,actor_id,entity_id,occurred_at,payload_json FROM events WHERE project_id=?1 AND type='member.permissions_changed'").bind(f.projectId).first<{ project_id: string; actor_id: string; entity_id: string; occurred_at: string; payload_json: string }>();
    expect(event).toMatchObject({ project_id: f.projectId, actor_id: f.owner.userId, entity_id: f.member.userId });
    expect(event!.occurred_at).toBeTruthy();
    expect(JSON.parse(event!.payload_json)).toEqual({ previous: memberPermissions, permissions: withPermissions({ teamManage: true, taskManage: true }), revision: 2 });
    const notice = await env.DB.prepare("SELECT e.title,e.body,e.url FROM notification_events e JOIN notification_inbox i ON i.event_id=e.id WHERE e.resource_id=?1 AND e.kind='member_permissions_updated' AND i.user_id=?2").bind(f.projectId, f.member.userId).first<{ title: string; body: string; url: string }>();
    expect(notice).toMatchObject({ title: '你的项目权限已更新', url: `/app/projects/${f.projectId}/team` });
    expect(notice!.body).toContain('团队管理');
    // 只有被调整的成员收到通知。
    expect(await env.DB.prepare("SELECT 1 FROM notification_inbox i JOIN notification_events e ON e.id=i.event_id WHERE e.kind='member_permissions_updated' AND i.user_id=?1").bind(f.owner.userId).first()).toBeNull();
  });
});
