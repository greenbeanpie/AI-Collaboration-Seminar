/** Explicit production acceptance; uses existing credentials and creates an isolated test project.
 * node scripts/verify-dsh-bridge-production.mjs --production --credentials-file <private-json>
 * Real deployed Workers/D1/R2 + shipped BridgeRunner; DSH adapter is simulated.
 * Never changes global AI configuration or retries a paid model job.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const usage = 'Usage: node scripts/verify-dsh-bridge-production.mjs --production --credentials-file <private-json>';
const args = process.argv.slice(2);
let production = false, credentialsFile;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--production') production = true;
  else if (['--credentials-file', '--credentialsFile'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) credentialsFile = args[++i];
  else { console.error(usage); process.exit(2); }
}
if (!production || !credentialsFile) { console.error(usage); process.exit(2); }

const origin = 'https://greenbp-team-office.hddhp.workers.dev';
const root = fileURLToPath(new URL('../', import.meta.url));
const runId = randomUUID(), output = join(root, 'output', 'dsh-bridge-production', runId);
// Evidence and runner filesystem state must never enter Git.
try { execFileSync('git', ['check-ignore', '--quiet', relative(root, output)], { cwd: root, stdio: 'ignore', windowsHide: true }); }
catch { console.error('Refusing verification: output directory is not ignored by Git.'); process.exit(2); }
try { await mkdir(output, { recursive: true }); }
catch { console.error('Refusing verification: evidence storage could not be created.'); process.exit(2); }
const sha = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
const report = {
  runId, origin, mode: 'production', startedAt: new Date().toISOString(), passed: false,
  infrastructure: 'deployed Workers, D1 and R2', actualPluginRunner: true,
  dshAdapter: 'simulated; this verifier does not execute a native DSH model',
  nativeDshVerification: 'separate native RC2 verification; not asserted by this script',
  globalAiConfigurationChanged: false, semanticCheckRequests: 0, semanticJobsRetried: 0,
  usagePolicy: { semanticJobDispatchLimit: 1, semanticReservationMaxCalls: 2, paidJobRetries: 0, normalAdoptionMayAddOneEvaluationJob: true },
  normalEvaluation: 'Reviewed adoption may enqueue one normal evaluation even with manual project mode; this verifier never retries it.',
  checks: [], cleanup: [],
};
let phase = 'load-private-credentials', cookie, projectId, taskId, taskRevision, deviceId, handoffId, pendingJobId;
let cloud, runner, journal, mainPassed = false;
const reportPath = join(output, 'verification.json');
const writeReport = async () => {
  try { await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 }); }
  catch { throw new VerificationError('EVIDENCE_WRITE_FAILED'); }
};
const record = name => report.checks.push({ name, passed: true });
class VerificationError extends Error {
  constructor(code, status = null) { super(code); this.code = code; this.status = status; }
}
function diagnostic(error, at = phase) {
  return {
    phase: at,
    code: /^[A-Z][A-Z0-9_]{0,60}$/.test(error?.code || '') ? error.code : 'VERIFICATION_FAILED',
    httpStatus: Number.isInteger(error?.status) ? error.status : null,
    ...(pendingJobId ? { pendingJobId } : {}),
    ...(report.lastHandoffState ? { handoffState: report.lastHandoffState } : {}),
    ...(report.eligibility?.status ? { eligibilityState: report.eligibility.status } : {}),
  };
}
function trustedUrl(path) {
  const url = new URL('/api/v1' + path, origin);
  if (url.origin !== origin || !url.pathname.startsWith('/api/v1/')) throw new VerificationError('UNTRUSTED_ENDPOINT');
  return url;
}
async function response(path, method = 'GET', body, options = {}) {
  const attempts = method === 'GET' && options.retry !== false ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let res;
    try {
      res = await fetch(trustedUrl(path), {
        method, redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? 12000),
        headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(options.key ? { 'Idempotency-Key': options.key } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      if (attempt + 1 < attempts) { await sleep(500 * 2 ** attempt); continue; }
      throw new VerificationError(method === 'GET' ? 'NETWORK_READ_FAILED' : 'WRITE_DISPATCH_UNCERTAIN');
    }
    if ([429, 500, 502, 503, 504].includes(res.status) && attempt + 1 < attempts) {
      await res.body?.cancel(); await sleep(500 * 2 ** attempt); continue;
    }
    return res;
  }
  throw new VerificationError('NETWORK_READ_FAILED');
}
async function api(path, method = 'GET', body, expected = 200, options = {}) {
  const res = await response(path, method, body, options);
  let envelope; try { envelope = await res.json(); } catch { throw new VerificationError('INVALID_API_RESPONSE', res.status); }
  if (res.status !== expected) throw new VerificationError(envelope.error?.code || 'UNEXPECTED_HTTP_STATUS', res.status);
  return envelope.data;
}
const browserBridge = (path, method = 'GET', body, expected = 200, options) => api('/agent-bridges' + path, method, body, expected, options);
async function observeJob(id) {
  try { const job = await api('/jobs/' + id); return { jobId: job.jobId, status: job.status, attempts: job.attempts }; }
  catch (error) { return { jobId: id, unavailable: diagnostic(error, 'observe-job') }; }
}

try {
  const saved = JSON.parse(await readFile(resolve(credentialsFile), 'utf8'));
  const accounts = [saved.acceptanceAccounts?.at(-1), saved.accounts?.production].filter(account => typeof account?.username === 'string' && typeof account?.password === 'string');
  assert(accounts.length > 0);
  // Import the exact shipped runner, before any project/device writes.
  const { Journal, CloudClient, BridgeRunner } = await import('../packages/dsh-team-office-bridge/src/runner.js');
  phase = 'existing-account-login';
  for (const account of accounts) {
    const res = await response('/auth/sessions', 'POST', { account: account.username, password: account.password });
    if (res.status === 401) continue;
    if (res.status !== 201) throw new VerificationError('LOGIN_FAILED', res.status);
    cookie = res.headers.get('set-cookie')?.split(';')[0]; assert(cookie);
    await res.body?.cancel(); break;
  }
  assert(cookie); const identity = await api('/auth/session'); report.userId = identity.user.id;
  record('Existing password account authenticates; no credential reset');
  phase = 'configured-model-preflight';
  assert.equal((await api('/capabilities')).features.aiEnabled, true);
  record('Existing global AI configuration is enabled and unchanged');

  phase = 'create-isolated-manual-project';
  const project = await api('/projects', 'POST', {
    name: 'DSH 桥接器生产验收 ' + new Date().toISOString(), description: '仅用于桥接器验收，任务和成果均为固定测试数据，不包含真实业务资料。',
    aiCollaborationEnabled: true, assignmentMode: 'manual', evaluationMode: 'manual', planningMode: 'manual', progressionMode: 'manual',
  }, 201, { key: 'bridge-verification-project-' + runId });
  projectId = report.projectId = project.id;
  const base = `/projects/${projectId}`;
  const settings = await api(base + '/collaboration/settings');
  assert.equal(settings.aiCollaborationEnabled, true);
  for (const field of ['assignmentMode', 'evaluationMode', 'planningMode', 'progressionMode']) assert.equal(settings[field], 'manual');
  const task = await api(base + '/collaboration/tasks', 'POST', {
    title: '计算给定数字并交付文本报告', detail: '仅使用本任务提供的数字 2、4、6、8，计算总和和平均值，输出中文 TXT 报告。无需访问现场、收集真实世界资料、联系他人或执行外部决策。', criteria: '报告给出总和20、平均值5和计算方法。', effortHours: 1,
  }, 201, { key: 'bridge-verification-task-' + runId });
  taskId = report.taskId = task.taskId;
  const assigned = await api(base + `/collaboration/tasks/${taskId}/assign`, 'POST', { expectedRevision: task.revision, assigneeId: report.userId, reason: '验收专用任务由测试项目负责人提交成果' });
  taskRevision = report.taskRevision = assigned.revision; assert.equal(assigned.assigneeId, report.userId); assert.equal(assigned.lifecycleState, 'in_progress');
  record('Isolated project uses manual modes and task is assigned to the account owner'); await writeReport();

  phase = 'device-pairing';
  const secret = randomBytes(32).toString('hex');
  cloud = new CloudClient(origin + '/api/v1/agent-bridges', secret, async (url, init) => {
    const target = new URL(url); assert.equal(target.origin, origin); assert(target.pathname.startsWith('/api/v1/agent-bridges/'));
    assert.equal(new Headers(init.headers).has('cookie'), false);
    return fetch(target, { ...init, redirect: 'error', signal: AbortSignal.any([init.signal, AbortSignal.timeout(15000)].filter(Boolean)) });
  });
  const pair = await cloud.request('pairings', 'POST', { credentialHash: sha(secret), deviceName: 'Production acceptance simulated DSH', bridgeVersion: '0.1.0', dshVersion: 'simulated-adapter' });
  deviceId = report.deviceId = pair.pairingId;
  const pairing = await browserBridge(`/pairings/${deviceId}`); assert.equal(pairing.status, 'pending'); assert(pairing.projects.some(p => p.projectId === projectId));
  await browserBridge(`/pairings/${deviceId}/approve`, 'POST', { projectIds: [projectId] });
  await cloud.request('device/workspaces', 'POST', { projectId, workspaceLabel: 'Acceptance' });
  assert.equal((await cloud.request('device')).projects.find(p => p.projectId === projectId).workspaceLabel, 'Acceptance');
  record('Hash-only pairing, browser project scopes and display-label mapping succeed');

  phase = 'single-semantic-check-handoff';
  const handoffPath = `/projects/${projectId}/tasks/${taskId}/handoffs`, dispatchKey = 'bridge-verification-handoff-' + runId;
  report.semanticCheckRequests = 1;
  let started;
  try { started = await browserBridge(handoffPath, 'POST', { expectedRevision: taskRevision, targetDeviceId: deviceId }, 202, { key: dispatchKey }); }
  catch (error) {
    // Recover an uncertain response by reading this isolated task; never resubmit a paid request.
    if (error.code !== 'WRITE_DISPATCH_UNCERTAIN') throw error;
    const existing = (await browserBridge(handoffPath)).items.filter(h => h.deviceId === deviceId);
    if (existing.length !== 1) throw error; started = existing[0];
  }
  handoffId = report.handoffId = started.handoffId; report.lastHandoffState = started.state;
  if (started.state === 'blocked') throw new VerificationError('HANDOFF_BLOCKED_BEFORE_MODEL');
  const eligibilityPath = base + `/collaboration/tasks/${taskId}/agent-eligibility`, deadline = Date.now() + 60000;
  let eligibility;
  do {
    const remaining = deadline - Date.now(); if (remaining <= 0) break;
    eligibility = await api(eligibilityPath, 'GET', undefined, 200, { retry: false, timeoutMs: Math.max(1, Math.min(10000, remaining)) });
    pendingJobId = eligibility.jobId;
    report.eligibility = { status: eligibility.status, eligible: eligibility.eligible, jobId: eligibility.jobId, taskRevision: eligibility.taskRevision };
    if (['ready', 'failed', 'disabled'].includes(eligibility.status)) break;
    await sleep(Math.min(2000, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  await writeReport();
  if (eligibility?.status !== 'ready') throw new VerificationError('SEMANTIC_CHECK_NOT_READY_WITHIN_60_SECONDS');
  assert.equal(eligibility.eligible, true); assert.equal(eligibility.taskRevision, taskRevision);
  report.semanticJob = await observeJob(eligibility.jobId); pendingJobId = undefined;
  started = await browserBridge(`/handoffs/${handoffId}`); report.lastHandoffState = started.state;
  assert.equal(started.state, 'waiting_device'); assert(started.snapshotHash);
  const again = await browserBridge(handoffPath, 'POST', { expectedRevision: taskRevision, targetDeviceId: deviceId }, 202, { key: dispatchKey });
  assert.equal(again.handoffId, handoffId); assert.equal((await api(eligibilityPath)).jobId, eligibility.jobId);
  record('One real semantic job allows the digital task; repeated dispatch reuses it without retry');

  phase = 'real-runner-deployed-draft-transport';
  journal = await new Journal(join(output, 'journal')).load();
  const workspace = join(output, 'workspace'); await mkdir(workspace, { recursive: true });
  journal.state.bindings[projectId] = { cwd: workspace, label: 'Acceptance' }; await journal.save();
  let completion, prompts = 0, events = [], releases = 0, cancellations = 0;
  const artifactText = 'DSH桥接器生产验收报告\n给定数字：2、4、6、8\n总和：20\n平均值：5\n方法：先求和，再除以数字个数4。\n本报告由验收用模拟DSH适配器生成，用于验证云端传输及成果流程。\n';
  const dsh = {
    create: async (_run, callback) => { completion = callback; }, attach: async () => {}, isLive: () => true,
    prompt: async run => {
      prompts++; assert.equal(run.id, handoffId); assert(run.prompt.includes('team_office_complete'));
      await writeFile(join(run.output, 'acceptance-report.txt'), artifactText, { mode: 0o600 });
      await completion({ summary: '验收用模拟适配器输出固定报告：总和20、平均值5。', paths: ['acceptance-report.txt'] });
      events = [{ seq: 1, type: 'user/message', data: { source: { rpcId: run.id } } }, { seq: 2, type: 'turn/end', data: { reason: { kind: 'completed' } } }];
      return { accepted: true };
    }, inspect: async () => ({ events }), cancel: async () => { cancellations++; }, release: () => { releases++; },
  };
  runner = new BridgeRunner({ journal, client: cloud, dsh });
  for (let attempt = 0; attempt < 5; attempt++) {
    try { await runner.tick(); }
    catch (error) {
      if (![429, 500, 502, 503, 504].includes(error.status) && !['TimeoutError', 'AbortError'].includes(error.name)) throw error;
      if (attempt === 4) throw error; await sleep(1000 * 2 ** Math.min(attempt, 2)); continue;
    }
    if (journal.state.runs[handoffId]?.state === 'ready_for_review') break;
  }
  const result = await browserBridge(`/handoffs/${handoffId}`); report.lastHandoffState = result.state;
  assert.equal(result.state, 'ready_for_review'); assert.equal(result.stale, false); assert.equal(result.result.artifacts.length, 1);
  assert.equal(prompts, 1); assert.equal(releases, 1);
  const localRun = journal.state.runs[handoffId];
  const snapshot = JSON.parse(await readFile(join(localRun.runDir, 'inputs', 'context', 'task.json'), 'utf8'));
  assert.equal(snapshot.title, task.title); assert(snapshot.detail.includes('2、4、6、8'));
  const artifact = result.result.artifacts[0];
  const download = await response(base + `/files/${artifact.fileId}/content`); assert.equal(download.status, 200);
  const bytes = Buffer.from(await download.arrayBuffer()); assert.equal(sha(bytes), artifact.sha256); assert.equal(bytes.length, artifact.sizeBytes); assert.equal(bytes.toString('utf8'), artifactText);
  report.artifact = { artifactId: artifact.artifactId, fileId: artifact.fileId, name: artifact.name, sizeBytes: artifact.sizeBytes, sha256: artifact.sha256 };
  const unchanged = (await api(base + '/collaboration/tasks')).items.find(t => t.taskId === taskId);
  assert.equal(unchanged.revision, taskRevision); assert.equal(unchanged.lifecycleState, 'in_progress');
  await runner.tick(); assert.equal(prompts, 1);
  record('Shipped runner claims fixed snapshot, uploads real R2 bytes and leaves task unchanged as a review draft');

  phase = 'reviewed-adoption-and-replay';
  const adoptionPath = `/handoffs/${handoffId}/adopt-and-submit`, adoptionBody = { expectedTaskRevision: taskRevision, reviewed: true };
  const adopted = await browserBridge(adoptionPath, 'POST', adoptionBody);
  const replay = await browserBridge(adoptionPath, 'POST', adoptionBody); assert.equal(replay.submissionId, adopted.submissionId);
  const submissions = (await api(base + `/collaboration/tasks/${taskId}/submissions`)).items;
  assert.equal(submissions.length, 1); assert.equal(submissions[0].submissionId, adopted.submissionId); assert.equal(adopted.materialVersionIds.length, 1);
  report.submissionId = adopted.submissionId; report.materialVersionIds = adopted.materialVersionIds;
  if (adopted.evaluationJobId) {
    const evaluationDeadline = Date.now() + 60000;
    do {
      report.normalEvaluationJob = await observeJob(adopted.evaluationJobId);
      if (!['queued', 'running'].includes(report.normalEvaluationJob.status)) break;
      await sleep(Math.min(2000, Math.max(0, evaluationDeadline - Date.now())));
    } while (Date.now() < evaluationDeadline);
  }
  if (adopted.evaluationError) report.normalEvaluationLimitation = 'The submission is durable but its normal AI evaluation could not start; no retry was issued.';
  const adoptedRun = await browserBridge(`/handoffs/${handoffId}`); assert.equal(adoptedRun.adoptedSubmissionId, adopted.submissionId); assert.equal(adoptedRun.stale, false);
  record('Human-reviewed adoption and replay create exactly one normal submission and material version');

  phase = 'revocation-stops-receiving';
  await browserBridge(`/devices/${deviceId}`, 'DELETE');
  assert.equal((await cloud.request('device')).revoked, true);
  let denied = false; try { await cloud.request('device/claim', 'POST', {}); } catch (error) { denied = error.status === 403; } assert(denied);
  await runner.tick(); assert.equal(prompts, 1);
  report.runner = { prompts, releases, cancellations, completionState: journal.state.runs[handoffId].state };
  record('Device revocation denies new claims and runner receives no additional execution');
  mainPassed = true;
} catch (error) {
  report.failure = diagnostic(error); process.exitCode = 1;
  if (pendingJobId) report.pendingSemanticJob = await observeJob(pendingJobId);
} finally {
  if (cookie && deviceId) {
    try {
      await browserBridge(`/devices/${deviceId}`, 'DELETE');
      if (runner) await runner.tick();
      report.cleanup.push({ name: 'device revoked and local active execution stopped', passed: true });
    } catch (error) { report.cleanup.push({ name: 'device revocation/local stop', passed: false, failure: diagnostic(error, 'cleanup-device') }); }
  }
  if (cookie && projectId) {
    try {
      // Archival invalidates model writes. Keep a still-running job intact instead of
      // turning cleanup into a false permission failure; never retry its paid work.
      if (['queued', 'running'].includes(report.normalEvaluationJob?.status) || pendingJobId) {
        report.cleanupLimitation = 'Test project retained because a model job is unfinished or uncertain; no archive or model retry issued.';
        throw new VerificationError('ACTIVE_JOB_PROJECT_RETAINED');
      }
      const current = await api(`/projects/${projectId}`);
      if (current.status !== 'archived') await api(`/projects/${projectId}`, 'PATCH', { expectedRevision: current.revision, status: 'archived' });
      assert.equal((await api(`/projects/${projectId}`)).status, 'archived');
      report.cleanup.push({ name: 'isolated test project archived with evidence retained', passed: true });
    } catch (error) { report.cleanup.push({ name: 'archive test project', passed: false, failure: diagnostic(error, 'cleanup-archive') }); }
  }
  if (cookie) {
    try { await api('/auth/session', 'DELETE'); await api('/auth/session', 'GET', undefined, 401); report.cleanup.push({ name: 'password session logged out', passed: true }); }
    catch (error) { report.cleanup.push({ name: 'logout', passed: false, failure: diagnostic(error, 'cleanup-logout') }); }
    cookie = undefined;
  }
  if (cloud) cloud.secret = '';
  report.passed = mainPassed && report.cleanup.every(item => item.passed);
  if (!report.passed) process.exitCode = 1;
  report.finishedAt = new Date().toISOString();
  try { await writeReport(); }
  catch { report.passed = false; report.evidenceWriteFailed = true; process.exitCode = 1; }
}
// Only this sanitized report and a repository-relative evidence path are printed.
console.log(JSON.stringify({ ...report, evidence: relative(root, reportPath).replaceAll('\\', '/') }, null, 2));
