import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// DEBUG-only client targets this fixed loopback. All identities and content are synthetic.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../artifacts/smoke');
fs.mkdirSync(root, { recursive: true });
const account = '00000000-0000-4000-8000-000000000001';
const project = '00000000-0000-4000-8000-000000000002';
const taskId = '00000000-0000-4000-8000-000000000003';
const materialId = '00000000-0000-4000-8000-000000000004';
const versionId = '00000000-0000-4000-8000-000000000005';
const user = { id: account, username: 'native-fixture', displayName: '本机验收账号', role: 'super_admin', isAdmin: true };
const task = { taskId, title: '核对原生客户端离线协作', detail: '保存草稿，重新打开，并确认同步不会重复执行。', criteria: '本机数据完整、版本冲突可核对', effortHours: 2, revision: 1, status: 'todo', lifecycleState: 'open', assigneeId: null, dueDate: null, duePrecision: 'unknown', dependsOnTaskIds: [], unfinishedDependencyIds: [] };
const doc = { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '原生文档验收' }] }, { type: 'paragraph', content: [{ type: 'text', text: '这份资料仅存在于本机测试服务，不包含真实项目或账号数据。', marks: [{ type: 'bold' }] }] }, { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '离线草稿' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '保留原始结构' }] }] }] }] }, { type: 'fixtureUnknownNode', attrs: { identity: 'preserve-me' } }] };
const version = { versionId, materialId, revision: 1, doc, attachments: [], createdAt: new Date().toISOString() };
const material = { materialId, title: '项目验证记录', revision: 1, currentVersionId: versionId, currentVersion: version, canEdit: true, canArchive: true, archivedAt: null };
const projectRow = { id: project, name: '原生协作验收项目', description: '独立的本机合成数据，用于检查 Windows 界面、草稿和离线流程。', myRole: 'owner', status: 'active', revision: 1, deadlineDate: null, deadlinePrecision: 'unknown', createdAt: new Date().toISOString() };
const logs = []; const saved = new Map(); let networkOff = false;
const list = items => ({ items, nextCursor: null });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:5188');
  const json = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (url.pathname === '/__fixture/requests') return json(200, logs);
  if (url.pathname === '/__fixture/offline') { networkOff = url.searchParams.get('on') !== 'false'; return json(200, { networkOff }); }
  if (networkOff) { req.socket.destroy(); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
  logs.push({ method: req.method, path: req.url, body, key: req.headers['idempotency-key'] });
  fs.writeFileSync(path.join(root, 'requests.json'), JSON.stringify(logs, null, 2));
  const p = url.pathname.replace('/api/v1', ''); const base = '/projects/' + project;
  let data;
  if (p === '/auth/session') data = req.method === 'DELETE' ? { revoked: true } : { user };
  else if (p === '/capabilities') data = { aiConfigured: false, nativeAuth: true };
  else if (p === '/projects') data = list([projectRow]);
  else if (p === base) data = projectRow;
  else if (p === base + '/members/me') data = { userId: account, role: 'owner', permissions: { taskManage: true, taskClaim: true, taskSubmit: true, materialEdit: true, scoreInitiate: true, teamManage: true, projectManage: true } };
  else if (p === base + '/members') data = list([{ userId: account, displayName: user.displayName, role: 'owner' }]);
  else if (p === base + '/goal') data = { title: '确保原生客户端可用且可验证', detail: '完成代表场景，并保留尚未验证的边界。', revision: 1, graphRevision: 1 };
  else if (p === base + '/tasks/graph') data = { ...list([task]), graphRevision: 1, totals: { total: 1, todo: 1, done: 0 }, edges: [], memberIds: [account] };
  else if (p === base + '/tasks') data = list([task]);
  else if (p === base + '/tasks/' + taskId) data = task;
  else if (p === base + '/resource-library') data = list([{ resourceType: 'material', resourceId: materialId, title: material.title, updatedAt: new Date().toISOString() }]);
  else if (p === base + '/resource-library/material/' + materialId) data = { resourceType: 'material', resourceId: materialId, title: material.title, contributors: [], purpose: 'output' };
  else if (p === base + '/materials') data = list([material]);
  else if (p === base + '/materials/' + materialId) data = material;
  else if (p === base + '/materials/' + materialId + '/versions') data = list([version]);
  else if (p === base + '/materials/' + materialId + '/versions/' + versionId) data = version;
  else if (p === base + '/offline-sync' && req.method === 'POST') {
    const key = req.headers['idempotency-key'];
    if (!saved.has(key)) {
      if (body.tail.startsWith('materials/')) { material.revision++; version.revision++; version.doc = body.body.doc; }
      else if (body.tail.startsWith('tasks/')) Object.assign(task, body.body, { revision: task.revision + 1 });
      saved.set(key, body.tail.startsWith('materials/') ? version : task);
    }
    data = saved.get(key);
  }
  else if (p === '/notifications/settings') data = { pushEnabled: false };
  else if (p === '/notifications') data = list([]);
  else if (p === '/auth/personal-profile') data = { revision: 1, displayName: user.displayName, bio: '', visibility: 'private', aiConsent: false };
  else if (p === '/account/agent-bridges') data = list([]);
  else if (/\/(?:sources|files|submissions|comments|standards|assessments|rehearsals|requirement-sets|events|ai-chat|agent-sessions|inquiries|invitation-requests)$/.test(p)) data = list([]);
  else return json(404, { error: { code: 'FIXTURE_NOT_IMPLEMENTED', message: '本机验收未实现此接口：' + p } });
  json(200, { data, requestId: 'local-fixture' });
});
server.listen(5188, '127.0.0.1', () => console.log('Synthetic native fixture http://127.0.0.1:5188 · no production requests'));
