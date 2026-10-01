// Loopback-only UI fixtures: all APIs intercepted, no real credentials or provider requests.
const { chromium } = require(process.env.UI_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const origin = process.env.UI_ORIGIN || 'http://127.0.0.1:5198';
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('Loopback only');
(async () => {
 const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
 try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let saved; let puts = 0; let probes = 0;
  await page.route('**/*', async route => {
   const url = new URL(route.request().url());
   if (url.origin !== origin) return route.abort();
   if (!url.pathname.startsWith('/api/')) return route.continue();
   const method = route.request().method(); let data = { items: [], nextCursor: null };
   if (url.pathname.endsWith('/auth/session')) data = { user: { id: 'fixture', username: 'fixture', displayName: '本地测试管理员', role: 'super_admin', isAdmin: true } };
   else if (url.pathname.endsWith('/capabilities')) data = { features: { aiEnabled: false } };
   else if (url.pathname.endsWith('/ai-config')) {
    if (method === 'PUT') { puts++; const input = route.request().postDataJSON(); assert.equal(input.enabled, false); saved = Object.fromEntries(['textEconomy', 'visionEconomy', 'review'].map(p => { const { apiKey, clearKey, ...model } = input[p]; return [p, { ...model, keyConfigured: Boolean(apiKey) || !clearKey && Boolean(model.keyConfigured) }]; })); data = { version: puts }; }
    else data = { version: saved ? puts : 0, enabled: false, config: saved || {} };
   } else if (url.pathname.endsWith('/probe')) { probes++; throw new Error('No automatic probe permitted'); }
   await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  await page.goto(origin + '/app/admin/ai');
  await page.getByRole('heading', { name: 'AI 模型接入与测试' }).waitFor();
  await page.getByLabel(/文本与要求提取供应商/).selectOption('opencode-go');
  await page.getByLabel('我已确认套餐适用于本应用用途').check();
  await page.getByLabel(/文本与要求提取 API 协议/).selectOption('messages');
  await page.getByLabel('文本与要求提取模型名称', { exact: true }).fill('minimax-m3');
  await page.getByLabel(/文本与要求提取 Go User-Agent/).fill('MyOffice/1.0');
  await page.getByLabel(/文本与要求提取 Go 会话前缀/).fill('demo');
  await page.getByLabel(/文本与要求提取 API key/).fill('fixture-only-no-real-key');
  await page.getByRole('button', { name: '保存配置并停用 AI' }).click();
  await page.getByText('配置已保存，AI 暂停启用。请逐项测试。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '读取已保存配置' }).click();
  await page.getByText('当前 AI 未启用。', { exact: true }).waitFor();
  assert.equal(await page.getByLabel(/文本与要求提取 API key/).inputValue(), '');
  assert.equal(await page.getByLabel(/文本与要求提取 API 协议/).inputValue(), 'messages');
  assert.equal(await page.getByLabel(/文本与要求提取 Go User-Agent/).inputValue(), 'MyOffice/1.0');
  await page.getByRole('heading', { name: 'AI 模型接入与测试' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/p2-ai-provider-desktop.png', fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'No mobile horizontal overflow');
  await page.getByLabel(/文本与要求提取 Go User-Agent/).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/p2-ai-provider-mobile.png', fullPage: false });
  await page.reload();
  await page.getByRole('heading', { name: 'AI 模型接入与测试' }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  assert.equal(await page.getByLabel(/文本与要求提取 API key/).inputValue(), '');
  assert.equal(puts, 1); assert.equal(probes, 0); assert.deepEqual(errors, []);
  console.log('PASS: independent protocol, Go header panel, save/read, credential clearing, reload, mobile overflow, no automatic probes or console errors');
 } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
