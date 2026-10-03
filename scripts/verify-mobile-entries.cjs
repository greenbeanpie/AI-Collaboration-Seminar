// Navigation/entry checks only. Local fixtures, GET-only API, no business execution.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.UI_PLAYWRIGHT_PATH || 'playwright');
const { fixture } = require('./mobile-entry-fixtures.cjs');
const origin = process.env.UI_ORIGIN || 'http://127.0.0.1:5237';
assert(['localhost', '127.0.0.1'].includes(new URL(origin).hostname), 'Loopback fixture only');
const output = path.resolve(process.env.UI_OUTPUT || 'docs/evidence/mobile-entries');
const widths = (process.env.UI_WIDTHS || '320,375,390').split(',').map(Number);
const root = '/app/projects/fixture';
const routes = [
  ['/app', '我的项目'], ['/app/join', '加入项目'], ['/app/support', '支持工单'], ['/app/support/ticket1', '工单详情'],
  ['/app/profile', '个人资料'], ['/app/people', '搜索用户'], ['/app/people/local_fixture', '用户主页'],
  ...['profile', 'security', 'appearance', 'installation', 'notifications'].map(section => [`/app/settings/${section}`, `账户设置 ${section}`]),
  ...['user', 'technical', 'database'].map(doc => [`/app/help?doc=${doc}`, `帮助 ${doc}`]),
  ['/app/projects/new', '项目创建选择'], ['/app/projects/new/wizard?draftId=draft-wizard', '已有分步草稿'], ['/app/projects/new/template/draft-template', '已有模板草稿'],
  [root, '项目概览'], [root + '/tasks', '任务'], [root + '/tasks?task=task1', '任务详情'],
  [root + '/data', '资料列表与文档'], [root + '/data?mode=import', '导入资料入口'], [root + '/data?mode=new', '新建文档入口'],
  [root + '/data?mode=files', '附件与回收站'], [root + '/data?resourceType=source&resourceId=source1', '来源详情'],
  [root + '/data?resourceType=material&resourceId=material1', '成果文档'],
  ...['standards', 'checks', 'rehearsals'].map(section => [root + '/assessment?section=' + section, `评分 ${section}`]),
  [root + '/team', '团队成员'], [root + '/settings', '团队设置'], [root + '/ledger', '活动历史'], [root + '/export', '项目导出'],
];
const aliases = ['sources', 'sources/source1', 'requirements', 'work', 'ai', 'materials', 'materials/material1', 'reviews', 'reviews/review1', 'rehearsals', 'rehearsals/rehearsal1', 'tasks/task1'];

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.UI_CHROMIUM_PATH ? { executablePath: process.env.UI_CHROMIUM_PATH } : {}) });
  const results = [], writes = [], failures = [], requests = new Set();
  try {
    await Promise.all(widths.map(async width => {
      for (const accountRole of ['user', 'admin', 'super_admin']) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
        const page = await context.newPage(); page.setDefaultTimeout(7000);
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        const profile = { accountRole, projectRole: 'owner' };
        await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        await page.route('**/api/v1/**', async route => {
          const request = route.request(), url = new URL(request.url()); requests.add(request.method() + ' ' + url.pathname);
          if (request.method() !== 'GET') { writes.push({ width, accountRole, method: request.method(), path: url.pathname }); return route.abort(); }
          const data = profile.anonymous && url.pathname.endsWith('/auth/session') ? { user: null } : profile.emptyAssessments && url.pathname.endsWith('/assessments') ? { items: [], nextCursor: null } : fixture(url.pathname, url.searchParams, profile);
          return route.fulfill({ json: { data, requestId: 'readonly-mobile-entries' } });
        });
        async function check(name, action) {
          if (process.env.UI_ENTRY_FILTER && !new RegExp(process.env.UI_ENTRY_FILTER).test(name)) return;
          try { await action(); results.push({ width, accountRole, name, status: 'passed' }); }
          catch (error) { failures.push({ width, accountRole, name, message: error.message.slice(0, 1200) }); console.log(JSON.stringify(failures.at(-1))); await page.screenshot({ path: path.join(output, `failure-${width}-${accountRole}-${failures.length}.png`), animations: 'disabled' }); }
          fs.writeFileSync(path.join(output, 'progress.json'), JSON.stringify({ results, failures, blockedWrites: writes }, null, 2));
        }
        async function opened(url) {
          await page.goto(origin + url, { waitUntil: 'domcontentloaded' });
          await page.locator('.main-shell').waitFor();
          const target = /\/projects\/fixture(?:[/?]|$)/.test(url) ? page.locator('.project-content-wrap') : page.locator('.main-shell');
          await target.locator('h1,h2,h3,form,[role="tablist"],.empty-state').first().waitFor();
          assert.equal(await page.getByRole('heading', { name: /工作区暂时|页面发生错误|无法显示此页面/ }).count(), 0);
        }
        async function geometry(locator) {
          await locator.waitFor({ state: 'visible' });
          try { await locator.scrollIntoViewIfNeeded(); }
          catch (error) { if (!error.message.includes('not attached')) throw error; await locator.waitFor({ state: 'visible' }); await locator.scrollIntoViewIfNeeded(); }
          const bounds = await locator.boundingBox(); assert(bounds && bounds.width > 0 && bounds.height > 0, 'entry has no visible area');
          assert(bounds.x >= -1 && bounds.x + bounds.width <= width + 1, 'entry clipped outside the phone viewport');
        }
        async function popup(buttonName, dialogName, setup) {
          await opened(root + '/data?resourceType=material&resourceId=material1');
          if (setup) await setup();
          const button = page.getByRole('button', { name: buttonName, exact: true }); await geometry(button); await button.click();
          await page.getByRole('dialog', { name: dialogName, exact: true }).waitFor();
          await page.keyboard.press('Escape');
        }
        // All shared routes on ordinary accounts; privileged settings on their allowed roles.
        const selectedRoutes = accountRole === 'user' ? routes : [];
        for (const [url, label] of selectedRoutes) await check('route: ' + label, async () => {
          await opened(url); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'page overflow makes entries inaccessible');
        });
        await check('global-menu-clicks', async () => {
          await opened('/app');
          for (const [name, target] of [['我的项目', '/app'], ['加入项目', '/app/join'], ['支持工单', '/app/support'], ['帮助文档', '/app/help'], ['个人资料', '/app/profile'], ['设置', '/app/settings/profile'], ['搜索用户', '/app/people']]) {
            const entry = page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name, exact: true }); await geometry(entry); await entry.click();
            await page.waitForURL(url => url.pathname === target);
            await page.waitForFunction(label => [...document.querySelectorAll('[aria-label="主导航"] a')].some(link => link.textContent.trim() === label && link.getAttribute('aria-current') === 'page'), name);
          }
        });
        await check('settings-tabs-clicks-and-role-boundaries', async () => {
          await opened('/app/settings/profile'); const nav = page.getByRole('navigation', { name: '设置分类' });
          const names = ['profile', 'security', 'appearance', 'installation', 'notifications'];
          if (accountRole !== 'user') names.push('accounts', 'system'); if (accountRole === 'super_admin') names.push('ai');
          const links = await nav.getByRole('link').all(); assert.equal(links.length, names.length);
          for (let index = 0; index < names.length; index++) { const entry = nav.getByRole('link').nth(index); await geometry(entry); await entry.click(); await page.waitForURL('**/settings/' + names[index]); await page.locator('.settings-content').locator('h1,h2,label,input,select,.empty-state').first().waitFor(); assert.equal(await page.getByRole('heading', { name: /需要.*管理员权限/ }).count(), 0); }
        });
        if (accountRole !== 'user') { await check('no-browser-runtime-errors', async () => assert.deepEqual(errors, [], 'browser runtime errors')); await context.close(); continue; }
        await check('homepage-new-project', async () => { await opened('/app'); const entry = page.locator('.heading-action').getByRole('link', { name: '新建项目' }); await geometry(entry); await entry.click(); await page.waitForURL('**/projects/new'); });
        await check('archive-modal-and-project-link', async () => { await opened('/app'); const entry = page.getByRole('link', { name: '查看归档任务' }); await geometry(entry); await entry.click(); const dialog = page.getByRole('dialog', { name: '归档任务', exact: true }); await dialog.waitFor(); const link = dialog.locator('a').first(); await geometry(link); await link.click(); await page.waitForURL('**/projects/archived-fixture'); });
        await check('profile-editor', async () => { await opened('/app/profile'); const entry = page.getByRole('button', { name: '编辑资料', exact: true }); await geometry(entry); await entry.click(); await page.getByRole('form', { name: '个人资料编辑' }).waitFor(); });
        await check('read-only-user-search-to-profile', async () => { await opened('/app/people'); await page.getByLabel('用户名').fill('local_fixture'); await page.getByRole('button', { name: '查找', exact: true }).click(); const entry = page.locator('main a[href="/app/people/local_fixture"]'); await geometry(entry); await entry.click(); await page.waitForURL('**/people/local_fixture'); });
        await check('support-detail-link', async () => { await opened('/app/support'); const entry = page.locator('main a[href="/app/support/ticket1"]'); await geometry(entry); await entry.click(); await page.waitForURL('**/support/ticket1'); await page.getByRole('heading', { name: '问题描述' }).waitFor(); });
        await check('topbar-menu-profile-support', async () => { await opened('/app'); const entry = page.getByRole('button', { name: '主题与账户操作' }); await geometry(entry); await entry.click(); assert.equal(await entry.getAttribute('aria-expanded'), 'true'); await page.getByRole('combobox', { name: '主题', exact: true }).waitFor(); const support = page.locator('.workspace-account-panel').getByRole('link', { name: '支持工单' }); await geometry(support); await support.click(); await page.waitForURL('**/app/support'); });
        await check('project-groups-and-subsections', async () => {
          await opened(root); const select = page.getByRole('combobox', { name: '切换项目功能' });
          for (const [value, target] of [['overview', root], ['work', root + '/tasks'], ['data', root + '/data'], ['assessment', root + '/assessment'], ['team', root + '/team']]) { await geometry(select); await select.selectOption(value); await page.waitForURL(url => url.pathname === target); }
          const team = page.getByRole('combobox', { name: '切换团队分区' });
          for (const value of ['settings', 'export', 'team']) { await geometry(team); await team.selectOption(value); await page.waitForURL('**/' + value); }
          await select.selectOption('overview'); const overview = page.getByRole('combobox', { name: '切换概览分区' }); await overview.selectOption('ledger'); await page.waitForURL('**/ledger'); await overview.selectOption(''); await page.waitForURL(url => url.pathname === root);
        });
        await check('data-three-intake-entries-and-resource-detail', async () => {
          await opened(root + '/data');
          for (const [name, mode] of [['导入资料', 'import'], ['新建文档', 'new'], ['附件与回收站', 'files']]) { const entry = page.getByRole('button', { name, exact: true }); await geometry(entry); await entry.click(); await page.waitForURL(url => url.searchParams.get('mode') === mode); }
          for (const resource of ['source1', 'material1']) { const entry = page.locator('.resource-list-entry').filter({ hasText: resource === 'source1' ? '入口审查来源' : '入口审查文档' }); await geometry(entry); await entry.click(); await page.waitForURL(url => url.searchParams.get('resourceId') === resource); }
        });
        await check('material-discussion', () => popup('讨论', '材料讨论'));
        await check('material-version-history', () => popup('版本历史', '材料版本历史'));
        await check('material-export-menu', async () => { await opened(root + '/data?resourceType=material&resourceId=material1'); const entry = page.getByRole('button', { name: /^导出文件/ }); await geometry(entry); await entry.click(); const option = page.getByRole('button', { name: 'Markdown', exact: true }); await option.waitFor(); await geometry(option); await geometry(page.locator('.dropdown-content:visible')); assert(await option.evaluate(element => { const box = element.getBoundingClientRect(); const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2); return element === hit || element.contains(hit); }), 'export option is covered or clipped'); await page.screenshot({ path: path.join(output, `${width}-material-export.png`), animations: 'disabled' }); await page.keyboard.press('Escape'); });
        await check('material-AI-panel', async () => { await opened(root + '/data?resourceType=material&resourceId=material1'); const entry = page.getByRole('button', { name: '打开 AI 协助', exact: true }); await geometry(entry); await entry.click(); await page.locator('.material-ai-assistance-content:not([hidden])').waitFor(); });
        await check('tasks-new-dialog', async () => { await opened(root + '/tasks'); const entry = page.getByRole('button', { name: '新建子任务', exact: true }); await geometry(entry); await entry.click(); await page.getByRole('dialog', { name: '新建子任务', exact: true }).waitFor(); await page.keyboard.press('Escape'); });
        await check('tasks-AI-dialog-and-history', async () => { await opened(root + '/tasks'); const entry = page.getByRole('button', { name: 'AI 拆解、调整与分工', exact: true }); await geometry(entry); await entry.click(); const dialog = page.getByRole('dialog', { name: 'AI 拆解、调整与分工', exact: true }); await dialog.waitFor(); await dialog.getByRole('button', { name: /^更多/ }).click(); await geometry(dialog.locator('.dropdown-content:visible')); await dialog.getByRole('button', { name: '查看历史版本', exact: true }).click(); await page.waitForURL(url => url.searchParams.get('historyType') === 'proposals'); });
        await check('task-detail-tabs-history', async () => { await opened(root + '/tasks'); const entry = page.getByRole('button', { name: '入口审查子任务', exact: true }); await geometry(entry); await entry.click(); const dialog = page.getByRole('dialog', { name: '入口审查子任务', exact: true }); await dialog.waitFor(); const settings = dialog.getByRole('tab', { name: '任务设置' }); await geometry(settings); await settings.click(); await dialog.getByRole('tab', { name: '提交和查看' }).click(); await dialog.getByRole('button', { name: /^更多/ }).click(); await geometry(dialog.locator('.dropdown-content:visible')); await dialog.getByRole('button', { name: '查看历史版本', exact: true }).click(); await page.waitForURL(url => url.searchParams.get('historyType') === 'submissions'); });
        await check('assessment-three-forms', async () => { await opened(root + '/assessment'); for (const [label, section] of [['项目标准', 'standards'], ['材料检查', 'checks'], ['答辩演练', 'rehearsals']]) { const entry = page.getByRole('navigation', { name: '评分形式' }).getByRole('button', { name: label, exact: true }); await geometry(entry); await entry.click(); await page.waitForURL(url => url.searchParams.get('section') === section); } });
        await check('standard-editor-entry', async () => { await opened(root + '/assessment'); const entry = page.getByRole('button', { name: '新建标准', exact: true }); await geometry(entry); await entry.click(); await page.getByLabel('标准名称').waitFor(); });
        await check('new-project-existing-drafts-and-template-picker', async () => { await opened('/app/projects/new'); const entry = page.getByRole('button', { name: '选择模板', exact: true }); await geometry(entry); await entry.click(); await page.getByRole('button', { name: '使用空项目模板' }).waitFor(); const draft = page.locator('main a[href="/app/projects/new/template/draft-template"]'); await geometry(draft); await draft.click(); await page.waitForURL('**/template/draft-template'); });
        await check('wizard-all-five-existing-draft-steps', async () => {
          await opened('/app/projects/new/wizard?draftId=draft-wizard');
          await page.waitForFunction(() => document.querySelector('input[required][maxlength="100"]')?.value === '已有向导草稿');
          for (const heading of ['上传文件', '人数与邀请', '目标与子任务预览']) { const entry = page.getByRole('button', { name: '下一步', exact: true }); await geometry(entry); await entry.click(); await page.getByRole('heading', { name: heading, exact: true }).waitFor(); }
          const entry = page.getByRole('button', { name: '进入创建预览' }); await geometry(entry); await entry.click(); await page.getByRole('heading', { name: '创建确认', exact: true }).waitFor();
        });
        await check('template-all-five-sections', async () => { await opened('/app/projects/new/template/draft-template'); const select = page.getByRole('combobox', { name: '切换模板预览分区' }); const values = await select.locator('option').evaluateAll(options => options.map(option => option.value)); assert.equal(values.length, 5); for (const value of values) { await geometry(select); await select.selectOption(value); assert.equal(await select.inputValue(), value); } });
        await check('source-intake-all-three-forms', async () => { await opened(root + '/data?mode=import'); for (const [name, label] of [['粘贴文本', '通知或项目资料原文'], ['网页链接', '公开网页地址'], ['文件', '选择来源文件']]) { const entry = page.getByRole('button', { name, exact: true }); await geometry(entry); await entry.click(); await page.getByLabel(label, { exact: false }).waitFor(); } });
        await check('source-fulltext-entry', async () => { await opened(root + '/data?resourceType=source&resourceId=source1'); const entry = page.locator('summary').filter({ hasText: '查看全文片段与引用定位' }); await geometry(entry); await entry.click(); await page.getByText('用于检查来源全文入口。', { exact: true }).waitFor(); });
        await check('file-library-recycle-switch', async () => { await opened(root + '/data?mode=files'); for (const name of ['回收站', '文件库']) { const entry = page.getByRole('button', { name, exact: true }); await geometry(entry); await entry.click(); assert.equal(await entry.getAttribute('aria-pressed'), 'true'); } });
        await check('existing-standard-revision-editor', async () => { await opened(root + '/assessment?section=standards'); const entry = page.getByRole('button', { name: '基于此版本修订', exact: true }); await geometry(entry); await entry.click(); await page.getByLabel('标准名称').waitFor(); });
        await check('manual-score-correction-form', async () => { await opened(root + '/assessment?section=checks'); const entry = page.locator('summary').filter({ hasText: '填写分项分数与修正反馈' }); await geometry(entry); await entry.click(); await page.getByLabel('人工评分或修正理由').waitFor(); });
        await check('manual-score-new-form-with-empty-history', async () => { profile.emptyAssessments = true; try { await opened(root + '/assessment?section=checks'); await page.getByRole('heading', { name: '独立人工评分', exact: true }).waitFor(); const entry = page.locator('summary').filter({ hasText: '填写分项分数与修正反馈' }); await geometry(entry); await entry.click(); await page.getByLabel('人工评分或修正理由').waitFor(); } finally { profile.emptyAssessments = false; } });
        await check('existing-assessment-detail-and-rehearsal-record', async () => { await opened(root + '/assessment?section=rehearsals'); const entry = page.locator('.assessment-history-row').first(); await geometry(entry); await entry.click(); await page.waitForURL(url => url.searchParams.get('assessmentId') === 'rehearsal-assessment1'); await page.getByText('展示总结。', { exact: true }).waitFor(); });
        await check('profile-import-candidates-entry', async () => { await opened('/app/profile'); await page.getByRole('button', { name: '编辑资料', exact: true }).click(); const entry = page.getByRole('button', { name: '读取导入候选', exact: true }); await geometry(entry); await entry.click(); await page.getByText('入口审查项目', { exact: false }).last().waitFor(); });
        await check('topbar-avatar-and-notification-panel', async () => { await opened('/app'); const profileEntry = page.locator('.topbar-account'); await geometry(profileEntry); await profileEntry.click(); await page.waitForURL('**/app/profile'); const bell = page.getByRole('button', { name: '通知中心', exact: true }); await geometry(bell); await bell.click(); await page.locator('#history').waitFor(); await page.keyboard.press('Escape'); });
        await check('ordinary-member-project-navigation-and-management-boundaries', async () => {
          profile.projectRole = 'member';
          try { await opened(root + '/team'); const select = page.getByRole('combobox', { name: '切换团队分区' }); assert.equal(await select.locator('option[value="settings"]').count(), 0); await select.selectOption('export'); await page.waitForURL('**/export'); await opened(root + '/tasks'); assert.equal(await page.getByRole('button', { name: '新建子任务', exact: true }).count(), 0); assert.equal(await page.getByRole('button', { name: 'AI 拆解、调整与分工', exact: true }).count(), 0); const entry = page.getByRole('button', { name: '入口审查子任务', exact: true }); await geometry(entry); await entry.click(); await page.getByRole('dialog', { name: '入口审查子任务', exact: true }).waitFor(); }
          finally { profile.projectRole = 'owner'; }
        });
        await check('homepage-project-card-and-pending-task-links', async () => { await opened('/app'); const card = page.locator('a.dashboard-project').filter({ hasText: '入口审查项目' }); await geometry(card); await card.click(); await page.waitForURL(url => url.pathname === root); await opened('/app'); const task = page.locator('a.dashboard-task').filter({ hasText: '入口审查子任务' }); await geometry(task); await task.click(); await page.waitForURL(url => url.pathname === root + '/tasks' && url.searchParams.get('task') === 'task1'); await page.getByRole('dialog', { name: '入口审查子任务' }).waitFor(); });
        await check('team-permission-editor-entry', async () => { await opened(root + '/team'); const entry = page.locator('summary').filter({ hasText: '调整 另一成员 的权限' }); await geometry(entry); await entry.click(); await page.getByLabel('权限模板').waitFor(); });
        await check('AI-session-history-selection', async () => { await opened(root + '/data?resourceType=material&resourceId=material1&ai=1'); const select = page.getByRole('combobox', { name: '选择最近的 AI 会话' }); await geometry(select); await select.selectOption('session1'); await page.getByRole('heading', { name: '真实会话记录', exact: true }).waitFor(); });
        await check('login-register-and-guest-entries', async () => { profile.anonymous = true; try { await page.goto(origin + '/login'); await page.getByRole('tab', { name: '登录', exact: true }).waitFor(); const register = page.getByRole('tab', { name: '注册', exact: true }); await geometry(register); await register.click(); await page.getByLabel('注册邀请码', { exact: false }).waitFor(); const guest = page.getByRole('link', { name: /游客演示/ }); await geometry(guest); assert.equal(await guest.getAttribute('href'), '/guest/index.html'); await guest.click(); await page.waitForURL('**/guest/index.html'); await page.locator('body').waitFor(); } finally { profile.anonymous = false; } });
        for (const alias of aliases) await check('legacy-link: ' + alias, async () => { await opened(root + '/' + alias); assert(!new URL(page.url()).pathname.endsWith('/' + alias), 'old path did not redirect'); });
        await opened(root + '/tasks'); await page.screenshot({ path: path.join(output, `${width}-navigation.png`), animations: 'disabled' });
        await check('no-browser-runtime-errors', async () => assert.deepEqual(errors, [], 'browser runtime errors')); await context.close();
      }
    }));
    const report = { scope: 'entry navigation only; synthetic GET responses; no business execution', origin, results, failures, blockedWrites: writes, requestedEndpoints: [...requests] };
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: results.length, failures, blockedWrites: writes }, null, 2));
    assert.equal(failures.length, 0); assert.equal(writes.length, 0, 'entry checks must not issue any API write');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
