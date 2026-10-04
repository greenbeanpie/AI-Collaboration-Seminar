/** Local HTTP fixtures for manual/browser acceptance.
 * npm run build --prefix frontend
 * node scripts/serve-task-agent-fixture.mjs
 * http://127.0.0.1:5179/app/projects/fixture-project/tasks
 * No production requests or model calls. Only simulated eligibility POSTs.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';

const projectId = 'fixture-project';
const userId = 'fixture-member';
const now = '2026-10-03T09:00:00Z';
const task = { taskId: 'digital', title: '分析已有实地调研记录', detail: '根据已保存的记录整理分析报告', criteria: '给出可复现证据', effortHours: 4, revision: 1, assigneeId: userId, lifecycleState: 'in_progress', status: 'doing', dependsOnTaskIds: [], unfinishedDependencyIds: [], currentSubmissionId: null, citations: [], createdAt: now, updatedAt: now };
const tasks = [task, { ...task, taskId: 'field', title: 'Field research', detail: '分析现有调研资料，纯资料分析', criteria: '提供分析报告' }, { ...task, taskId: 'mixed', title: '完成任务 A', detail: '前往现场测量数据', criteria: '提交现场记录' }, { ...task, taskId: 'disabled', title: 'AI 服务关闭示例' }, { ...task, taskId: 'failed', title: '检查失败重试示例' }];
const verdicts = new Map();
const baseVerdict = id => ({ status: id === 'disabled' ? 'disabled' : 'missing', taskRevision: 1, sourceHash: `fixture-${id}`, eligible: null, reason: id === 'disabled' ? '当前 AI 服务未启用。' : null, jobId: null });
const root = resolve('frontend/dist');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1:5179').pathname;
  if (path.startsWith('/api/')) {
    const eligibility = path.match(/\/collaboration\/tasks\/([^/]+)\/agent-eligibility$/);
    if (eligibility && ['GET', 'POST'].includes(req.method)) {
      const id = eligibility[1];
      if (req.method === 'POST' && id !== 'disabled') {
        const previous = verdicts.get(id);
        verdicts.set(id, { ...baseVerdict(id), status: 'running', jobId: `fixture-job-${id}` });
        setTimeout(() => verdicts.set(id, id === 'failed' && previous?.status !== 'failed'
          ? { ...baseVerdict(id), status: 'failed', reason: '模拟 AI 检查失败，请手动重试。' }
          : { ...baseVerdict(id), status: 'ready', eligible: id !== 'mixed', reason: id === 'mixed' ? '该任务需要到现场测量，不能整项交由 AI 执行。' : '该任务可通过已有资料分析完成。', jobId: `fixture-job-${id}` }), 600);
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ data: verdicts.get(id) || baseVerdict(id), requestId: 'fixture' }));
    }
    if (req.method !== 'GET') { res.writeHead(405); return res.end('read-only fixture'); }
    let data = { items: [], nextCursor: null };
    if (path.endsWith('/auth/session')) data = { user: { id: userId, username: 'fixture', displayName: '测试成员', role: 'user', isAdmin: false } };
    else if (path.endsWith('/capabilities')) data = { features: { aiEnabled: false }, limits: { maxFileBytes: 20000000 }, competitionTemplate: {} };
    else if (path === `/api/v1/projects/${projectId}`) data = { projectId, name: 'AI 任务适用性验证', description: '本地固定测试数据', status: 'active', myRole: 'owner', revision: 1 };
    else if (path.endsWith('/members/me')) data = { userId, displayName: '测试成员', role: 'owner' };
    else if (path.endsWith('/members')) data = { items: [{ userId, displayName: '测试成员', role: 'owner' }], nextCursor: null };
    else if (path.endsWith('/goal')) data = { title: '交付研究报告', detail: '测试目标', revision: 1, graphRevision: 1 };
    else if (path.endsWith('/tasks')) data = { items: tasks, nextCursor: null };
    else if (path.endsWith('/collaboration/settings')) data = { aiCollaborationEnabled: false, assignmentMode: 'manual', evaluationMode: 'manual', revision: 1 };
    else if (path.endsWith('/collaboration/feedback/current')) data = { version: 0, feedback: '' };
    else if (path.endsWith('/standards/current')) data = { standard: null };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ data, requestId: 'fixture' }));
  }
  if (path === '/sw.js') { res.writeHead(404); return res.end(); }
  const file = resolve(root, '.' + path);
  if (!file.startsWith(root + '\\') && !file.startsWith(root + '/')) { res.writeHead(403); return res.end(); }
  try {
    const bytes = await readFile(path.startsWith('/assets/') || extname(path) ? file : resolve(root, 'index.html'));
    res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'text/html', 'Cache-Control': 'no-store' }); res.end(bytes);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(5179, '127.0.0.1', () => console.log('http://127.0.0.1:5179/app/projects/fixture-project/tasks'));
