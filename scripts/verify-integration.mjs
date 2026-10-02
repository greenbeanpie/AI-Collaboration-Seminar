import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Deliberately refuse remote/production services: this creates disposable local records.
const base = new URL(process.env.INTEGRATION_URL || 'http://localhost:5173');
assert(['localhost', '127.0.0.1'].includes(base.hostname), 'Only loopback verification is supported');
const origin = base.origin;
const runId = randomUUID();
let checks = 0;
async function call(account, path, { method = 'GET', body, status = 200, code, headers: additionalHeaders = {} } = {}) {
  const headers = { Origin: origin, 'X-Request-Id': randomUUID(), 'CF-Connecting-IP': `198.51.100.${1 + Math.floor(Math.random() * 250)}`, ...additionalHeaders };
  // 写请求统一携带幂等键（冻结写请求强制要求，见 A08）
  if (method !== 'GET') headers['Idempotency-Key'] = randomUUID();
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
const privateCredentials = JSON.parse(readFileSync(new URL('../.local-secrets/admin-credentials.json', import.meta.url), 'utf8')).accounts.local;
const admin = { cookie: '' };
const adminSession = await call(admin, '/auth/sessions', { method: 'POST', body: { account: privateCredentials.username, password: privateCredentials.password }, status: 201 });
assert.equal(adminSession.user.isAdmin, true);
await call(null, '/auth/challenges', { method: 'POST', body: { email: 'disabled@example.test' }, status: 410 });
async function login(role) {
  const account = { cookie: '' };
  const invitation = await call(admin, '/admin/account-invitations', { method: 'POST', body: {}, status: 201 });
  assert.match(invitation.code, /^[A-Z0-9]{16}$/);
  const username = `${role}_${runId.slice(0,8)}`;
  const password = `Local-test-${randomUUID()}`;
  const data = await call(account, '/auth/register', { method: 'POST', body: { username, password, invitationCode: invitation.code }, status: 201 });
  assert.equal(data.user.email, null);
  assert.equal(data.user.isAdmin, false);
  account.user = data.user;
  assert.equal((await call(account, '/auth/session')).user.id, account.user.id);
  await call(account, '/admin/account-invitations', { status: 403 });
  return account;
}
const owner = await login('owner');
const member = await login('member');
const outsider = await login('outsider');
const project = await call(owner, '/projects', { method: 'POST', body: { name: `联调验证 ${runId}`, description: '本地联调项目背景，不进入生产。', deadlineDate: '2026-10-08', deadlinePrecision: 'date' }, status: 201 });
const p = `/projects/${project.id}`;
assert.equal(project.myRole, 'owner');
await call(outsider, p, { status: 403, code: 'PERMISSION_DENIED' });
const invite = await call(owner, `${p}/invitations`, { method: 'POST', body: { maxUses: 1 }, status: 201 });
await call(member, '/invitations/accept', { method: 'POST', body: { code: invite.code } });
assert.equal((await call(member, p)).myRole, 'member');
await call(member, `${p}/members/me`, { method: 'PATCH', body: { skills: ['写作', '测试'], hoursPerWeek: 4 }, status: 410, code: 'INVALID_STATE' });
const profile = await call(member, '/auth/personal-profile');
await call(member, '/auth/personal-profile', { method: 'PUT', headers: { 'X-Account-Settings': '1' }, body: { ...profile, expectedRevision: profile.revision, searchable: false, aiUseAllowed: false, major: '本地验证专业', specialties: '写作与测试', weeklyAvailableHours: 4, visibility: { bio: false, major: false, specialties: false, preferredRoles: false }, revision: undefined } });
assert.equal((await call(member, '/auth/personal-profile')).weeklyAvailableHours, 4);
const members = await call(owner, `${p}/members`);
assert(members.items.every(item => !('major' in item) && !('skills' in item) && !('hoursPerWeek' in item)), 'Project member API must not expose personal fields');
assert.equal((await call(member, '/auth/personal-profile/import-candidates')).items.length, 0);
const initialGoal = await call(owner, `${p}/goal`);
await call(member, `${p}/goal`, { method: 'PATCH', body: { expectedRevision: initialGoal.revision, title: 'Unauthorized' }, status: 403 });
const mainGoal = await call(owner, `${p}/goal`, { method: 'PATCH', body: { expectedRevision: initialGoal.revision, title: '完成本地真实接口验收' } });
assert.equal(mainGoal.title, '完成本地真实接口验收');
const task = await call(owner, `${p}/tasks`, { method: 'POST', body: { title: '真实协作任务', criteria: '提交可复核的固定版本成果', assigneeId: member.user.id }, status: 201 });
assert.equal(task.lifecycleState, 'in_progress');
const activeTask = await call(owner, `${p}/tasks/${task.taskId}`, { method: 'PATCH', body: { expectedRevision: task.revision, detail: '负责人补充交付说明' } });
await call(owner, `${p}/tasks/${task.taskId}`, { method: 'PATCH', body: { expectedRevision: task.revision, detail: '旧版本不能覆盖新说明' }, status: 409, code: 'VERSION_CONFLICT' });
await call(owner, `${p}/tasks/${task.taskId}`, { method: 'PATCH', body: { expectedRevision: activeTask.revision, status: 'done' }, status: 409, code: 'INVALID_STATE' });
await call(owner, `${p}/collaboration/tasks/${task.taskId}/assign`, { method: 'POST', body: { assigneeId: owner.user.id, expectedRevision: task.revision, reason: '核对版本冲突' }, status: 409, code: 'INVALID_STATE' });
const assigned = await call(owner, `${p}/collaboration/tasks/${task.taskId}/assign`, { method: 'POST', body: { assigneeId: owner.user.id, expectedRevision: activeTask.revision, reason: '负责人接手联调验证' } });
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
const attached = await call(owner, `${p}/materials/${material.materialId}`, { method: 'PUT', body: { expectedRevision: 2, doc, attachmentIds: [file.fileId] }, status: 201 });
assert.deepEqual(attached.attachments, [{ fileId: file.fileId, name: 'integration.txt' }]);
const detached = await call(owner, `${p}/materials/${material.materialId}`, { method: 'PUT', body: { expectedRevision: 3, doc, attachmentIds: [] }, status: 201 });
assert.deepEqual(detached.attachments, []);
assert.deepEqual((await call(member, `${p}/materials/${material.materialId}/versions/${attached.versionId}`)).attachments, attached.attachments);
const template = await call(owner, `${p}/materials`, { method: 'POST', body: { title: '作品介绍模板', kind: 'work-introduction' }, status: 201 });
assert.match(template.currentVersion.markdown, /实现与验证/);
await call(owner, `${p}/materials/${template.materialId}/versions/${attached.versionId}`, { status: 404, code: 'NOT_FOUND' });
assert.deepEqual((await call(member, `${p}/rehearsals`)).items, []);

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
const standards = await call(owner, `${p}/standards`, { method: 'POST', body: { title: '统一验收标准', requirements: [{ title: '可复核成果', detail: '提供已保存成果及真实验证记录', category: 'deliverable', dimensionKey: 'quality' }, { title: '提交日期', detail: '核对日期', category: 'deadline', dueDate: '2026-10-08', duePrecision: 'date' }], weights: [{ key: 'quality', label: '材料质量', weight: 100 }] }, status: 201 });
await call(member, `${p}/standards/${standards.standardsVersionId}/confirm`, { method: 'POST', body: { expectedRevision: standards.revision }, status: 403 });
const publishedStandard = await call(owner, `${p}/standards/${standards.standardsVersionId}/confirm`, { method: 'POST', body: { expectedRevision: standards.revision } });
assert.equal(publishedStandard.status, 'confirmed');
assert.equal(publishedStandard.requirements.length, 2);
const library = await call(owner, `${p}/resource-library`);
const background = library.items.find(item => item.purpose === 'background');
assert(background && background.resourceType === 'material' && background.currentVersionId, 'Project background must be a saved version');
const librarySource = library.items.find(item => item.resourceId === source.sourceId);
assert.equal(librarySource.purpose, 'reference');
const tagged = await call(owner, `${p}/resource-library/source/${source.sourceId}`, { method: 'PATCH', body: { expectedRevision: librarySource.revision, purpose: 'background' } });
assert.equal(tagged.currentVersionId, librarySource.currentVersionId, 'Purpose changes must preserve immutable source versions');
await call(owner, `${p}/resource-library/source/${source.sourceId}`, { method: 'PATCH', body: { expectedRevision: librarySource.revision, purpose: 'output' }, status: 409, code: 'VERSION_CONFLICT' });
const predecessor = await call(owner, `${p}/collaboration/tasks`, { method: 'POST', body: { title: '前置收集', detail: '保留未完成状态', criteria: '收集资料', effortHours: 1 }, status: 201 });
const successor = await call(owner, `${p}/collaboration/tasks`, { method: 'POST', body: { title: '提前提交验证', detail: '依赖仅提示', criteria: '保存材料', effortHours: 1 }, status: 201 });
const graphGoal = await call(owner, `${p}/goal`);
const dependency = await call(owner, `${p}/tasks/${successor.taskId}/dependencies`, { method: 'PUT', body: { expectedGraphRevision: graphGoal.graphRevision, dependsOnTaskIds: [predecessor.taskId] } });
assert.deepEqual(dependency.unfinishedDependencyIds, [predecessor.taskId]);
await call(owner, `${p}/tasks/${predecessor.taskId}/dependencies`, { method: 'PUT', body: { expectedGraphRevision: dependency.graphRevision, dependsOnTaskIds: [successor.taskId] }, status: 400, code: 'VALIDATION_FAILED' });
const claimedSuccessor = await call(owner, `${p}/collaboration/tasks/${successor.taskId}/claim`, { method: 'POST', body: { expectedRevision: successor.revision } });
const submission = await call(owner, `${p}/collaboration/tasks/${successor.taskId}/submissions`, { method: 'POST', body: { expectedRevision: claimedSuccessor.revision, body: '前置仍未完成，允许提前提交。', materialVersionIds: [version.versionId] }, status: 201 });
await call(owner, `${p}/collaboration/submissions/${submission.submissionId}/decide`, { method: 'POST', body: { expectedRevision: submission.revision, decision: 'accept', feedback: '已核对固定版本，提前完成允许验收。' } });
assert.equal((await call(owner, `${p}/tasks/${predecessor.taskId}`)).status, 'todo');
assert.equal((await call(owner, `${p}/tasks/${successor.taskId}`)).status, 'done');
assert(Array.isArray((await call(owner, `${p}/assessments`)).items));
if (!capabilities.features.aiEnabled) {
  const attempt = await call(owner, `${p}/assessments`, { method: 'POST', body: { kind: 'material_review', standardsVersionId: publishedStandard.standardsVersionId, materialVersionIds: [version.versionId] }, status: 202 });
  let record;
  for (let retry = 0; retry < 40; retry++) {
    record = await call(owner, `${p}/assessments/${attempt.assessmentId}`);
    if (record.status === 'failed' && record.jobError) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(record.status, 'failed', 'Disabled AI must leave an explicit failed assessment');
  assert.equal(record.report, null, 'Disabled AI must never produce simulated scores');
  assert(record.jobError, 'Failed assessments must expose failure and the job link');
  const failedJob = await call(owner, `/jobs/${attempt.jobId}`);
  assert.equal(failedJob.status, 'failed');
  assert(failedJob.error?.message, 'Failed job details must retain the actual error');
}
await call(owner, `${p}/decisions`, { method: 'POST', body: { title: '验证真实服务', detail: '本地 API 数据，不进入生产。' }, status: 201 });
const contribution = await call(member, `${p}/contributions`, { method: 'POST', body: { description: '完成联调验证' }, status: 201 });
await call(member, `${p}/contributions/${contribution.contributionId}/corrections`, { method: 'POST', body: { description: '补充材料协作验证' }, status: 201 });
await call(owner, `${p}/resources`, { method: 'POST', body: { kind: 'other', title: '联调测试资源' }, status: 201 });
const exported = await call(owner, `${p}/export-bundle`);
assert(Array.isArray(exported.requirementSets));
assert.equal(exported.rubricVersions.find(item => item.rubricId === rubric.rubricId)?.status, 'confirmed');
assert.equal(exported.mainGoal.title, mainGoal.title);
assert(exported.taskDependencies.some(edge => edge.taskId === successor.taskId && edge.dependsOnTaskId === predecessor.taskId));
assert(exported.taskSubmissions.some(item => item.submissionId === submission.submissionId));
assert(exported.standardsVersions.some(item => item.standardsVersionId === standards.standardsVersionId));
assert(exported.materialVersions.some(item => item.versionId === version.versionId));
assert(!JSON.stringify(exported).includes('本地验证专业'), 'Global profile values must not appear in project export');
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
