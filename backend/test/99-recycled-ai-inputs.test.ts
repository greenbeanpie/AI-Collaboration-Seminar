import { saveStandard } from '../src/services/project-simplification';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { configureGoFixture, assertGoRequest } from './helpers/provider-config';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { assertSourceInputs, snapshotRequirementSources, snapshotSourceInputs } from '../src/services/source-inputs';
import { runAgentJob } from '../src/services/agent';
import { runAssignmentSuggestionJob } from '../src/services/assignment';
import { runReviewJob } from '../src/services/review';
import { getJob } from '../src/services/jobs';

await configureGoFixture();
afterEach(() => vi.unstubAllGlobals());
const id = () => crypto.randomUUID();
const timestamp = () => new Date().toISOString();
const app = createApp();
const offline = { ...env, AGENT_WORKFLOW: { create: async () => { throw new Error('offline test workflow'); } } } as unknown as Env;

async function fixture() {
  const user = await seedUser();
  const projectId = await seedProject(user.userId);
  const sourceId = id(), sourceVersionId = id(), fragmentId = id(), fileId = id(), setId = id(), requirementId = id();
  const materialId = id(), materialVersionId = id(), rubricId = id(), now = timestamp();
  const citation = { sourceVersionId, fragmentId, pageNumber: 1, quote: '原始项目要求' };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO files(id,project_id,uploader_user_id,r2_key,ext,status,original_name,created_at) VALUES(?1,?2,?3,?4,'pdf','available','原始文件.pdf',?5)").bind(fileId, projectId, user.userId, `fixture/${fileId}`, now),
    env.DB.prepare("INSERT INTO sources(id,project_id,kind,title,current_version_id,created_by,created_at,updated_at) VALUES(?1,?2,'file','原始来源',?3,?4,?5,?5)").bind(sourceId, projectId, sourceVersionId, user.userId, now),
    env.DB.prepare("INSERT INTO source_versions(id,source_id,project_id,revision,origin,file_id,char_count,page_count,status,created_at) VALUES(?1,?2,?3,1,'file',?4,7,1,'ready',?5)").bind(sourceVersionId, sourceId, projectId, fileId, now),
    env.DB.prepare("INSERT INTO source_fragments(id,source_version_id,project_id,page_number,seq,kind,content,created_at) VALUES(?1,?2,?3,1,1,'text','原始项目要求',?4)").bind(fragmentId, sourceVersionId, projectId, now),
    env.DB.prepare("INSERT INTO requirement_sets(id,project_id,source_version_id,status,revision,confirmed_at,created_at,updated_at) VALUES(?1,?2,?3,'confirmed',1,?4,?4,?4)").bind(setId, projectId, sourceVersionId, now),
    env.DB.prepare("INSERT INTO requirements(id,requirement_set_id,project_id,seq,category,title,detail,due_precision,citations_json,field_state,updated_at) VALUES(?1,?2,?3,1,'other','来源派生要求','保留历史内容','unknown',?4,'confirmed',?5)").bind(requirementId, setId, projectId, JSON.stringify([citation]), now),
    env.DB.prepare("INSERT INTO materials(id,project_id,title,kind,current_version_id,revision,created_by,created_at,updated_at) VALUES(?1,?2,'材料','document',?3,1,?4,?5,?5)").bind(materialId, projectId, materialVersionId, user.userId, now),
    env.DB.prepare("INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at,attachments_json) VALUES(?1,?2,?3,1,?4,'独立编写的材料正文','manual',?5,?6,?7)").bind(materialVersionId, materialId, projectId, JSON.stringify({ type: 'doc', content: [] }), user.userId, now, JSON.stringify([{ fileId, name: '原始文件.pdf' }])),
    env.DB.prepare("INSERT INTO rubric_versions(id,project_id,version,source,weights_json,status,created_at) VALUES(?1,?2,1,'custom',?3,'confirmed',?4)").bind(rubricId, projectId, JSON.stringify([{ key: 'quality', label: '质量', weight: 100 }]), now),
    env.DB.prepare("INSERT INTO tasks(id,project_id,title,detail,status,revision,created_by,created_at,updated_at,lifecycle_state,criteria,effort_hours,source_citations_json) VALUES(?1,?2,'历史任务','保留历史任务','todo',1,?3,?4,?4,'open','核对要求',1,?5)").bind(id(), projectId, user.userId, now, JSON.stringify([citation])),
  ]);
  await saveStandard(env,projectId,user.userId,{requirementSetIds:[setId],rubricVersionId:rubricId});
  return { user, projectId, sourceId, sourceVersionId, fileId, setId, requirementId, materialId, materialVersionId, rubricId, citation };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function request(f: Fixture, path: string, method = 'GET', body?: unknown, runtime: Env = offline) {
  const context = createExecutionContext();
  const response = await app.fetch(new Request(`${BASE}/api/v1/projects/${f.projectId}/${path}`, {
    method, headers: { cookie: authCookie(f.user.token), 'content-type': 'application/json', 'idempotency-key': id() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), runtime, context);
  await waitOnExecutionContext(context);
  return response;
}
async function recycle(f: Fixture, restored = false) {
  await env.DB.batch([
    env.DB.prepare('UPDATE sources SET deleted_at=?2,lifecycle_version=lifecycle_version+1 WHERE id=?1').bind(f.sourceId, timestamp()),
    env.DB.prepare('UPDATE files SET deleted_at=?2,lifecycle_version=lifecycle_version+1 WHERE id=?1').bind(f.fileId, timestamp()),
  ]);
  if (restored) await env.DB.batch([
    env.DB.prepare('UPDATE sources SET deleted_at=NULL,lifecycle_version=lifecycle_version+1 WHERE id=?1').bind(f.sourceId),
    env.DB.prepare('UPDATE files SET deleted_at=NULL,lifecycle_version=lifecycle_version+1 WHERE id=?1').bind(f.fileId),
  ]);
}
function provider(output: unknown) {
  const mock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    assertGoRequest(url, init);
    return Response.json({ choices: [{ message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 30, completion_tokens: 20 } });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}
function beforeBatch(sqlMatch: string, before: () => Promise<void>): Env {
  const selected = new WeakSet<object>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, { get(target, key) {
      if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } }); selected.add(proxy); return proxy;
  };
  const database = new Proxy(env.DB, { get(target, key) {
    if (key === 'prepare') return (sql: string) => sql.includes(sqlMatch) ? wrap(target.prepare(sql)) : target.prepare(sql);
    if (key === 'batch') return async (statements: D1PreparedStatement[]) => { if (statements.some(statement => selected.has(statement))) await before(); return target.batch(statements); };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { ...offline, DB: database };
}

function beforeRun(sqlMatch: string, before: () => Promise<void>): Env {
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(target, key) {
    if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
    if (key === 'run') return async () => { await before(); return target.run(); };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const database = new Proxy(env.DB, { get(target, key) {
    if (key === 'prepare') return (sql: string) => sql.includes(sqlMatch) ? wrap(target.prepare(sql)) : target.prepare(sql);
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { ...offline, DB: database };
}

describe('recycled sources are unavailable for new AI inputs', () => {
  it('freezes lifecycle and rejects an old snapshot even after restoration', async () => {
    const f = await fixture(), captured = await snapshotSourceInputs(env, f.projectId, [f.sourceVersionId]);
    expect(captured[0]?.sourceLifecycleVersion).toBe(1);
    await recycle(f);
    await expect(snapshotSourceInputs(env, f.projectId, [f.sourceVersionId])).rejects.toThrow();
    await env.DB.batch([
      env.DB.prepare('UPDATE sources SET deleted_at=NULL,lifecycle_version=lifecycle_version+1 WHERE id=?1').bind(f.sourceId),
      env.DB.prepare('UPDATE files SET deleted_at=NULL,lifecycle_version=lifecycle_version+1 WHERE id=?1').bind(f.fileId),
    ]);
    await expect(assertSourceInputs(env, f.projectId, [f.sourceVersionId], captured)).rejects.toThrow();
    const current = await snapshotSourceInputs(env, f.projectId, [f.sourceVersionId]);
    expect(current[0]?.sourceLifecycleVersion).toBe(3);
    await expect(assertSourceInputs(env, f.projectId, [f.sourceVersionId], current)).resolves.toBeUndefined();
    await expect(assertSourceInputs(env, f.projectId, [f.sourceVersionId], undefined)).rejects.toThrow('快照缺失');
    await expect(snapshotSourceInputs(env, id(), [f.sourceVersionId])).rejects.toThrow('不属于');
  });
  it('retains unavailable requirement citations and task provenance while denying new model input', async () => {
    const f = await fixture(); await recycle(f);
    await expect(snapshotRequirementSources(env, f.projectId, f.setId)).rejects.toThrow();
    const requirements = await request(f, `requirement-sets/${f.setId}`);
    expect(requirements.status).toBe(200);
    expect((await requirements.json() as { data: unknown }).data).toMatchObject({
      sourceVersionId: f.sourceVersionId, sourceAvailability: 'unavailable', requirements: [{ title: '来源派生要求', citations: [{ ...f.citation, availability: 'unavailable' }] }],
    });
    const tasks = await request(f, 'collaboration/tasks');
    expect((await tasks.json() as { data: { items: unknown[] } }).data.items).toMatchObject([{ citations: [{ ...f.citation, availability: 'unavailable' }] }]);
    const explicit = await request(f, 'assignment-suggestions', 'POST', { requirementSetId: f.setId });
    expect(explicit.status).toBe(404);
    const automatic = await request(f, 'assignment-suggestions', 'POST', {});
    expect(automatic.status).toBe(404);
    await automatic.text();

  });
  it('rejects agent selection before enqueue and stale restored snapshots before a fetch', async () => {
    const f = await fixture(); await recycle(f);
    expect((await request(f, 'agent-sessions', 'POST', { mode: 'do', sourceVersionIds: [f.sourceVersionId] })).status).toBe(404);
    await env.DB.batch([
      env.DB.prepare('UPDATE sources SET deleted_at=NULL,lifecycle_version=lifecycle_version+1 WHERE id=?1').bind(f.sourceId),
      env.DB.prepare('UPDATE files SET deleted_at=NULL,lifecycle_version=lifecycle_version+1 WHERE id=?1').bind(f.fileId),
    ]);
    const response = await request(f, 'agent-sessions', 'POST', { mode: 'do', sourceVersionIds: [f.sourceVersionId] });
    expect(response.status).toBe(202);
    const created = (await response.json() as { data: { jobId: string; runId: string } }).data;
    expect(JSON.parse((await getJob(env, created.jobId)).input_json).sourceSnapshots[0].sourceLifecycleVersion).toBe(3);
    await recycle(f, true);
    const fetch = provider({ title: '草稿', markdown: '不可发布' });
    await runAgentJob(offline, created.jobId);
    expect(fetch).not.toHaveBeenCalled();
    expect((await getJob(env, created.jobId)).status).toBe('failed');
  });
  it('agent output CAS rejects recycling and restoring after the last source read', async () => {
    const f = await fixture();
    const response = await request(f, 'agent-sessions', 'POST', { mode: 'do', sourceVersionIds: [f.sourceVersionId] });
    const created = (await response.json() as { data: { jobId: string; runId: string } }).data;
    const fetch = provider({ title: '草稿', markdown: '来源支持的内容' });
    await runAgentJob(beforeBatch("UPDATE agent_runs SET status='succeeded'", () => recycle(f, true)), created.jobId);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await getJob(env, created.jobId)).status).toBe('failed');
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM agent_turns WHERE run_id=?1').bind(created.runId).first<{ n: number }>())?.n).toBe(0);
    expect((await env.DB.prepare('SELECT status FROM agent_runs WHERE id=?1').bind(created.runId).first<{ status: string }>())?.status).toBe('failed');
  });
  it('review freezes requirement-source lifecycle and refuses stale restored queued input', async () => {
    const f = await fixture();
    const body = { rubricVersionId: f.rubricId, requirementSetId: f.setId, materialVersionIds: [f.materialVersionId] };
    const response = await request(f, 'reviews', 'POST', body);
    expect(response.status).toBe(202);
    const created = (await response.json() as { data: { jobId: string; reviewId: string } }).data;
    expect(JSON.parse((await getJob(env, created.jobId)).input_json).sourceSnapshots[0].sourceLifecycleVersion).toBe(1);
    await recycle(f, true);
    const fetch = provider({ scores: [{ key: 'quality', score: 80 }], overall: { score: 80, summary: '完整' } });
    await runReviewJob(offline, created.jobId);
    expect(fetch).not.toHaveBeenCalled();
    expect((await getJob(env, created.jobId)).status).toBe('failed');
    await recycle(f);
    expect((await request(f, 'reviews', 'POST', body)).status).toBe(404);
  });
});

describe('requirement-derived publication races', () => {
  it('assignment publication CAS rejects a source restored after the last check', async () => {
    const f = await fixture();
    const response = await request(f, 'assignment-suggestions', 'POST', { requirementSetId: f.setId });
    const { jobId } = (await response.json() as { data: { jobId: string } }).data;
    const input = JSON.parse((await getJob(env, jobId)).input_json) as { tasks: Array<{ taskId: string }> };
    const fetch = provider({ assignments: input.tasks.map(task => ({ taskId: task.taskId, assigneeId: null })) });
    await runAssignmentSuggestionJob(beforeRun("UPDATE jobs SET status='succeeded',result_json", () => recycle(f, true)), jobId);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await getJob(env, jobId)).toMatchObject({ status: 'failed', result_json: null });
  });
  it('review result CAS rejects restored newer source lifecycles', async () => {
    const f = await fixture();
    const response = await request(f, 'reviews', 'POST', { rubricVersionId: f.rubricId, requirementSetId: f.setId, materialVersionIds: [f.materialVersionId] });
    const created = (await response.json() as { data: { jobId: string; reviewId: string } }).data;
    const fetch = provider({ scores: [{ key: 'quality', score: 80 }], overall: { score: 80, summary: '完整' } });
    await runReviewJob(beforeBatch("UPDATE reviews SET status='succeeded'", () => recycle(f, true)), created.jobId);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await getJob(env, created.jobId)).status).toBe('failed');
    expect(await env.DB.prepare('SELECT status,report_json FROM reviews WHERE id=?1').bind(created.reviewId).first()).toMatchObject({ status: 'failed', report_json: null });
  });
  it('assignment refuses restored stale source requirements before fetching', async () => {
    const f = await fixture();
    const response = await request(f, 'assignment-suggestions', 'POST', { requirementSetId: f.setId });
    expect(response.status).toBe(202);
    const { jobId } = (await response.json() as { data: { jobId: string } }).data;
    await recycle(f, true);
    const fetch = provider({ assignments: [] });
    await runAssignmentSuggestionJob(offline, jobId);
    expect(fetch).not.toHaveBeenCalled();
    expect((await getJob(env, jobId)).status).toBe('failed');
  });
});

describe('historical material attachments survive recycling', () => {
  it('shows retained references unavailable, permits ordinary edits, and denies new deleted-file associations', async () => {
    const f = await fixture(); await recycle(f);
    const get = await request(f, `materials/${f.materialId}`);
    expect((await get.json() as { data: unknown }).data).toMatchObject({ currentVersion: { attachments: [{ fileId: f.fileId, name: '原始文件.pdf', availability: 'unavailable' }] } });
    const edited = await request(f, `materials/${f.materialId}`, 'PUT', { expectedRevision: 1, doc: { type: 'doc', content: [] } });
    expect(edited.status).toBe(201);
    expect((await edited.json() as { data: unknown }).data).toMatchObject({ attachments: [{ fileId: f.fileId, availability: 'unavailable' }] });
    const attach = await request(f, `materials/${f.materialId}`, 'PUT', { expectedRevision: 2, doc: { type: 'doc', content: [] }, attachmentIds: [f.fileId] });
    expect(attach.status).toBe(404);
    const history = await request(f, `materials/${f.materialId}/versions/${f.materialVersionId}`);
    expect((await history.json() as { data: unknown }).data).toMatchObject({ attachments: [{ fileId: f.fileId, availability: 'unavailable' }] });
    const original = await env.DB.prepare('SELECT attachments_json FROM material_versions WHERE id=?1').bind(f.materialVersionId).first<{ attachments_json: string }>();
    expect(JSON.parse(original!.attachments_json)).toEqual([{ fileId: f.fileId, name: '原始文件.pdf' }]);
  });
  it('atomic attachment association rejects a file restored into a newer lifecycle during save', async () => {
    const f = await fixture();
    const response = await request(f, `materials/${f.materialId}`, 'PUT', { expectedRevision: 1, doc: { type: 'doc', content: [] }, attachmentIds: [f.fileId] }, beforeBatch('INSERT INTO material_versions', () => recycle(f, true)));
    expect(response.status).toBe(409);
    expect(await env.DB.prepare('SELECT revision,current_version_id FROM materials WHERE id=?1').bind(f.materialId).first()).toMatchObject({ revision: 1, current_version_id: f.materialVersionId });
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM material_versions WHERE material_id=?1').bind(f.materialId).first<{ n: number }>())?.n).toBe(1);
  });
});

describe('historical exports', () => {
  it('annotates recycled file and source references in retained exports', async () => {
    const f = await fixture();
    await recycle(f);
    const bundle = await request(f, 'export-bundle');
    expect(bundle.status).toBe(200);
    expect((await bundle.json() as { data: unknown }).data).toMatchObject({ materials: [{ attachments: [{ fileId: f.fileId, availability: 'unavailable' }] }], requirementSets: [{ sourceAvailability: 'unavailable', requirements: [{ citations: [{ ...f.citation, availability: 'unavailable' }] }] }] });
  });
});
