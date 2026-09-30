// Loopback-only fixture UI verification; no real accounts, credentials or production API.
const { chromium } = require(process.env.UI_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const origin = process.env.UI_ORIGIN || 'http://127.0.0.1:5193';
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('Loopback only');
(async () => {
 const browser = await chromium.launch({ executablePath: process.env.UI_CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
 try {
  for (const role of ['super_admin', 'admin', 'user']) {
   const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
   const user = { id: 'fixture', username: 'fixture', displayName: '权限测试', email: null, role, isAdmin: role !== 'user' };
   let targetRole = 'user';
   await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let data = {};
    if (path === '/api/v1/auth/session') data = { user };
    else if (path === '/api/v1/admin/accounts') data = { items: [{ id: 'target', username: 'member', displayName: '一般成员', email: null, role: targetRole }], nextCursor: null };
    else if (path.endsWith('/target/role')) { targetRole = route.request().postDataJSON().role; data = { user: { role: targetRole } }; }
    else if (path.endsWith('/account-invitations')) data = { items: [], nextCursor: null };
    else if (path === '/api/v1/projects') data = { items: [], nextCursor: null };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data, requestId: 'local-ui-fixture' }) });
   });
   await page.goto(origin + '/app/admin/accounts');
   if (role === 'user') {
    await page.getByRole('heading', { name: '需要系统管理员权限' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '生成一个邀请码' }).count(), 0);
   } else {
    await page.getByRole('heading', { name: '账户等级与管理' }).waitFor();
    assert.equal(await page.getByRole('combobox').count(), role === 'super_admin' ? 1 : 0);
    if (role === 'super_admin') {
     await page.getByLabel('member 账户等级').selectOption('admin');
     await page.getByRole('button', { name: '保存等级' }).click();
     await page.getByText('member · 普通管理员').waitFor();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'No mobile overflow');
    await page.screenshot({ path: `/tmp/project2-${role}.png`, fullPage: true });
   }
   await page.goto(origin + '/app/admin/ai');
   if (role !== 'super_admin') assert.equal(await page.getByRole('button', { name: '读取已保存配置' }).count(), 0);
   else await page.getByRole('button', { name: '读取已保存配置' }).waitFor();
   await page.close();
  }
  console.log('PASS: all roles, role mutation, direct system-settings navigation, mobile overflow');
 } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
