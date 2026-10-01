import { profileStamp } from '../src/services/personal-profiles';
import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { newId, nowIso } from '../src/core/db';
import { applyProposal } from '../src/services/collaboration';
async function fixture() { const o = await seedUser(); const m = await seedUser(); const p = await seedProject(o.userId); await env.DB.prepare("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES(?1,?2,?3,'member',?4)").bind(newId(), p, m.userId, nowIso()).run(); const req = async (path: string, method = 'GET', body?: unknown, member = false) => { const r = await SELF.fetch(`${BASE}/api/v1/projects/${p}${path}`, { method, headers: { cookie: authCookie((member ? m : o).token), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, json: await r.json() as any }; }; return { o, m, p, req }; }
describe('collaboration lifecycle', () => {
    it('manual defaults, independent settings, owner-only mode and stale revisions', async () => { const { req } = await fixture(); expect((await req('/collaboration/settings')).json.data).toEqual({ aiCollaborationEnabled: false, assignmentMode: 'manual', evaluationMode: 'manual', revision: 1 }); expect((await req('/collaboration/settings', 'PATCH', { expectedRevision: 1, assignmentMode: 'automatic' }, true)).status).toBe(403); const r = await req('/collaboration/settings', 'PATCH', { expectedRevision: 1, assignmentMode: 'automatic' }); expect(r.status).toBe(200); expect(r.json.data).toEqual({ aiCollaborationEnabled: false, assignmentMode: 'automatic', evaluationMode: 'manual', revision: 2 }); expect((await req('/collaboration/settings', 'PATCH', { expectedRevision: 1, evaluationMode: 'automatic' })).status).toBe(409); });
    it('atomic selfclaim and submission→rework→resubmit→accept with bypass prevention', async () => {
        const { req, m } = await fixture();
        const t = (await req('/collaboration/tasks', 'POST', { title: '作品', criteria: '提供可核对成果' })).json.data;
        expect(t.lifecycleState).toBe('open');
        const claimed = await req(`/collaboration/tasks/${t.taskId}/claim`, 'POST', { expectedRevision: 1 }, true);
        expect(claimed.status).toBe(200);
        expect(claimed.json.data.assigneeId).toBe(m.userId);
        expect((await req(`/collaboration/tasks/${t.taskId}/claim`, 'POST', { expectedRevision: 1 })).status).toBe(409);
        expect((await req(`/tasks/${t.taskId}`, 'PATCH', { expectedRevision: 2, status: 'done' }, true)).status).toBe(409);
        expect((await req('/tasks/apply-assignment', 'POST', { taskId: t.taskId, assigneeId: m.userId, expectedRevision: 2 })).status).toBe(409);
        const s = await req(`/collaboration/tasks/${t.taskId}/submissions`, 'POST', { expectedRevision: 2, body: '第一稿', materialVersionIds: [] }, true);
        expect(s.status).toBe(201);
        expect((await req(`/collaboration/submissions/${s.json.data.submissionId}/decide`, 'POST', { expectedRevision: 1, decision: 'accept', feedback: '自验收' }, true)).status).toBe(403);
        expect((await req(`/collaboration/submissions/${s.json.data.submissionId}/decide`, 'POST', { expectedRevision: 1, decision: 'rework', feedback: '补充证据' })).status).toBe(200);
        const second = await req(`/collaboration/tasks/${t.taskId}/submissions`, 'POST', { expectedRevision: 4, body: '第二稿', materialVersionIds: [] }, true);
        expect(second.status).toBe(201);
        expect(second.json.data.round).toBe(2);
        expect((await req(`/collaboration/submissions/${s.json.data.submissionId}/decide`, 'POST', { expectedRevision: 2, decision: 'accept', feedback: '旧结果' })).status).toBe(409);
        expect((await req(`/collaboration/submissions/${second.json.data.submissionId}/decide`, 'POST', { expectedRevision: 1, decision: 'accept', feedback: '已复核' })).status).toBe(200);
        const all = await req('/collaboration/tasks');
        expect(all.json.data.items[0].status).toBe('done');
        expect((await req(`/collaboration/tasks/${t.taskId}/submissions`)).json.data.items).toHaveLength(2);
    });
    it('rejects cross-project material versions and parent tasks', async () => { const { req } = await fixture(); expect((await req('/collaboration/tasks', 'POST', { title: 'bad', criteria: 'x', parentTaskId: newId() })).status).toBe(400); const t = (await req('/collaboration/tasks', 'POST', { title: 't', criteria: 'x' })).json.data; await req(`/collaboration/tasks/${t.taskId}/claim`, 'POST', { expectedRevision: 1 }); expect((await req(`/collaboration/tasks/${t.taskId}/submissions`, 'POST', { expectedRevision: 2, body: 'x', materialVersionIds: [newId()] })).status).toBe(409); });
    it('decomposition materializes hierarchy once and rejects stale mode', async () => { const { o, p, req } = await fixture(); const j = newId(), id = newId(); await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,attempts,created_at,updated_at) VALUES(?1,?2,'agent_run','succeeded','{}',0,?3,?3)").bind(j, p, nowIso()).run(); await env.DB.prepare('UPDATE jobs SET input_json=?2 WHERE id=?1').bind(j, JSON.stringify({ profileStamp: await profileStamp(env,p) })).run(); await env.DB.prepare("INSERT INTO collaboration_proposals(id,project_id,kind,job_id,payload_json,settings_revision,created_at,updated_at) VALUES(?1,?2,'decompose',?3,?4,1,?5,?5)").bind(id, p, j, JSON.stringify({ brief: 'Build', tasks: [{ title: 'Part', detail: 'work', criteria: 'works', effortHours: 2 }] }), nowIso()).run(); const applied = await applyProposal(env, p, id, 1, o.userId); expect(applied.taskIds).toHaveLength(1); const tasks = (await req('/collaboration/tasks')).json.data.items; expect(tasks).toHaveLength(2); expect(tasks.find((t: any) => t.title === 'Part').parentTaskId).toBe(tasks.find((t: any) => t.title === '需求总目标').taskId); await expect(applyProposal(env, p, id, 1, o.userId)).rejects.toThrow(); });
    it('simultaneous claims have one winner and one audit event', async () => {
        const { req, p } = await fixture();
        const t = (await req('/collaboration/tasks', 'POST', { title: 'race', criteria: 'x' })).json.data;
        const results = await Promise.all([req(`/collaboration/tasks/${t.taskId}/claim`, 'POST', { expectedRevision: 1 }), req(`/collaboration/tasks/${t.taskId}/claim`, 'POST', { expectedRevision: 1 }, true)]);
        expect(results.map(r => r.status).sort()).toEqual([200, 409]);
        const events = await env.DB.prepare("SELECT COUNT(*) n FROM events WHERE project_id=?1 AND type='collaboration.claim'").bind(p).first<{
            n: number;
        }>();
        expect(events?.n).toBe(1);
    });
    it('assignment proposal cannot overwrite a claim; null recommendation remains open', async () => { const { req, p, o, m } = await fixture(); const t = (await req('/collaboration/tasks', 'POST', { title: 'race', criteria: 'x' })).json.data; const make = async (assigneeId: string | null) => { const j = newId(), id = newId(); await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,attempts,created_at,updated_at) VALUES(?1,?2,'agent_run','succeeded','{}',0,?3,?3)").bind(j, p, nowIso()).run(); await env.DB.prepare('UPDATE jobs SET input_json=?2 WHERE id=?1').bind(j, JSON.stringify({ profileStamp: await profileStamp(env,p) })).run(); await env.DB.prepare("INSERT INTO collaboration_proposals(id,project_id,kind,job_id,payload_json,settings_revision,created_at,updated_at) VALUES(?1,?2,'assign',?3,?4,1,?5,?5)").bind(id, p, j, JSON.stringify({ assignments: [{ taskId: t.taskId, assigneeId, expectedRevision: 1, reason: 'skill' }] }), nowIso()).run(); return id; }; const empty = await make(null); await applyProposal(env, p, empty, 1, o.userId); expect((await req('/collaboration/tasks')).json.data.items[0].assigneeId).toBeNull(); const proposed = await make(o.userId); await req(`/collaboration/tasks/${t.taskId}/claim`, 'POST', { expectedRevision: 1 }, true); await expect(applyProposal(env, p, proposed, 1, o.userId)).rejects.toThrow(); expect((await req('/collaboration/tasks')).json.data.items[0].assigneeId).toBe(m.userId); });
    it('global admin without project ownership cannot override project decisions', async () => { const { req, m } = await fixture(); await env.DB.prepare("UPDATE auth_accounts SET account_role='super_admin',is_admin=1 WHERE user_id=?1").bind(m.userId).run(); expect((await req('/collaboration/settings', 'PATCH', { expectedRevision: 1, evaluationMode: 'automatic' }, true)).status).toBe(403); expect((await req('/collaboration/tasks', 'POST', { title: 'bad', criteria: 'x' }, true)).status).toBe(403); });
    it('removed assignee cannot submit or be approved through stale membership', async () => { const { req, p, m, o } = await fixture(); const t = (await req('/collaboration/tasks', 'POST', { title: 't', criteria: 'x' })).json.data; await req(`/collaboration/tasks/${t.taskId}/claim`, 'POST', { expectedRevision: 1 }, true); const submission = (await req(`/collaboration/tasks/${t.taskId}/submissions`, 'POST', { expectedRevision: 2, body: 'draft' }, true)).json.data; await env.DB.prepare('DELETE FROM project_members WHERE project_id=?1 AND user_id=?2').bind(p, m.userId).run(); expect((await req(`/collaboration/submissions/${submission.submissionId}/decide`, 'POST', { expectedRevision: 1, decision: 'accept', feedback: 'yes' })).status).toBe(409); const recovery = await req(`/collaboration/tasks/${t.taskId}/assign`, 'POST', { expectedRevision: 3, assigneeId: o.userId, reason: '原成员退出，重新接手' }); expect(recovery.status).toBe(200); expect(recovery.json.data.currentSubmissionId).toBeNull(); expect(recovery.json.data.lifecycleState).toBe('in_progress'); expect((await req(`/collaboration/tasks/${t.taskId}/submissions`)).json.data.items).toHaveLength(1); });
    it('owner edits criteria with revision and submission freezes prior criteria', async () => { const { req } = await fixture(); const t = (await req('/collaboration/tasks', 'POST', { title: 't', criteria: 'original' })).json.data; expect((await req(`/collaboration/tasks/${t.taskId}`, 'PATCH', { expectedRevision: 1, criteria: 'new' }, true)).status).toBe(403); const edit = await req(`/collaboration/tasks/${t.taskId}`, 'PATCH', { expectedRevision: 1, criteria: 'new', effortHours: 4 }); expect(edit.status).toBe(200); expect(edit.json.data.criteria).toBe('new'); expect((await req(`/collaboration/tasks/${t.taskId}`, 'PATCH', { expectedRevision: 2, status: 'done' })).status).toBe(400); await req(`/collaboration/tasks/${t.taskId}/claim`, 'POST', { expectedRevision: 2 }, true); const submission = (await req(`/collaboration/tasks/${t.taskId}/submissions`, 'POST', { expectedRevision: 3, body: 'draft' }, true)).json.data; expect(submission.criteria).toBe('new'); expect(submission.evaluationError).toBeTruthy(); expect(submission.evaluationAttempts).toBe(0); expect((await req(`/collaboration/tasks/${t.taskId}`, 'PATCH', { expectedRevision: 4, criteria: 'changed' })).status).toBe(409); expect((await req(`/collaboration/tasks/${t.taskId}/submissions`)).json.data.items[0].criteria).toBe('new'); });
});
it('creation idempotency remains scoped to the URL project even with ignored body fields', async () => {
    const owner = await seedUser();
    const first = await seedProject(owner.userId);
    const second = await seedProject(owner.userId);
    const key = newId();
    const create = (projectId: string) => SELF.fetch(`${BASE}/api/v1/projects/${projectId}/collaboration/tasks`, {
        method: 'POST',
        headers: { cookie: authCookie(owner.token), 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ title: 'Scoped', criteria: 'Preserve scope', projectId: 'ignored-in-body' }),
    });
    const created = await create(first);
    expect(created.status).toBe(201);
    await created.text();
    const wrongScope = await create(second);
    expect(wrongScope.status).toBe(409);
    expect((await wrongScope.json() as {
        error: {
            code: string;
        };
    }).error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM tasks WHERE project_id=?1').bind(second).first<{
        n: number;
    }>())?.n).toBe(0);
});
