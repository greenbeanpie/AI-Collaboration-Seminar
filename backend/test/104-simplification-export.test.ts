import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { env, BASE } from './helpers/env';
import { seedUser, authCookie } from './helpers/seed';
import { newId, nowIso } from '../src/core/db';

async function call<T>(cookie: string, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', key?: string) {
  const response = await SELF.fetch(`${BASE}/api/v1${path}`, { method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(key ? { 'idempotency-key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { response, data: (await response.json()) as { data: T; error?: { code: string } } };
}

describe('Simplification integration and complete export', () => {
  it('authenticates the actual dependency route before resolving actor or mutating the graph', async () => {
    const owner = await seedUser(), member = await seedUser();
    const created = await call<{ id: string }>(authCookie(owner.token), '/projects', { name: 'Dependency authorization' });
    const project = created.data.data.id, a = newId(), b = newId(), now = nowIso();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES(?1,?2,?3,'member',?4)").bind(newId(), project, member.userId, now),
      ...[a,b].map(id => env.DB.prepare("INSERT INTO tasks(id,project_id,title,criteria,lifecycle_state,created_by,created_at,updated_at) VALUES(?1,?2,'Child','Evidence','open',?3,?4,?4)").bind(id, project, owner.userId, now)),
    ]);
    const endpoint = `/projects/${project}/tasks/${b}/dependencies`, body = { expectedGraphRevision: 1, dependsOnTaskIds: [a] };
    expect((await call('', endpoint, body, 'PUT')).response.status).toBe(401);
    expect((await call(authCookie(member.token), endpoint, body, 'PUT')).response.status).toBe(403);
    const result = await call<{ unfinishedDependencyIds: string[] }>(authCookie(owner.token), endpoint, body, 'PUT');
    expect(result.response.status).toBe(200);
    expect(result.data.data.unfinishedDependencyIds).toEqual([a]);
  });
  it('creates one goal and editable background atomically, including idempotent replay', async () => {
    const user = await seedUser();
    const cookie = authCookie(user.token), key = newId();
    const body = { name: 'One goal', description: 'Original project background' };
    const created = await call<{ id: string }>(cookie, '/projects', body, 'POST', key);
    expect(created.response.status).toBe(201);
    const projectId = created.data.data.id;
    const repeated = await call<{ id: string }>(cookie, '/projects', body, 'POST', key);
    expect(repeated.data.data.id).toBe(projectId);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM project_goals WHERE project_id=?1').bind(projectId).first<{ n: number }>()).toEqual({ n: 1 });
    const library = await call<{ items: Array<{ resourceId: string; purpose: string; currentVersionId: string }> }>(cookie, `/projects/${projectId}/resource-library`);
    expect(library.response.status).toBe(200);
    expect(library.data.data.items).toHaveLength(1);
    expect(library.data.data.items[0]?.purpose).toBe('background');
    const version = await env.DB.prepare('SELECT markdown FROM material_versions WHERE id=?1').bind(library.data.data.items[0]!.currentVersionId).first<{ markdown: string }>();
    expect(version?.markdown).toBe(body.description);
  });

  it('exports the graph, immutable artifact and assessment history without private profiles', async () => {
    const user = await seedUser();
    const cookie = authCookie(user.token), now = nowIso();
    const created = await call<{ id: string }>(cookie, '/projects', { name: 'Frozen goal', description: 'Background' });
    const projectId = created.data.data.id, prefix = `/projects/${projectId}`;
    const first = newId(), second = newId(), material = newId(), version = newId(), submission = newId(), assessment = newId(), rehearsal = newId(), source = newId(), sourceVersion = newId(), fragment = newId(), review = newId();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO personal_profiles(user_id,major,specialties,revision,updated_at,weekly_available_hours) VALUES(?1,'Hidden major','Hidden skills',1,?2,17)").bind(user.userId, now),
      env.DB.prepare("INSERT INTO tasks(id,project_id,title,status,revision,created_by,created_at,updated_at) VALUES(?1,?2,'Legacy done','done',8,?3,?4,?4)").bind(first, projectId, user.userId, now),
      env.DB.prepare("INSERT INTO tasks(id,project_id,title,status,lifecycle_state,criteria,current_submission_id,created_by,created_at,updated_at) VALUES(?1,?2,'Accepted child','done','accepted','Retained criteria',?3,?4,?5,?5)").bind(second, projectId, submission, user.userId, now),
      env.DB.prepare('INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,created_at) VALUES(?1,?2,?3,?4)').bind(projectId, second, first, now),
      env.DB.prepare("INSERT INTO materials(id,project_id,title,current_version_id,revision,created_by,created_at,updated_at) VALUES(?1,?2,'Original artifact',?3,1,?4,?5,?5)").bind(material, projectId, version, user.userId, now),
      env.DB.prepare("INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at) VALUES(?1,?2,?3,1,'{}','Immutable artifact','manual',?4,?5)").bind(version, material, projectId, user.userId, now),
      env.DB.prepare("INSERT INTO sources(id,project_id,kind,title,current_version_id,created_by,created_at,updated_at) VALUES(?1,?2,'paste','Original source',?3,?4,?5,?5)").bind(source, projectId, sourceVersion, user.userId, now),
      env.DB.prepare("INSERT INTO source_versions(id,source_id,project_id,revision,origin,status,created_at) VALUES(?1,?2,?3,1,'paste','ready',?4)").bind(sourceVersion, source, projectId, now),
      env.DB.prepare("INSERT INTO source_fragments(id,source_version_id,project_id,seq,kind,content,created_at) VALUES(?1,?2,?3,1,'paste','Original quoted requirement',?4)").bind(fragment, sourceVersion, projectId, now),
      env.DB.prepare("UPDATE tasks SET source_citations_json=?2 WHERE id=?1").bind(second, JSON.stringify([{ sourceVersionId: sourceVersion, fragmentId: fragment, pageNumber: null, quote: 'Original quoted requirement' }])),
      env.DB.prepare("INSERT INTO task_links(id,project_id,task_id,kind,target_id,created_at) VALUES(?1,?2,?3,'source_version',?4,?5)").bind(newId(), projectId, second, sourceVersion, now),
      env.DB.prepare("INSERT INTO task_submissions(id,project_id,task_id,round,submitted_by,body,criteria,task_revision,status,material_versions_json,created_at,updated_at) VALUES(?1,?2,?3,1,?4,'Original submission','Retained criteria',1,'accept',?5,?6,?6)").bind(submission, projectId, second, user.userId, JSON.stringify([version]), now),
    ]);
    const standard = await call<{ standardsVersionId: string; revision: number; requirementSetIds: string[]; rubricVersionId: string }>(cookie, `${prefix}/standards`, { title: 'Combined standard', requirements: [{ title: 'Keep original evidence', detail: 'Deliver an artifact', category: 'deliverable', dimensionKey: 'quality' }], weights: [{ key: 'quality', label: 'Quality', weight: 100 }] });
    expect(standard.response.status).toBe(201);
    const confirmed = standard;
    const goal = await call<Record<string, unknown>>(cookie, `${prefix}/goal`);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO reviews(id,project_id,requirement_set_id,rubric_version_id,material_version_ids_json,status,created_by,created_at) VALUES(?1,?2,?3,?4,?5,'failed',?6,?7)").bind(review, projectId, standard.data.data.requirementSetIds[0]!, standard.data.data.rubricVersionId, JSON.stringify([version]), user.userId, now),
      env.DB.prepare("INSERT INTO assessments(id,project_id,kind,goal_revision,standards_version_id,inputs_json,status,report_json,created_by,created_at) VALUES(?1,?2,'material_review',1,?3,?4,'succeeded',?5,?6,?7)").bind(assessment, projectId, standard.data.data.standardsVersionId, JSON.stringify({ goal: goal.data.data, standard: confirmed.data.data, materialVersionIds: [version], sourceSnapshots: [] }), JSON.stringify({ status: 'scored', weightedTotal: 77, scores: [{ key: 'quality', score: 77 }], summary: 'Frozen report' }), user.userId, now),
      env.DB.prepare("INSERT INTO rehearsals(id,project_id,scope,status,created_by,created_at,finished_at) VALUES(?1,?2,'all','finished',?3,?4,?4)").bind(rehearsal, projectId, user.userId, now),
      env.DB.prepare("INSERT INTO rehearsal_turns(id,rehearsal_id,project_id,sequence,kind,content_json,created_at) VALUES(?1,?2,?3,1,'answer',?4,?5)").bind(newId(), rehearsal, projectId, JSON.stringify({ content: 'Actual historical answer' }), now),
      env.DB.prepare("INSERT INTO rehearsal_turns(id,rehearsal_id,project_id,sequence,kind,content_json,created_at) VALUES(?1,?2,?3,2,'summary',?4,?5)").bind(newId(), rehearsal, projectId, JSON.stringify({ content: 'Historical narrative only' }), now),
    ]);
    expect((await call(cookie, `${prefix}/goal`, { expectedRevision: 1, title: 'Updated goal' }, 'PATCH')).response.status).toBe(200);
    const result = await call<{ mainGoal: { title: string }; tasks: Array<{ taskId: string; status: string; dependsOnTaskIds: string[]; citations: Array<{ sourceVersionId: string; fragmentId: string; quote: string }> }>; taskDependencies: unknown[]; taskLinks: Array<{ taskId: string; targetId: string }>; materialVersions: Array<{ versionId: string; markdown: string }>; taskSubmissions: Array<{ submissionId: string }>; standardsVersions: unknown[]; legacyReviews: Array<{ reviewId: string; requirementSetId: string; rubricVersionId: string }>; assessments: Array<{ assessmentId: string; historical: boolean; goal: { title: string } | null; report: { weightedTotal?: number } | null }>; rehearsalTurns: Array<{ rehearsalId: string; content: { content: string } }> }>(cookie, `${prefix}/export-bundle`);
    expect(result.response.status).toBe(200);
    const bundle = result.data.data;
    expect(bundle.mainGoal.title).toBe('Updated goal');
    expect(bundle.tasks.find(task => task.taskId === first)?.status).toBe('done');
    expect(bundle.tasks.find(task => task.taskId === second)?.dependsOnTaskIds).toEqual([first]);
    expect(bundle.taskDependencies).toEqual([{ taskId: second, dependsOnTaskId: first }]);
    expect(bundle.tasks.find(task => task.taskId === second)?.citations[0]).toMatchObject({ sourceVersionId: sourceVersion, fragmentId: fragment, quote: 'Original quoted requirement' });
    expect(bundle.taskLinks[0]).toMatchObject({ taskId: second, targetId: sourceVersion });
    expect(bundle.materialVersions.find(item => item.versionId === version)?.markdown).toBe('Immutable artifact');
    expect(bundle.taskSubmissions[0]?.submissionId).toBe(submission);
    expect(bundle.standardsVersions).toHaveLength(1);
    expect(bundle.legacyReviews[0]).toMatchObject({ reviewId: review, requirementSetId: standard.data.data.requirementSetIds[0], rubricVersionId: standard.data.data.rubricVersionId });
    const frozen = bundle.assessments.find(item => item.assessmentId === assessment);
    expect(frozen?.goal?.title).toBe('Frozen goal');
    expect(frozen?.report?.weightedTotal).toBe(77);
    expect(bundle.assessments.find(item => item.assessmentId === rehearsal)?.historical).toBe(true);
    expect(bundle.rehearsalTurns.find(turn => turn.rehearsalId === rehearsal)?.content.content).toBe('Actual historical answer');
    expect(JSON.stringify(bundle)).not.toContain('Hidden major');
    expect(JSON.stringify(bundle)).not.toContain('Hidden skills');
    expect(bundle).not.toHaveProperty('personalProfiles');
    const outsider = await seedUser();
    expect((await call(authCookie(outsider.token), `${prefix}/export-bundle`)).response.status).toBe(403);
  });
});
