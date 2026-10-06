// Real React + browser PDF/DOCX workers; API state is a loopback fixture, never production.
// NODE_PATH=<bundled node_modules> node scripts/verify-feedback-fixes-ui.cjs --serve
// NODE_PATH=<bundled node_modules> node scripts/verify-feedback-fixes-ui.cjs
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/feedback-fixes');
const origin = 'http://127.0.0.1:5199';
const apiOrigin = 'http://127.0.0.1:8799';
const now = '2026-10-06T04:00:00Z';
const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] };
const user = { id: 'u', username: 'fixture', displayName: '本地验收成员', role: 'user', isAdmin: false };
const standard = { standardsVersionId: 'std', title: '项目评分标准', version: 1, revision: 1, status: 'confirmed', requirements: [], mappings: [], rubric: { rubricVersionId: 'rubric', version: 1, weights: [{ key: 'quality', label: '成果质量', weight: 100 }], notes: '' }, createdAt: now };
let task, files, materials, submissions, writes;
const version = (file, revision = 1) => ({ versionId: `v-${file.fileId}-${revision}`, revision, doc: emptyDoc, markdown: '', attachments: [{ ...file, availability: 'available', contributors: [] }], origin: 'manual', createdAt: now });
function reset() {
  task = { taskId: 't', title: '反馈修复验收任务', detail: '完成实际成果', criteria: '核对成果与证据', revision: 1, assigneeId: 'u', status: 'doing', lifecycleState: 'in_progress', currentSubmissionId: null, dependsOnTaskIds: [], unfinishedDependencyIds: [], effortHours: 1, createdAt: now, updatedAt: now };
  files = []; materials = []; submissions = []; writes = [];
}
reset();
function addFile(file) {
  const currentVersion = version(file);
  const material = { materialId: `m-${file.fileId}`, title: file.name, kind: 'task-file', purpose: 'output', taskId: 't', revision: 1, currentVersionId: currentVersion.versionId, currentVersion, canEdit: true, canArchive: true, archivedAt: null, systemManaged: false, createdAt: now, updatedAt: now };
  materials.push(material);
  return material;
}
function taskFiles() {
  return materials.map(m => ({ materialId: m.materialId, fileId: m.currentVersion.attachments[0].fileId, name: m.title, versionId: m.currentVersionId, revision: m.revision, taskId: 't', archivedAt: null, materialArchivedAt: null, deletedAt: null, lifecycleVersion: 1, canManage: true }));
}
async function serve() {
  fs.mkdirSync(output, { recursive: true });
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([450, 600]).drawText('PDF PAGE ONE - submitted evidence', { x: 25, y: 550, size: 16, font });
  // Page two uses shapes alone, exercising scan/non-text preview.
  const scan = pdf.addPage([450, 600]); scan.drawRectangle({ x: 25, y: 450, width: 350, height: 100, color: rgb(0.2, 0.5, 0.8) });
  fs.writeFileSync(path.join(output, 'evidence.pdf'), await pdf.save());
  fs.copyFileSync(path.join(root, 'frontend/src/pages/__fixtures__/semantic.docx'), path.join(output, 'evidence.docx'));
  const server = createServer(async (req, res) => {
    try {
      const p = new URL(req.url, apiOrigin).pathname;
      if (p === '/__fixture/reset') { reset(); res.end('ok'); return; }
      if (p === '/__fixture/improve') { task.lifecycleState = 'improve'; task.revision++; res.end('ok'); return; }
      if (p === '/__fixture/state') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ task, submissions, writes })); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const body = bytes.length && req.headers['content-type']?.includes('application/json') ? JSON.parse(bytes) : {};
      let data = { items: [], nextCursor: null };
      if (req.method !== 'GET') writes.push({ method: req.method, path: p, ...(Object.keys(body).length ? { body } : {}) });
      const content = p.match(/\/files\/([^/]+)\/content$/);
      const multipart = p.match(/\/files\/([^/]+)\/uploads(?:\/session(?:\/parts\/\d+|\/complete)?)?$/);
      if (content) {
        const file = files.find(f => f.fileId === content[1]);
        if (!file) { res.writeHead(404); res.end('原文件不存在'); return; }
        if (req.method === 'PUT') { file.bytes = bytes; file.status = 'available'; data = { fileId: file.fileId, sizeBytes: bytes.length, mimeDetected: file.contentType }; }
        else { res.writeHead(200, { 'Content-Type': file.contentType, 'Cache-Control': 'no-store' }); res.end(file.bytes); return; }
      } else if (multipart) {
        const file = files.find(f => f.fileId === multipart[1]);
        if (p.endsWith('/uploads')) data = { sessionId: 'session', partBytes: 5242880 };
        else if (p.includes('/parts/')) { file.bytes = bytes; data = { partNumber: 1 }; }
        else if (p.endsWith('/complete')) { file.status = 'available'; data = { fileId: file.fileId }; }
        else data = { status: 'uploading', parts: [] };
      } else if (p === '/api/v1/auth/session') data = { user };
      else if (p === '/api/v1/capabilities') data = { environment: 'local', apiVersion: 'v1', features: { aiEnabled: false, webFetch: false }, limits: { maxFileBytes: 20000000, maxPdfPages: null, listMaxPageSize: 100 }, competitionTemplate: {} };
      else if (p === '/api/v1/projects/p') data = { projectId: 'p', name: '反馈修复本地验收', myRole: 'owner', status: 'active', revision: 1, createdAt: now, updatedAt: now };
      else if (p.endsWith('/members/me')) data = { userId: 'u', role: 'owner' };
      else if (p.endsWith('/members')) data = { items: [{ userId: 'u', displayName: user.displayName, role: 'owner' }], nextCursor: null };
      else if (p.endsWith('/goal')) data = { title: '反馈修复', detail: '', revision: 1, graphRevision: 1 };
      else if (p.endsWith('/collaboration/settings')) data = { aiCollaborationEnabled: false, assignmentMode: 'manual', evaluationMode: 'manual', revision: 1 };
      else if (p.endsWith('/collaboration/feedback/current')) data = { version: 0, feedback: '', versionId: null };
      else if (p.endsWith('/standards/current')) data = { standard };
      else if (p.endsWith('/standards')) data = { items: [standard] };
      else if (p.endsWith('/tasks/t') && req.method === 'PATCH') { assert.equal(body.expectedRevision, task.revision); Object.assign(task, body, { revision: task.revision + 1 }); data = task; }
      else if (p.endsWith('/tasks/t/files')) {
        if (req.method === 'POST') data = addFile(files.find(f => f.fileId === body.fileId));
        else data = { items: taskFiles() };
      } else if (p.endsWith('/tasks/t/submissions')) {
        if (req.method === 'POST') {
          assert.equal(body.expectedRevision, task.revision);
          data = { ...body, submissionId: `s${submissions.length + 1}`, taskId: 't', round: submissions.length + 1, submittedBy: 'u', criteria: task.criteria, status: 'pending', revision: 1, createdAt: now, evaluationJobId: null, evaluationAttempts: 0 };
          submissions.unshift(data); task.currentSubmissionId = data.submissionId; task.lifecycleState = 'submitted'; task.revision++;
        } else data = { items: submissions };
      } else if (p.endsWith('/tasks')) data = { items: [task], nextCursor: null };
      else if (p.endsWith('/files')) {
        if (req.method === 'POST') {
          const fileId = `f${files.length + 1}`; const file = { fileId, name: body.fileName, contentType: body.contentType, status: 'pending', lifecycleVersion: 1, archivedAt: null, deletedAt: null, canManage: true, createdAt: now }; files.push(file);
          data = { fileId, upload: { url: `/api/v1/projects/p/files/${fileId}/content`, method: 'PUT' } };
        } else data = { items: files.map(({ bytes: _bytes, ...file }) => file), nextCursor: null };
      } else if (p.endsWith('/resource-library')) data = { items: materials.map(m => ({ resourceType: 'material', resourceId: m.materialId, title: m.title, purpose: 'output', taskId: 't', fileId: m.currentVersion.attachments[0].fileId, revision: m.revision, currentVersionId: m.currentVersionId, canManage: true, updatedAt: now })), nextCursor: null };
      else if (p.endsWith('/materials')) data = { items: materials, nextCursor: null };
      else if (p.includes('/materials/')) {
        const id = p.split('/materials/')[1].split('/')[0]; const material = materials.find(m => m.materialId === id);
        data = p.endsWith('/versions') ? { items: [material.currentVersion], nextCursor: null } : p.includes('/versions/') ? material.currentVersion : material;
      }
      res.writeHead(req.method === 'POST' && p.endsWith('/submissions') ? 201 : 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data, requestId: 'feedback-fixture' }));
    } catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'FIXTURE_FAILURE', message: error.message }, requestId: 'fixture' })); }
  });
  server.listen(8799, '127.0.0.1');
  const vite = spawn(process.execPath, [path.join(root, 'frontend/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5199'], { cwd: path.join(root, 'frontend'), env: { ...process.env, AI_OFFICE_API_TARGET: apiOrigin }, stdio: 'inherit' });
  const stop = () => { vite.kill(); server.close(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
async function verify() {
  const { chromium } = require(process.env.UI_PLAYWRIGHT_PATH || 'playwright');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UI_CHROMIUM_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const report = { boundary: 'Loopback API fixture + real React, PDF.js and DOCX worker; no production writes', checks: [], errors: [] };
  try {
    for (const width of [1440, 390]) {
      await fetch(apiOrigin + '/__fixture/reset', { method: 'POST' });
      const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
      const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', e => report.errors.push(e.message));
      await page.goto(origin + '/app/projects/p/tasks');
      await page.getByRole('button', { name: '任务设置', exact: true }).click();
      await page.getByRole('button', { name: '修改任务内容' }).click();
      await page.getByRole('textbox', { name: '验收标准', exact: true }).fill('修改后只需填写成果说明即可提交');
      await page.getByRole('button', { name: '关闭', exact: true }).click();
      await page.getByRole('button', { name: '查看与提交', exact: true }).click();
      await page.getByRole('textbox', { name: '成果说明', exact: true }).fill('纯文字成果，无需附件');
      await page.getByRole('button', { name: '提交本轮成果' }).click();
      await page.locator('.collab-history').getByText('纯文字成果，无需附件', { exact: true }).waitFor({ state: 'attached' });
      const state = await (await fetch(apiOrigin + '/__fixture/state')).json();
      assert.equal(state.submissions.length, 1); assert.deepEqual(state.submissions[0].materialVersionIds, []); assert.equal(state.submissions[0].expectedRevision, 2);
      report.checks.push({ width, textOnlyAfterTaskEdit: 'passed' });
      await fetch(apiOrigin + '/__fixture/improve', { method: 'POST' });
      await page.reload();
      await page.getByRole('textbox', { name: '成果说明', exact: true }).waitFor();
      await page.locator('.task-file-uploads input[multiple]').setInputFiles([path.join(output, 'evidence.pdf'), path.join(output, 'evidence.docx')]);
      await page.getByRole('link', { name: 'evidence.docx', exact: true }).waitFor();
      await page.getByRole('textbox', { name: '成果说明', exact: true }).fill('第二轮提交 PDF 与 DOCX 文件');
      await page.getByRole('button', { name: '提交本轮成果' }).click();
      await page.locator('.collab-history').getByText('第二轮提交 PDF 与 DOCX 文件', { exact: true }).waitFor({ state: 'attached' });
      const uploaded = await (await fetch(apiOrigin + '/__fixture/state')).json();
      assert.equal(uploaded.submissions.length, 2); assert.equal(uploaded.submissions[0].materialVersionIds.length, 2);
      await page.goto(origin + '/app/projects/p/data?resourceType=material&resourceId=m-f1');
      await page.locator('canvas').waitFor();
      await page.locator('canvas').waitFor({ state: 'visible' });
      await page.screenshot({ path: path.join(output, `pdf-${width}.png`), fullPage: true });
      // Labels are kept semantic so the script verifies visible controls.
      await page.getByRole('navigation', { name: 'PDF 预览翻页' }).getByRole('button', { name: '下一页', exact: true }).click();
      await page.getByRole('img', { name: 'PDF 第 2 页' }).waitFor({ state: 'visible' });
      await page.screenshot({ path: path.join(output, `pdf-scan-${width}.png`), fullPage: true });
      await page.goto(origin + '/app/projects/p/data?resourceType=material&resourceId=m-f2');
      await page.locator('.file-preview-text').getByText('Chapter', { exact: true }).waitFor();
      assert.equal(await page.locator('.file-preview-text script').count(), 0);
      assert(await page.getByRole('list', { name: '文档读取提示' }).isVisible());
      await page.screenshot({ path: path.join(output, `docx-${width}.png`), fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      report.checks.push({ width, uploadSubmitPdfDocxPreview: 'passed' });
      await page.goto(origin + '/app/projects/p/assessment?section=standards');
      const revision = page.getByRole('button', { name: '修订生效标准' }); await revision.waitFor();
      assert.equal(await revision.count(), 1);
      const bounds = await revision.evaluate(el => ({ button: el.getBoundingClientRect().bottom, content: document.querySelector('.section-card article').getBoundingClientRect().top, header: Boolean(el.closest('.section-head')) }));
      assert(bounds.header && bounds.button <= bounds.content);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: path.join(output, `standards-${width}.png`), fullPage: true });
      report.checks.push({ width, standardButtonAboveContent: 'passed', bounds });
      await context.close();
    }
    assert.deepEqual(report.errors, []);
    report.status = 'passed';
  } finally { fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2)); await browser.close(); }
  console.log(JSON.stringify(report, null, 2));
}
(process.argv.includes('--serve') ? serve() : verify()).catch(e => { console.error(e); process.exitCode = 1; });
