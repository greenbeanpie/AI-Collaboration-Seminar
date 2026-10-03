// Read-only local browser fixtures; never writes to the production API.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.UI_PLAYWRIGHT_PATH || 'playwright');
const { fixture } = require('./audit-ui.cjs');
const origin = process.env.UI_ORIGIN || 'http://127.0.0.1:5237';
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw new Error('Only loopback fixture servers are allowed');
const output = path.resolve(process.env.UI_OUTPUT || 'docs/evidence/help');
const technicalChapters = (fs.readFileSync('frontend/src/help/TECHNICAL-IMPLEMENTATION.md', 'utf8').match(/^## /gm) || []).length;
const databaseChapters = (fs.readFileSync('frontend/src/help/DATABASE-SCHEMA.md', 'utf8').match(/^## /gm) || []).length;

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.UI_CHROMIUM_PATH ? { executablePath: process.env.UI_CHROMIUM_PATH } : {}) });
  const results = [];
  try {
    for (const [width, theme] of [[1440, 'light'], [390, 'dark'], [375, 'light'], [320, 'light'], [790, 'light']]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, serviceWorkers: 'block', acceptDownloads: true });
      const page = await context.newPage(); const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.route('**/api/v1/**', route => {
        assert.equal(route.request().method(), 'GET', 'fixture must never write');
        const data = fixture(new URL(route.request().url()).pathname, 'empty');
        if (data.user) data.user = { ...data.user, role: 'user', isAdmin: false };
        return route.fulfill({ json: { data, requestId: 'help-readonly-fixture' } });
      });
      await page.goto(origin + '/app/help');
      await page.getByRole('heading', { name: '帮助文档', exact: true }).waitFor();
      const menu = page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '帮助文档' });
      const navigation = await page.getByRole('navigation', { name: '主导航' }).evaluate(nav => {
        const bounds = nav.getBoundingClientRect();
        return { scrollWidth: nav.scrollWidth, clientWidth: nav.clientWidth, links: [...nav.querySelectorAll('a')].map(link => {
          const rect = link.getBoundingClientRect();
          return { name: link.textContent, width: rect.width, height: rect.height, visible: rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight };
        }) };
      });
      assert.equal(navigation.links.length, 7);
      assert.equal(navigation.scrollWidth > navigation.clientWidth + 1, false, 'menu must not require horizontal scrolling');
      for (const link of navigation.links) { assert(link.visible, `${link.name} is clipped at ${width}`); if (width <= 790) assert(link.height >= 44, 'mobile navigation touch target is at least 44px tall'); }
      await menu.click();
      assert.equal(await menu.getAttribute('aria-current'), 'page');
      assert.equal(await page.getByRole('article', { name: '使用说明' }).count(), 1);
      assert.equal(await page.locator('.help-section').count(), 9);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `user document overflow at ${width}`);
      await page.screenshot({ path: path.join(output, `${width}-${theme}-user.png`) });
      for (const [label, filename] of [['使用说明', 'USER-GUIDE.md'], ['技术实现', 'TECHNICAL-IMPLEMENTATION.md'], ['数据库字典', 'DATABASE-SCHEMA.md']]) {
        await page.getByRole('navigation', { name: '文档选择' }).getByRole('link', { name: label, exact: true }).click();
        await page.getByRole('article', { name: label }).waitFor();
        const downloadPromise = page.waitForEvent('download');
        await page.getByRole('button', { name: '下载文档' }).click();
        const download = await downloadPromise;
        assert.equal(download.suggestedFilename(), filename);
        const stream = await download.createReadStream(); const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        assert.equal(Buffer.concat(chunks).toString('utf8'), fs.readFileSync(path.join('frontend/src/help', filename), 'utf8'));
        if (label === '技术实现') {
          assert.equal(await page.locator('.help-section').count(), technicalChapters);
          assert(await page.locator('pre code').count() >= 5, 'technical handover must render code examples');
        }
        if (label === '数据库字典') {
          assert.equal(await page.locator('.help-section').count(), databaseChapters);
          assert.equal(await page.getByRole('table').count(), 78);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `database document overflow at ${width}`);
          await page.getByRole('searchbox', { name: '搜索当前文档' }).fill('task_submissions');
          await page.getByRole('status').filter({ hasText: /找到 [1-9]/ }).waitFor();
          await page.screenshot({ path: path.join(output, `${width}-${theme}-database.png`) });
        }
      }
      await page.getByRole('navigation', { name: '文档选择' }).getByRole('link', { name: '技术实现', exact: true }).click();
      await page.getByRole('article', { name: '技术实现' }).waitFor();
      assert(await page.getByRole('table').count() >= 5);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `technical document overflow at ${width}`);
      await page.screenshot({ path: path.join(output, `${width}-${theme}-technical.png`) });
      await page.getByRole('searchbox', { name: '搜索当前文档' }).fill('D1');
      await page.getByRole('status').filter({ hasText: /找到 [1-9]/ }).waitFor();
      assert(new URL(page.url()).searchParams.get('q') === 'D1');
      await page.getByRole('searchbox', { name: '搜索当前文档' }).fill('不会存在的关键词-12345');
      await page.getByRole('heading', { name: '未找到相关章节' }).waitFor();
      await page.getByRole('button', { name: '清除搜索' }).click();
      if (width <= 1100) await page.getByRole('button', { name: '展开目录' }).click();
      const links = page.getByRole('navigation', { name: '章节目录' }).getByRole('link');
      assert.equal(await links.count(), technicalChapters);
      const destination = await links.last().getAttribute('href'); await links.last().click();
      await page.waitForURL(url => url.hash === destination);
      assert(await page.locator(destination).isVisible());
      await page.reload(); await page.getByRole('article', { name: '技术实现' }).waitFor();
      await menu.click(); await page.getByRole('article', { name: '使用说明' }).waitFor();
      assert.deepEqual(errors, []);
      results.push({ width, theme, role: 'user', chapters: { user: 9, technical: technicalChapters, database: databaseChapters }, navigation, checks: ['all-menu-entries-visible-without-scrolling', 'help-menu-click', 'navigation', 'all-three-documents', 'code-blocks', 'database-tables-and-search', 'search', 'no-results', 'anchors', 'refresh', 'exact-download-content', 'no-overflow', 'no-browser-errors'], status: 'passed' });
      await context.close();
    }
    const context = await browser.newContext({ serviceWorkers: 'block' }); const page = await context.newPage();
    await page.route('**/api/v1/**', route => route.fulfill({ json: { data: new URL(route.request().url()).pathname.endsWith('/auth/session') ? { user: null } : fixture(new URL(route.request().url()).pathname, 'empty'), requestId: 'anonymous-help-fixture' } }));
    await page.goto(origin + '/app/help'); await page.waitForURL('**/login');
    assert.equal(await page.getByRole('article', { name: '使用说明' }).count(), 0);
    results.push({ role: 'anonymous', check: 'login-required', status: 'passed' }); await context.close();
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ origin, results }, null, 2));
    console.log(JSON.stringify(results, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
