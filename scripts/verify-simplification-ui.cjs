const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.UI_PLAYWRIGHT_PATH || 'playwright');

const root = path.resolve(__dirname, '..');
const base = new URL(process.env.UI_BASE || 'http://127.0.0.1:5184');
assert(['localhost', '127.0.0.1'].includes(base.hostname), 'This verification only runs against loopback');
const output = process.env.UI_OUTPUT || path.join(root, 'docs/evidence/project-simplification');
fs.mkdirSync(output, { recursive: true });
const credentials = JSON.parse(fs.readFileSync(process.env.UI_CREDENTIALS_PATH || path.join(root, '.local-secrets/admin-credentials.json'), 'utf8')).accounts.local;

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.UI_CHROMIUM_PATH, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let projectId;
  const screenshot = name => page.screenshot({ path: path.join(output, name), fullPage: true });
  const api = async (endpoint, method = 'GET', body) => {
    const response = await page.evaluate(async ({ endpoint, method, body }) => {
      const result = await fetch(`/api/v1${endpoint}`, { method, credentials: 'include', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: result.status, envelope: await result.json() };
    }, { endpoint, method, body });
    assert(response.status >= 200 && response.status < 300, `${method} ${endpoint}: ${response.status}`);
    return response.envelope.data;
  };
  try {
    await page.goto(new URL('/login', base).href, { waitUntil: 'networkidle' });
    await page.getByLabel(/账号|用户名或邮箱/).first().fill(credentials.username);
    await page.getByLabel('密码').fill(credentials.password);
    await page.getByRole('button', { name: '登录工作区', exact: true }).click();
    await page.waitForURL(/\/app$/);
    await page.goto(new URL('/app/projects/new', base).href);
    await page.getByRole('link', { name: /分步创建/ }).click();
    await page.getByLabel('项目名称').fill(`浏览器验收 ${Date.now()}`);
    await page.getByLabel('主目标（可选）').fill('交付可复核的项目成果');
    await page.getByLabel('项目说明').fill('本地浏览器验证背景：主目标、依赖任务、资料和评分在同一流程中保存。');
    await page.getByRole('button', { name: '下一步', exact: true }).click();
    await page.getByLabel('上传项目文件（可选）').waitFor();
    await page.getByRole('button', { name: '下一步', exact: true }).click();
    await page.getByLabel('组员总人数（含负责人）').waitFor();
    await page.getByRole('button', { name: '下一步', exact: true }).click();
    for (const [title, criteria] of [['资料收集', '保存可引用资料'], ['成果整理', '提交已保存成果版本']]) {
      await page.getByRole('button', { name: '添加手动任务', exact: true }).click();
      const card = page.locator('.wizard-task').last();
      await card.getByLabel('标题').fill(title);
      await card.getByLabel('验收标准').fill(criteria);
    }
    await page.locator('.wizard-task').last().getByRole('checkbox', { name: '资料收集' }).check();
    await page.getByRole('button', { name: '保存当前任务预览', exact: true }).click();
    await page.getByText('预览已保存：2 个任务。', { exact: false }).waitFor();
    await page.getByRole('button', { name: '进入创建预览', exact: true }).click();
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: '确认并创建项目', exact: true }).click();
    await page.getByRole('link', { name: '进入项目', exact: true }).click();
    await page.waitForURL(/\/app\/projects\/[a-f0-9-]+$/);
    projectId = new URL(page.url()).pathname.split('/').pop();
    const prefix = `/projects/${projectId}`;
    assert.equal((await api(`${prefix}/goal`)).title, '交付可复核的项目成果');
    const tasks = (await api(`${prefix}/tasks`)).items;
    assert.equal(tasks.length, 2, 'The main goal must not become another task');
    assert.deepEqual(tasks.find(task => task.title === '成果整理').dependsOnTaskIds, [tasks.find(task => task.title === '资料收集').taskId]);

    await page.goto(new URL(`/app/projects/${projectId}/tasks`, base).href, { waitUntil: 'networkidle' });
    for (const label of ['概览', '任务', '资料', '评分', '团队']) await page.locator('[aria-label="项目功能"] a').filter({ hasText: new RegExp(`^${label}$`) }).waitFor();
    await page.getByText('成果整理', { exact: false }).first().waitFor();
    await screenshot('01-tasks-desktop.png');
    await page.goto(new URL(`/app/projects/${projectId}/data`, base).href, { waitUntil: 'networkidle' });
    await page.getByText('项目背景', { exact: false }).first().waitFor();
    const originalBackground = (await api(`${prefix}/resource-library`)).items.find(item => item.purpose === 'background');
    await page.getByRole('button', { name: /项目背景/ }).first().click();
    const editor = page.locator('.tiptap.ProseMirror');
    await editor.waitFor();
    await editor.fill('本地浏览器验证背景。新增一条已验证的富文本版本。');
    const savedBackground = page.waitForResponse(response => response.url().includes(`/materials/${originalBackground.resourceId}`) && response.request().method() === 'PUT');
    await page.getByRole('button', { name: '保存新版本', exact: true }).click();
    assert.equal((await savedBackground).status(), 201);
    const backgroundNow = await api(`${prefix}/materials/${originalBackground.resourceId}`);
    assert.notEqual(backgroundNow.currentVersion.versionId, originalBackground.currentVersionId);
    assert((await api(`${prefix}/materials/${originalBackground.resourceId}/versions/${originalBackground.currentVersionId}`)).markdown.includes('本地浏览器验证背景：主目标'));
    await screenshot('02-resources-desktop.png');

    await page.goto(new URL(`/app/projects/${projectId}/assessment`, base).href, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '新建标准', exact: true }).click();
    await page.getByLabel('标准名称').fill('成果验收标准');
    await page.getByLabel('要求 1 标题').fill('成果可复核');
    await page.getByLabel('要求 1 说明').fill('记录验证过程并提供固定版本成果。');
    await page.getByLabel('此要求参与评分').check();
    await page.getByLabel('评分维度名称').fill('可复核性');
    await page.getByLabel('评分权重（%）').fill('100');
    await page.getByRole('button', { name: '保存标准草稿', exact: true }).click();
    await page.getByRole('button', { name: '确认并固定标准版本', exact: true }).click();
    await page.getByText('已确认 v1', { exact: false }).first().waitFor();
    await screenshot('03-standards-desktop.png');
    await page.getByRole('button', { name: '材料检查', exact: true }).click();
    await screenshot('04-assessment-desktop.png');
    await page.goto(new URL(`/app/projects/${projectId}/sources`, base).href, { waitUntil: 'networkidle' });
    assert.equal(new URL(page.url()).pathname, `/app/projects/${projectId}/data`, 'Old source link redirects to the common workspace');
    await page.goto(new URL(`/app/projects/${projectId}/reviews`, base).href, { waitUntil: 'networkidle' });
    assert.equal(new URL(page.url()).pathname, `/app/projects/${projectId}/assessment`);

    await page.goto(new URL('/app/profile', base).href, { waitUntil: 'networkidle' });
    const nextHours = (await api('/auth/personal-profile')).weeklyAvailableHours === 9 ? 8 : 9;
    await page.getByRole('button', { name: '编辑资料', exact: true }).click();
    const hours = page.getByLabel(/每周总可用时间/);
    await hours.fill(String(nextHours));
    await page.getByRole('button', { name: '保存资料与隐私', exact: true }).click();
    await page.getByRole('button', { name: '编辑资料', exact: true }).waitFor();
    assert.equal((await api('/auth/personal-profile')).weeklyAvailableHours, nextHours);
    await screenshot('05-global-profile.png');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(new URL(`/app/projects/${projectId}/tasks`, base).href, { waitUntil: 'networkidle' });
    await screenshot('06-tasks-mobile.png');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Mobile tasks must not overflow horizontally');
    await page.goto(new URL(`/app/projects/${projectId}/assessment`, base).href, { waitUntil: 'networkidle' });
    await screenshot('07-standards-mobile.png');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Mobile standards must not overflow horizontally');
    assert.deepEqual(errors, [], 'No unhandled browser runtime errors');
    const bundle = await api(`${prefix}/export-bundle`);
    assert.equal(bundle.mainGoal.title, '交付可复核的项目成果');
    assert.equal(bundle.taskDependencies.length, 1);
    assert.equal(bundle.standardsVersions.length, 1);
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ status: 'passed', projectId, createdAt: new Date().toISOString(), checks: ['password login', 'manual goal/dependency wizard', 'five project sections', 'versioned background', 'combined standards publish', 'old links', 'global weekly availability', 'mobile overflow', 'export graph/history'], browserErrors: errors }, null, 2));
    const project = await api(prefix);
    await api(prefix, 'PATCH', { expectedRevision: project.revision, status: 'archived' });
    console.log('PASS: real Edge desktop/mobile flows; wizard goal/dependencies, background, standards, profile, redirects and export. Screenshots saved; local QA project archived.');
  } catch (error) {
    await screenshot('error-state.png').catch(() => {});
    console.error(`UI verification failed at ${new URL(page.url()).pathname}: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
