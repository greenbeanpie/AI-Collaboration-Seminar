/** Production acceptance uses existing configured models and a new test project.
 * node scripts/verify-task-agent-eligibility-production.mjs --preflight
 * node scripts/verify-task-agent-eligibility-production.mjs --production
 * Reads existing private credentials; never creates or resets credentials.
 * API writes/model calls occur only with --production (preflight only logs in).
 */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const production = process.argv.includes('--production');
assert(production || process.argv.includes('--preflight'), 'Pass --preflight or --production explicitly');
const privatePath = process.env.ELIGIBILITY_CREDENTIALS_FILE || resolve('.local-secrets/admin-credentials.json');
const saved = JSON.parse(await readFile(privatePath, 'utf8'));
const accounts = [saved.acceptanceAccounts?.at(-1), saved.accounts?.production].filter(Boolean);
const origin = 'https://greenbp-team-office.hddhp.workers.dev';
const output = resolve('output/task-agent-eligibility-production');
await mkdir(output, { recursive: true });
const report = { origin, startedAt: new Date().toISOString(), mode: production ? 'production' : 'preflight', checks: [], tasks: [], modelCalled: false, passed: false };
let cookie;
let project;
let pendingJob;

async function api(path, method = 'GET', body, expected = 200) {
  const response = await fetch(origin + '/api/v1' + path, {
    method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method === 'GET' ? {} : { 'Idempotency-Key': randomUUID() }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const envelope = await response.json();
  assert.equal(response.status, expected, `${method} ${path}: status ${response.status}; code ${envelope.error?.code || ''}`);
  return envelope.data;
}
const record = name => report.checks.push({ name, passed: true });
const writeReport = () => writeFile(resolve(output, `${report.mode}-results.json`), JSON.stringify(report, null, 2));

try {
  for (const account of accounts) {
    const response = await fetch(origin + '/api/v1/auth/sessions', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ account: account.username, password: account.password }) });
    if (response.status === 401) continue;
    assert.equal(response.status, 201, 'Saved account login failed');
    cookie = response.headers.get('set-cookie')?.split(';')[0];
    assert(cookie, 'Missing session cookie');
    break;
  }
  assert(cookie, 'Saved credentials rejected; no reset attempted');
  record('existing saved account authenticates');
  const capabilities = await api('/capabilities');
  assert.equal(capabilities.features.aiEnabled, true); record('configured AI model is enabled');
  if (production) {
    project = await api('/projects', 'POST', { name: `AI 任务适用性验收 ${new Date().toISOString()}`, description: '自动化验收专用项目，不包含真实业务资料。', aiCollaborationEnabled: false }, 201);
    report.projectId = project.id;
    const base = `/projects/${project.id}`;
    const settings = await api(base + '/collaboration/settings');
    await api(base + '/collaboration/settings', 'PATCH', { expectedRevision: settings.revision, aiCollaborationEnabled: true, assignmentMode: 'manual', evaluationMode: 'manual', planningMode: 'manual', progressionMode: 'manual' });
    record('new isolated test project uses manual collaboration');
    await writeReport();
    const cases = [
      { title: 'Field research 资料分析', detail: '只使用用户已经提供的调查 CSV 和访谈转录文件，统计数据并撰写总结。无需前往现场、接触被访者或生成新的真实观察。', criteria: '交付可复现的分析脚本和总结报告。', expected: true },
      { title: '了解社区居民的生活情况', detail: '预约三名居民，明天亲自到他们家里交谈并记录现场观察，取得本轮真实的一手情况。', criteria: '交付本人现场获得的观察记录和访谈原始记录。', expected: false },
      { title: '整理资料并补充真实观察', detail: '先总结已有文档，然后亲自前往市场观察交易并拍摄当前现场照片。', criteria: '总结报告必须包含这次真实观察和现场照片。', expected: false },
    ];
    for (const sample of cases) {
      const goal = await api(base + '/goal');
      const task = await api(base + '/tasks', 'POST', { title: sample.title, detail: sample.detail, criteria: sample.criteria, effortHours: 1, dependsOnTaskIds: [], expectedGraphRevision: goal.graphRevision }, 201);
      const path = base + `/collaboration/tasks/${task.taskId}/agent-eligibility`;
      const initial = await api(path); assert.equal(initial.status, 'missing'); assert.equal(initial.eligible, null);
      const started = await api(path, 'POST', { expectedRevision: task.revision });
      assert(started.jobId); pendingJob = started.jobId; report.modelCalled = true;
      const repeated = await api(path, 'POST', { expectedRevision: task.revision }); assert.equal(repeated.jobId, started.jobId);
      const deadline = Date.now() + 60_000;
      let result = repeated;
      while (['queued', 'running'].includes(result.status) && Date.now() < deadline) {
        await new Promise(resolveWait => setTimeout(resolveWait, 2000)); result = await api(path);
      }
      report.tasks.push({ taskId: task.taskId, title: sample.title, expected: sample.expected, result });
      await writeReport();
      assert.equal(result.status, 'ready', 'Check did not complete within one minute; do not resubmit a paid job');
      pendingJob = undefined;
      assert.equal(result.eligible, sample.expected, 'Semantic decision disagrees with capability test');
      assert(result.reason?.trim()); assert.equal(result.taskRevision, task.revision);
      const cached = await api(path, 'POST', { expectedRevision: task.revision }); assert.equal(cached.jobId, started.jobId);
      record(`semantic model verdict and cached repeated request: ${sample.expected ? 'digital work allowed' : 'human step blocked'}`);
      if (sample.expected) {
        const changed = await api(base + `/collaboration/tasks/${task.taskId}`, 'PATCH', { expectedRevision: task.revision, detail: sample.detail + '增加新的分析维度。' });
        const invalidated = await api(path); assert.equal(invalidated.status, 'missing'); assert.equal(invalidated.eligible, null); assert.equal(invalidated.taskRevision, changed.revision);
        await api(path, 'POST', { expectedRevision: task.revision }, 409);
        record('editing task invalidates old verdict and stale revision POST is rejected');
      }
    }
    const currentSettings = await api(base + '/collaboration/settings');
    await api(base + '/collaboration/settings', 'PATCH', { expectedRevision: currentSettings.revision, aiCollaborationEnabled: false });
    record('test project AI disabled after acceptance');
  }
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : 'Verification failed';
  if (pendingJob) report.pendingJobId = pendingJob;
  process.exitCode = 1;
} finally {
  if (cookie && project && !pendingJob) {
    try {
      const current = await api(`/projects/${project.id}`);
      await api(`/projects/${project.id}`, 'PATCH', { expectedRevision: current.revision, status: 'archived' });
      record('test project archived without removing evidence');
    } catch { report.cleanupLimitation = 'Test project could not be archived; evidence retained'; }
  }
  if (cookie) { try { await api('/auth/session', 'DELETE'); } catch { /* Login expires normally. */ } }
  report.finishedAt = new Date().toISOString(); await writeReport();
}
console.log(JSON.stringify(report, null, 2));
