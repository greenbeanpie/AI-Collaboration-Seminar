// Synthetic, loopback-only regression for the two reported layout tickets.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.UI_PLAYWRIGHT_PATH || 'playwright');
const { fixture } = require('./audit-ui.cjs');
const origin = process.env.UI_ORIGIN || 'http://127.0.0.1:5217';
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw new Error('Only a local fixture server is allowed');
const output = process.env.UI_OUTPUT || '/tmp/p2-ticket-layout';
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.UI_CHROMIUM_PATH ? { executablePath: process.env.UI_CHROMIUM_PATH } : {}) });
  const results = [];
  try {
    for (const width of [320, 375, 390, 560, 768, 790, 791, 1024, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
      const page = await context.newPage(); const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/api/v1/**', route => {
        if (route.request().method() !== 'GET') throw new Error('Fixture test must not write');
        return route.fulfill({ json: { data: fixture(new URL(route.request().url()).pathname, 'filled'), requestId: 'layout-fixture' } });
      });
      await page.goto(origin + '/app/projects/fixture/settings');
      await page.getByRole('heading', { name: '项目基本信息' }).waitFor();
      assert.equal(await page.getByRole('navigation', { name: '项目功能' }).count(), 1);
      assert.equal(await page.getByRole('banner', { name: '工作区顶栏' }).getByRole('navigation', { name: '项目功能' }).count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `page overflow at ${width}`);
      assert.equal(await page.locator('.project-content-links').evaluate(el => el.scrollWidth > el.clientWidth + 1), false, 'project labels do not require horizontal scrolling');
      const bounds = await page.locator('.date-input-control').first().evaluate(el => {
        const input = el.querySelector('input').getBoundingClientRect();
        const wrapper = el.getBoundingClientRect(); const field = el.closest('.field').getBoundingClientRect(); const card = el.closest('.card').getBoundingClientRect();
        return { input: { left: input.left, right: input.right }, wrapper: { left: wrapper.left, right: wrapper.right }, field: { left: field.left, right: field.right }, card: { left: card.left, right: card.right } };
      });
      for (const name of ['wrapper', 'field', 'card']) assert(bounds.input.left >= bounds[name].left - 1 && bounds.input.right <= bounds[name].right + 1, `date overflow of ${name} at ${width}`);
      const date = page.locator('input[type=date]').first(); await date.fill('2026-12-15'); assert.equal(await date.inputValue(), '2026-12-15'); await date.fill(''); assert.equal(await date.inputValue(), '');
      if (width <= 790) {
        const toggle = page.getByRole('button', { name: '主题与账户操作' });
        const navigation = page.getByRole('combobox', { name: '切换项目功能' });
        const navBox = await navigation.boundingBox(), headerBox = await page.getByRole('banner', { name: '工作区顶栏' }).boundingBox();
        assert(navBox.y >= headerBox.y + headerBox.height, 'project navigation stays in the content area');
        await toggle.click();
        await page.getByRole('combobox', { name: '主题', exact: true }).selectOption('dark');
        assert(await page.getByRole('button', { name: '退出登录' }).isVisible());
        await page.keyboard.press('Escape'); assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
        await navigation.selectOption('tasks'); await page.waitForURL('**/tasks');
        await page.goBack(); await page.getByRole('heading', { name: '项目基本信息' }).waitFor();
        assert.equal(await navigation.inputValue(), 'settings');
      } else {
        const nav = page.getByRole('navigation', { name: '项目功能' });
        await nav.getByRole('link', { name: '任务', exact: true }).click(); await page.waitForURL('**/tasks');
        await page.goBack(); await page.getByRole('heading', { name: '项目基本信息' }).waitFor();
      }
      await page.screenshot({ path: `${output}/${width}.png`, fullPage: false });
      assert.deepEqual(errors, []);
      results.push({ width, status: 'passed', bounds }); await context.close();
    }
    fs.writeFileSync(`${output}/results.json`, JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
