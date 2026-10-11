// Production artifacts + health; authenticated GET UI if Turnstile permits automated login.
// Synthetic GET fixtures additionally verify deployed UI without changing business data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require(process.env.UI_PLAYWRIGHT_PATH || 'C:/Users/hmz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const { fixture } = require('./mobile-entry-fixtures.cjs');
assert(process.argv.includes('--production'));
const origin = 'https://greenbp-team-office.hddhp.workers.dev';
const output = path.resolve('output/navigation-release');
fs.mkdirSync(output, { recursive: true });
const report = { origin, checks: [], limitations: [], blockedWrites: [], browserErrors: [] };
const check = (name, evidence) => { report.checks.push({ name, passed: true, evidence }); console.log('PASS ' + name); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UI_CHROMIUM_PATH || 'C:/Users/hmz/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe' });
  let auth;
  try {
    const live = await browser.newContext({ serviceWorkers: 'block' });
    for (const [tail, expected] of [['health', { status: 'ok' }], ['health/deps', { d1: 'ok', r2: 'ok' }]]) {
      const r = await live.request.get(origin + '/api/v1/' + tail); assert.equal(r.status(), 200);
      const data = (await r.json()).data; for (const [key, value] of Object.entries(expected)) assert.equal(data[key], value);
      check('live ' + tail, expected);
    }
    const dist = path.resolve('frontend/dist');
    const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
    const remoteHtml = await live.request.get(origin + '/app'); assert.equal(remoteHtml.status(), 200);
    assert.equal(sha(await remoteHtml.body()), sha(Buffer.from(html))); check('deployed HTML matches main build', sha(Buffer.from(html)));
    const assets = fs.readdirSync(path.join(dist, 'assets')).filter(name => /^(index-|DashboardPage-|PersonalProfiles-|SupportHelpLayout-|HelpPage-).+\.(js|css)$/.test(name));
    assert(assets.length >= 6);
    for (const file of assets) { const r = await live.request.get(origin + '/assets/' + file); assert.equal(r.status(), 200); assert.equal(sha(await r.body()), sha(fs.readFileSync(path.join(dist, 'assets', file)))); }
    check('deployed navigation, profile, support and help assets match main', assets);
    await live.close();

    // Login is the only optional write. No credential resets or CAPTCHA workarounds.
    const credentialFile = path.resolve('.local-secrets/admin-credentials.json');
    if (fs.existsSync(credentialFile)) {
      const saved = JSON.parse(fs.readFileSync(credentialFile, 'utf8'));
      const account = saved.acceptanceAccounts?.at(-1);
      if (account?.username && account?.password) {
        auth = await browser.newContext({ serviceWorkers: 'block' });
        await auth.route('**/api/v1/**', route => {
          const r = route.request();
          if (r.method() !== 'GET' && !['/api/v1/auth/sessions', '/api/v1/auth/session'].includes(new URL(r.url()).pathname)) { report.blockedWrites.push({ method: r.method(), path: new URL(r.url()).pathname }); return route.abort(); }
          return route.continue();
        });
        const page = await auth.newPage(); page.setDefaultTimeout(12000);
        await page.goto(origin + '/login');
        await page.getByRole('textbox', { name: '用户名或邮箱', exact: true }).fill(account.username);
        await page.getByLabel('密码', { exact: true }).fill(account.password);
        const button = page.getByRole('button', { name: '登录工作区', exact: true });
        let permitted = false;
        try { await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '登录工作区' && !b.disabled), undefined, { timeout: 10000 }); permitted = true; }
        catch { report.limitations.push('Production Turnstile kept login disabled; authenticated real-account UI was not verified. No CAPTCHA bypass or credential reset performed.'); }
        if (permitted) {
          const login = page.waitForResponse(r => r.url().endsWith('/api/v1/auth/sessions') && r.request().method() === 'POST');
          await button.click(); const response = await login;
          if (response.status() === 201) {
            await page.waitForURL(origin + '/app');
            assert.equal(await page.getByRole('navigation', { name: '主导航' }).getByRole('link').count(), 4);
            await page.getByRole('button', { name: '个人资料菜单' }).click();
            await page.locator('.workspace-account-panel').getByRole('link', { name: '个人资料', exact: true }).click();
            await page.getByRole('navigation', { name: '个人资料设置' }).waitFor();
            check('authenticated production account reaches consolidated navigation and profile settings', true);
          } else report.limitations.push('Saved acceptance-account login returned HTTP ' + response.status() + '; no credential reset performed.');
        }
        await auth.request.delete(origin + '/api/v1/auth/session', { headers: { Origin: origin } });
        await auth.close(); auth = null;
      } else report.limitations.push('No saved ordinary acceptance credential available; real-account UI not verified.');
    }
    for (const width of [320, 768, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
      await context.route('**/api/v1/**', route => { const r = route.request(), url = new URL(r.url()); if (r.method() !== 'GET') { report.blockedWrites.push({ method: r.method(), path: url.pathname }); return route.abort(); } return route.fulfill({ json: { data: fixture(url.pathname, url.searchParams), requestId: 'deployed-navigation-fixture' } }); });
      const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => report.browserErrors.push(error.message));
      await page.goto(origin + '/app'); const nav = page.getByRole('navigation', { name: '主导航' }); await nav.waitFor();
      await page.getByRole('link', { name: '新建项目', exact: true }).waitFor();
      assert.deepEqual(await nav.getByRole('link').evaluateAll(links => links.map(link => link.getAttribute('aria-label'))), ['我的项目', '支持与帮助', '个人资料', '搜索用户']);
      assert.equal(await page.locator('.sidebar-create,.topbar-archive').count(), 0);
      assert.equal(await page.getByRole('link', { name: '新建项目', exact: true }).count(), 1);
      assert.equal(await page.getByRole('link', { name: '查看归档任务', exact: true }).count(), 1);
      await page.getByRole('button', { name: '个人资料菜单' }).click(); await page.locator('.workspace-account-panel').getByRole('button', { name: '退出登录', exact: true }).waitFor();
      await page.screenshot({ path: path.join(output, `deployed-${width}-account-menu.png`) });
      await page.locator('.workspace-account-panel').getByRole('link', { name: '个人资料', exact: true }).click();
      const footer = page.getByRole('navigation', { name: '个人资料设置' }); await footer.waitFor(); await footer.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: path.join(output, `deployed-${width}-profile-footer.png`) });
      await footer.getByRole('link', { name: '账户安全' }).click(); await page.waitForURL('**/app/profile/settings/security');
      await page.goto(origin + '/app/support/help'); await page.getByRole('article', { name: '使用说明' }).waitFor();
      check('deployed UI with synthetic GET data at ' + width + 'px', { mainDestinations: 4, profileFooter: true, help: true });
      await context.close();
    }
    assert.deepEqual(report.browserErrors, []); assert.deepEqual(report.blockedWrites, []); report.passed = true;
  } catch (error) { report.passed = false; report.error = error.message; process.exitCode = 1; }
  finally { await auth?.request.delete(origin + '/api/v1/auth/session', { headers: { Origin: origin } }).catch(() => {}); await auth?.close(); await browser.close(); fs.writeFileSync(path.join(output, 'production-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, limitations: report.limitations, error: report.error })); }
})();
