import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Deliberately refuse remote/production services: this creates disposable local records.
const base = new URL(process.env.INTEGRATION_URL || 'http://localhost:5173');
assert(['localhost', '127.0.0.1'].includes(base.hostname), 'Only loopback verification is supported');
const origin = base.origin;
const runId = randomUUID();
let checks = 0;
async function call(account, path, { method = 'GET', body, status = 200, code } = {}) {
  const headers = { Origin: origin, 'X-Request-Id': randomUUID(), 'CF-Connecting-IP': `198.51.100.${1 + Math.floor(Math.random() * 250)}` };
  if (account?.cookie) headers.Cookie = account.cookie;
  if (body !== undefined && !(body instanceof Uint8Array)) headers['Content-Type'] = 'application/json';
  const res = await fetch(new URL(path.startsWith('/api/') ? path : `/api/v1${path}`, base), {
    method, headers, body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
  });
  assert.equal(res.status, status, `${method} ${path} status: ${await (res.clone()).text()}`);
  const contentType = res.headers.get('content-type') || '';
  const envelope = contentType.includes('application/json') ? await res.json() : { data: await res.text() };
  if (contentType.includes('application/json')) assert(envelope.requestId, 'Response must carry requestId');
  if (code) assert.equal(envelope.error?.code, code, `${method} ${path} error`);
  const cookie = res.headers.get('set-cookie');
  if (cookie && account) account.cookie = cookie.split(';')[0];
  checks++;
  return envelope.data;
}
const capabilities = await call(null, '/capabilities');
assert.equal(capabilities.environment, 'local', 'Only ENV_NAME=local is supported');
assert.equal(capabilities.features.emailMode, 'echo', 'Use local echo, never send test mail');
async function login(role) {
  const account = { cookie: '' };
  const email = `${role}.${runId}@example.test`;
  const challenge = await call(account, '/auth/challenges', { method: 'POST', body: { email }, status: 201 });
  assert.match(challenge.devCode, /^\d{6}$/);
  const data = await call(account, '/auth/sessions', { method: 'POST', body: { email, challengeId: challenge.challengeId, code: challenge.devCode }, status: 201 });
  account.user = data.user;
  assert.equal((await call(account, '/auth/session')).user.id, account.user.id);
  return account;
}
const owner = await login('owner');
const member = await login('member');
const outsider = await login('outsider');
const project = await call(owner, '/projects', { method: 'POST', body: { name: `联调验证 ${runId}`, deadlineDate: '2026-10-08', deadlinePrecision: 'date' }, status: 201 });
const p = `/projects/${project.id}`;
assert.equal(project.myRole, 'owner');
await call(outsider, p, { status: 403, code: 'PERMISSION_DENIED' });
const invite = await call(owner, `${p}/invitations`, { method: 'POST', body: { maxUses: 1 }, status: 201 });
await call(member, '/invitations/accept', { method: 'POST', body: { code: invite.code } });
assert.equal((await call(member, p)).myRole, 'member');
await call(member, `${p}/members/me`, { method: 'PATCH', body: { skills: ['写作', '测试'], hoursPerWeek: 4 } });
const task = await call(owner, `${p}/tasks`, { method: 'POST', body: { title: '真实协作任务', assigneeId: member.user.id }, status: 201 });
const activeTask = await call(member, `${p}/tasks/${task.taskId}`, { method: 'PATCH', body: { expectedRevision: task.revision, status: 'doing' } });
await call(owner, `${p}/tasks/${task.taskId}`, { method: 'PATCH', body: { expectedRevision: task.revision, status: 'done' }, status: 409, code: 'VERSION_CONFLICT' });
await call(owner, `${p}/tasks/apply-assignment`, { method: 'POST', body: { taskId: task.taskId, assigneeId: owner.user.id, expectedRevision: task.revision }, status: 409, code: 'VERSION_CONFLICT' });
const assigned = await call(owner, `${p}/tasks/apply-assignment`, { method: 'POST', body: { taskId: task.taskId, assigneeId: owner.user.id, expectedRevision: activeTask.revision } });
assert.equal(assigned.assigneeId, owner.user.id);
assert.equal(assigned.status, 'doing', 'AI assignment adoption cannot complete a task');
await call(member, `${p}/comments`, { method: 'POST', body: { targetType: 'task', targetId: task.taskId, body: '真实评论' }, status: 201 });
assert.equal((await call(owner, `${p}/comments?targetType=task&targetId=${task.taskId}`)).items[0].body, '真实评论');
const material = await call(owner, `${p}/materials`, { method: 'POST', body: { title: '联调作品介绍' }, status: 201 });
const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '这份材料由真实 API 保存。' }] }] };
const version = await call(member, `${p}/materials/${material.materialId}`, { method: 'PUT', body: { expectedRevision: material.revision, doc }, status: 201 });
await call(owner, `${p}/materials/${material.materialId}`, { method: 'PUT', body: { expectedRevision: material.revision, doc }, status: 409, code: 'VERSION_CONFLICT' });
assert.equal((await call(owner, `${p}/materials/${material.materialId}`)).currentVersion.versionId, version.versionId);
assert.match(version.markdown, /真实 API/);
const file = await call(owner, `${p}/files`, { method: 'POST', body: { fileName: 'integration.txt', contentType: 'text/plain' }, status: 201 });
await call(owner, file.upload.url, { method: 'PUT', body: new TextEncoder().encode('联调测试文件'), status: 201 });
assert.equal(await call(member, file.upload.url), '联调测试文件');
const source = await call(owner, `${p}/sources`, { method: 'POST', body: { kind: 'paste', title: '真实来源', text: '请在2026年10月8日前提交作品介绍。' }, status: 201 });
assert(source.sourceVersionId);
const fileSource = await call(owner, `${p}/sources`, { method: 'POST', body: { kind: 'file', title: '真实文件来源', fileId: file.fileId }, status: 201 });
const fileVersion = await call(member, `${p}/sources/${fileSource.sourceId}/versions/${fileSource.sourceVersionId}`);
assert.equal(fileVersion.fileId, file.fileId, 'File association must come from the server');
const sourcePath = `${p}/sources/${source.sourceId}`;
await call(owner, `${sourcePath}/versions/${fileSource.sourceVersionId}`, { status: 404, code: 'NOT_FOUND' });
await call(owner, `${sourcePath}/render-requests?sourceVersionId=${fileSource.sourceVersionId}`, { status: 404, code: 'NOT_FOUND' });
await call(owner, `${sourcePath}/parse`, { method: 'POST', body: { sourceVersionId: fileSource.sourceVersionId }, status: 404, code: 'NOT_FOUND' });
await call(owner, `${sourcePath}/page-images`, { method: 'POST', body: { sourceVersionId: fileSource.sourceVersionId, images: [{ pageNumber: 1, fileId: file.fileId }] }, status: 404, code: 'NOT_FOUND' });
const rubric = await call(owner, `${p}/rubrics`, { method: 'POST', body: { source: 'custom', weights: [{ key: 'quality', label: '材料质量', weight: 100 }], notes: '联调备注' }, status: 201 });
const clearedRubric = await call(owner, `${p}/rubrics/${rubric.rubricId}`, { method: 'PATCH', body: { notes: null } });
assert.equal(clearedRubric.notes, null, 'Rubric notes can be explicitly cleared');
await call(member, `${p}/rubrics/${rubric.rubricId}/confirm`, { method: 'POST', status: 403, code: 'PERMISSION_DENIED' });
const confirmedRubric = await call(owner, `${p}/rubrics/${rubric.rubricId}/confirm`, { method: 'POST' });
assert.equal(confirmedRubric.status, 'confirmed');
await call(owner, `${p}/decisions`, { method: 'POST', body: { title: '验证真实服务', detail: '本地 API 数据，不进入生产。' }, status: 201 });
const contribution = await call(member, `${p}/contributions`, { method: 'POST', body: { description: '完成联调验证' }, status: 201 });
await call(member, `${p}/contributions/${contribution.contributionId}/corrections`, { method: 'POST', body: { description: '补充材料协作验证' }, status: 201 });
await call(owner, `${p}/resources`, { method: 'POST', body: { kind: 'other', title: '联调测试资源' }, status: 201 });
const exported = await call(owner, `${p}/export-bundle`);
assert(Array.isArray(exported.requirementSets));
assert.equal(exported.rubricVersions.find(item => item.rubricId === rubric.rubricId)?.status, 'confirmed');
// Unconfigured AI is explicitly unavailable, never replaced by demo success.
if (!capabilities.features.aiEnabled) {
  const pending = await call(owner, `${p}/agent-sessions`, { method: 'POST', body: { mode: 'do', instruction: '验证不可用状态' }, status: 202 });
  let job;
  for (let attempt = 0; attempt < 40; attempt++) {
    job = await call(owner, `/jobs/${pending.jobId}`);
    if (['failed', 'succeeded', 'cancelled'].includes(job.status)) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(job.status, 'failed', 'Disabled AI must fail explicitly');
  assert.equal(job.error.code, 'AI_UNAVAILABLE');
  await call(null, `/jobs/${pending.jobId}/retry`, { method: 'POST', body: {}, status: 401, code: 'UNAUTHENTICATED' });
  await call(outsider, `/jobs/${pending.jobId}/retry`, { method: 'POST', body: {}, status: 403, code: 'PERMISSION_DENIED' });
  const suggestion = await call(owner, `${p}/assignment-suggestions`, { method: 'POST', body: { taskIds: [task.taskId] }, status: 202 });
  let assignment;
  for (let attempt = 0; attempt < 40; attempt++) {
    assignment = await call(owner, `/jobs/${suggestion.jobId}`);
    if (['failed', 'succeeded', 'cancelled'].includes(assignment.status)) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(assignment.status, 'failed');
  assert.equal(assignment.error.code, 'AI_UNAVAILABLE');
}
await call(owner, `${p}/members/${member.user.id}`, { method: 'DELETE' });
await call(member, file.upload.url, { status: 403, code: 'PERMISSION_DENIED' });
await call(member, `${p}/export-bundle`, { status: 403, code: 'PERMISSION_DENIED' });
const archived = await call(owner, p, { method: 'PATCH', body: { expectedRevision: project.revision, status: 'archived', deadlineDate: null, deadlinePrecision: 'unknown' } });
assert.equal(archived.deadlineDate, null, 'Project deadline can be cleared');
for (const account of [owner, member, outsider]) {
  await call(account, '/auth/session', { method: 'DELETE' });
  await call(account, '/auth/session', { status: 401, code: 'UNAUTHENTICATED' });
}
console.log(`PASS: ${checks} real HTTP checks through ${origin}; two-account collaboration, persistence, version conflicts, private files, revocation and explicit unavailable AI. Disposable project ${project.id} archived.`);
