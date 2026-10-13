// Loopback-only production-build fixture for browser loading/offline acceptance.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const userId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const taskId = '33333333-3333-4333-8333-333333333333';
const materialId = '44444444-4444-4444-8444-444444444444';
const versionId = '55555555-5555-4555-8555-555555555555';
const now = new Date().toISOString();
const permissions = { teamManage: true, taskManage: true, resourceManage: true, scoreInitiate: true, scoreCorrect: true };
const user = { id: userId, displayName: '离线测试用户', username: 'offline-test', email: null, isAdmin: false, role: 'user' };
const project = { id: projectId, name: '离线验收项目', description: '本机夹具，无生产数据', status: 'active', myRole: 'owner', permissions, revision: 1, deadlineDate: null, deadlinePrecision: 'unknown' };
const task = { taskId, projectId, title: '缓存任务', detail: '', criteria: '核对正文', effortHours: 1, assigneeId: userId, status: 'doing', lifecycleState: 'in_progress', revision: 1, currentSubmissionId: null, parentTaskId: null, dueDate: null, duePrecision: 'unknown', dependsOnTaskIds: [], unfinishedDependencyIds: [], createdAt: now, updatedAt: now };
const tasks = [task];
let material = { materialId, title: '离线材料', kind: 'document', purpose: 'output', revision: 1, canEdit: true, currentVersionId: versionId, createdAt: now, updatedAt: now,
  currentVersion: { versionId, revision: 1, doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '联网缓存正文' }] }] }, markdown: '联网缓存正文', attachments: [], createdAt: now } };
const reads = {}, writes = [];
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const endpoint = url.pathname, base = `/api/v1/projects/${projectId}`;
    if (endpoint === '/__fixture/state') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ reads, writes, tasks, material })); return; }
    if (endpoint.startsWith('/api/v1/')) {
      reads[endpoint] = (reads[endpoint] ?? 0) + 1;
      let data = { items: [], nextCursor: null };
      if (endpoint === '/api/v1/auth/session') data = { user };
      else if (endpoint === '/api/v1/capabilities') data = { apiVersion: 'v1', environment: 'local', features: { aiEnabled: false }, limits: {}, authentication: { passwordEnabled: true, turnstileRequired: false } };
      else if (endpoint === '/api/v1/projects') data = { items: [project], nextCursor: null };
      else if (endpoint === base) data = project;
      else if (endpoint.endsWith('/members/me')) data = { userId, role: 'owner', permissions };
      else if (endpoint.endsWith('/members')) data = { items: [{ userId, displayName: user.displayName, role: 'owner' }], nextCursor: null };
      else if (endpoint.endsWith('/goal')) data = { projectId, title: '离线可打开', detail: '刷新后仍可工作', revision: 1, graphRevision: 1 };
      else if (endpoint.endsWith('/collaboration/settings')) data = { aiCollaborationEnabled: false, assignmentMode: 'manual', evaluationMode: 'manual', planningMode: 'manual', progressionMode: 'manual', revision: 1 };
      else if (endpoint.endsWith('/tasks')) data = { items: tasks, nextCursor: null };
      else if (endpoint.endsWith('/tasks/graph')) data = { graphRevision: 1, canRegenerate: false, totals: { total: tasks.length, done: 0 }, items: tasks, dependencies: [] };
      else if (endpoint.endsWith(`/tasks/${taskId}`)) data = task;
      else if (endpoint.endsWith('/materials')) data = { items: [material], nextCursor: null };
      else if (endpoint.endsWith(`/materials/${materialId}`)) data = material;
      else if (endpoint.endsWith('/versions')) data = { items: [material.currentVersion], nextCursor: null };
      else if (endpoint.endsWith('/resource-library')) data = { items: [{ resourceType: 'material', resourceId: materialId, title: material.title, purpose: 'output', currentVersionId: material.currentVersionId, revision: material.revision, createdAt: now, updatedAt: now, deletedAt: null, lifecycleVersion: 1, fileId: null, canManage: true }], nextCursor: null };
      else if (endpoint.includes('/collaboration/feedback')) data = { version: 0, feedback: '', history: [] };
      if (req.method !== 'GET') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        if (!endpoint.endsWith('/offline-sync')) throw new Error('Only queued writes are supported by this fixture');
        const key = req.headers['idempotency-key'];
        const previous = writes.find(row => row.key === key && key);
        if (previous) data = previous.data;
        else {
          if (input.tail.endsWith('/tasks') || input.tail === 'tasks') { data = { ...task, ...input.body, taskId: '77777777-7777-4777-8777-777777777777' }; tasks.push(data); }
          else if (input.tail === `materials/${materialId}`) {
            data = { ...material.currentVersion, ...input.body, revision: material.revision + 1 };
            material = { ...material, revision: data.revision, currentVersion: data };
          } else throw new Error('Unsupported fixture write');
          writes.push({ key, tail: input.tail, data });
        }
      }
      const etag = '"' + createHash('sha256').update(JSON.stringify(data)).digest('hex') + '"';
      res.writeHead(req.headers['if-none-match'] === etag ? 304 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ETag: etag });
      res.end(req.headers['if-none-match'] === etag ? undefined : JSON.stringify({ data, requestId: 'pwa-audit-fixture' })); return;
    }
    const route = endpoint === '/' || /^\/app(?:\/|$)/.test(endpoint) || endpoint === '/login' ? 'index.html' : decodeURIComponent(endpoint.slice(1));
    const file = path.resolve(dist, route);
    if (!file.startsWith(dist)) { res.writeHead(403); res.end(); return; }
    const bytes = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(bytes);
  } catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'FIXTURE', message: error.message } })); }
});
server.listen(Number(process.env.PWA_AUDIT_PORT ?? 5186), '127.0.0.1', () => console.log('PWA audit fixture listening on loopback port ' + server.address().port));
