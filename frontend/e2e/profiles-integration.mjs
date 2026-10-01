/* global process, console, document, innerWidth, history, window, URL */
// Exercises the real combined app, with synthetic localhost-only API fixtures.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('../../../yso-update/frontend/node_modules/playwright');
const base = process.env.WORKBENCH_URL || 'http://127.0.0.1:5189';
assert.equal(new URL(base).hostname, '127.0.0.1');
const output = path.resolve(process.env.QA_OUTPUT || '../../qa');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
const results = [];
try {
 for (const role of ['user', 'admin', 'super_admin']) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  const errors = [], outside = [], writes = [], adminReads = [];
  const needles = ['PRIVATE-BIO', 'PRIVATE-MAJOR', 'PRIVATE-SPECIALTIES', 'PRIVATE-ROLE'];
  let own = { revision: 0, searchable: false, bio: '', major: '', specialties: '', preferredRoles: '', visibility: { bio: false, major: false, specialties: false, preferredRoles: false } };
  const publiclyVisible = () => own.searchable ? { username: 'fixture', displayName: 'Synthetic owner', ...Object.fromEntries(Object.keys(own.visibility).filter(k => own.visibility[k]).map(k => [k, own[k]])) } : null;
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => {
   if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue();
   outside.push(route.request().url()); return route.abort();
  });
  await context.route('**/api/v1/**', async route => {
   const req = route.request(), url = new URL(req.url()), endpoint = url.pathname;
   let data = { items: [], nextCursor: null };
   if (endpoint.includes('/admin/')) adminReads.push(endpoint);
   if (req.method() !== 'GET') {
    writes.push({ endpoint, method: req.method() });
    assert.equal(endpoint, '/api/v1/auth/personal-profile'); assert.equal(req.method(), 'PUT');
    assert.equal(req.headers()['x-account-settings'], '1');
    const body = req.postDataJSON(); assert.equal(body.expectedRevision, own.revision);
    const { expectedRevision, ...values } = body; own = { ...values, revision: expectedRevision + 1 }; data = own;
   } else if (endpoint === '/api/v1/auth/session') data = { user: { id: `fixture-${role}`, username: 'fixture', displayName: 'Synthetic owner', email: null, role, isAdmin: role !== 'user' } };
   else if (endpoint === '/api/v1/capabilities') data = {};
   else if (endpoint === '/api/v1/auth/personal-profile') data = own;
   else if (endpoint === '/api/v1/profiles/search') data = { items: url.searchParams.get('username') === 'fixture' && own.searchable ? [{ username: 'fixture', displayName: 'Synthetic owner' }] : [], nextCursor: null };
   else if (endpoint.startsWith('/api/v1/profiles/')) data = { profile: endpoint.endsWith('/fixture') ? publiclyVisible() : null };
   await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify({ data, requestId: 'synthetic-integration' }) });
  });
  await page.goto(`${base}/app/settings/privacy`);
  const tabs = page.locator('.settings-tabs'); await page.locator('#profile-bio').waitFor();
  assert.equal(await tabs.locator('a[href="/app/settings/privacy"]').count(), 1);
  assert.equal(await tabs.locator('a[href="/app/settings/accounts"]').count(), role === 'user' ? 0 : 1);
  assert.equal(await tabs.locator('a[href="/app/settings/ai"]').count(), role === 'super_admin' ? 1 : 0);
  assert.equal(await page.locator('.main-nav a[href="/app/settings"]').count(), 1);
  assert.equal(await page.locator('.main-nav a[href="/app/people"]').count(), 1);
  const boxes = page.locator('.personal-profiles form input[type="checkbox"]');
  for (let i = 0; i < 5; i++) assert.equal(await boxes.nth(i).isChecked(), false, 'legacy default stays private');
  for (const [i, field] of ['bio', 'major', 'specialties', 'preferredRoles'].entries()) await page.locator(`#profile-${field}`).fill(needles[i]);
  const preview = page.locator('.profile-card');
  for (const needle of needles) assert(!(await preview.innerText()).includes(needle));
  page.once('dialog', d => d.dismiss()); await page.locator('.main-nav a[href="/app/people"]').click();
  assert.match(page.url(), /\/settings\/privacy$/); assert.equal(await page.locator('#profile-bio').inputValue(), needles[0]);
  await page.locator('app-updates #bell').click(); await page.evaluate(() => history.back());
  await page.locator('app-updates #history').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#profile-bio').inputValue(), needles[0]);
  const historyText = await page.locator('app-updates').evaluate(el => el.shadowRoot.textContent);
  for (const needle of needles) assert(!historyText.includes(needle));
  page.once('dialog', d => d.dismiss()); await page.locator('.profile-row button').click(); assert.deepEqual(writes, []);
  await boxes.nth(0).check(); await boxes.nth(1).check();
  await page.locator('#profile-bio').fill('**Public bio** <script>window.profileXss=1</script> ![tracking](https://invalid.example/image.png)');
  assert.equal(await preview.locator('img,script').count(), 0);
  assert.equal(await page.evaluate(() => window.profileXss), undefined);
  await page.locator('.personal-profiles button[type="submit"]').click(); await page.waitForFunction(() => document.querySelector('.personal-profiles [role="status"]'));
  assert.equal(writes.length, 1); assert.equal(own.revision, 1);
  await page.locator('.main-nav a[href="/app/people"]').click(); await page.waitForURL('**/app/people');
  await page.locator('#profile-search').fill('fixture'); await page.locator('.personal-profiles form button').click();
  await page.locator('a[href="/app/people/fixture"]').click(); await page.waitForURL('**/app/people/fixture');
  await page.locator('.profile-card').waitFor();
  for (const needle of needles) assert(!(await page.locator('.main-shell').innerText()).includes(needle));
  assert.match(await page.locator('.profile-card').innerText(), /Public bio/);
  assert.equal(await page.locator('.profile-card img,.profile-card script').count(), 0);
  await page.goBack(); await page.waitForURL('**/app/people'); await page.goForward(); await page.waitForURL('**/app/people/fixture');
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(output, `integration-profile-${role}-mobile.png`), fullPage: true });
  await page.goto(`${base}/app/people/hidden`); await page.locator('.personal-profiles').waitFor(); await page.waitForFunction(() => !document.querySelector('.personal-profiles .spinner'));
  await page.locator('.main-nav a[href="/app/settings"]').click(); await page.waitForURL('**/app/settings/profile');
  await page.locator('.settings-tabs a[href="/app/settings/privacy"]').click(); await page.locator('#profile-bio').waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(output, `integration-editor-${role}-mobile.png`), fullPage: true });
  await page.locator('.personal-profiles form input[type="checkbox"]').first().uncheck();
  await page.locator('.personal-profiles button[type="submit"]').click(); await page.waitForFunction(() => document.querySelector('.personal-profiles [role="status"]'));
  await page.locator('.main-nav a[href="/app/people"]').click(); await page.locator('#profile-search').fill('fixture'); await page.locator('.personal-profiles form button').click();
  await page.waitForFunction(() => document.querySelector('.personal-profiles [role="status"]').textContent.length > 0);
  assert.equal(await page.locator('a[href="/app/people/fixture"]').count(), 0, 'disable hides account on subsequent read');
  await page.goto(`${base}/app/people/fixture`); await page.waitForFunction(() => document.querySelector('.personal-profiles') && !document.querySelector('.profile-card') && document.querySelector('.personal-profiles').querySelector('p'));
  assert.equal(await page.locator('.profile-card').count(), 0);
  await page.goto(`${base}/app/settings/ai`); await tabs.waitFor();
  if (role !== 'super_admin') { await page.getByRole('alert').waitFor(); assert(!adminReads.some(p => p.includes('ai-config'))); }
  else await page.locator('.ai-model-settings').first().waitFor();
  assert.deepEqual(errors, []); assert.deepEqual(outside, []);
  results.push({ role, passed: true, checks: ['authenticated deep links', 'private defaults', 'public preview filters fields', 'shared dirty cancel', 'logout cancel no write', 'notification history no private text', 'native notification Back retains draft', 'optimistic fixture save', 'exact search route', 'public fields only', 'Markdown inert/no images', 'Back/Forward', '390px layout', 'privacy withdrawal', 'AI permission guard', 'no external requests'], writes });
  console.log(`PASS integrated profiles: ${role}`); await context.close();
 }
 const anonymous = await browser.newContext({ serviceWorkers: 'block' });
 const anonymousPage = await anonymous.newPage(); const privateReads = [];
 await anonymous.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
 await anonymous.route('**/api/v1/**', async route => {
  const endpoint = new URL(route.request().url()).pathname;
  if (endpoint.includes('personal-profile') || endpoint.includes('/profiles')) privateReads.push(endpoint);
  const data = endpoint.endsWith('/auth/session') ? { user: null } : {};
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data, requestId: 'synthetic-anonymous' }) });
 });
 for (const route of ['/app/settings/privacy', '/app/people', '/app/people/fixture']) {
  await anonymousPage.goto(base + route); await anonymousPage.waitForURL('**/login');
  assert.equal(await anonymousPage.locator('.personal-profiles').count(), 0);
 }
 assert.deepEqual(privateReads, []);
 results.push({ role: 'anonymous', passed: true, checks: ['all three deep links redirect to login before reading profile APIs'] });
 await anonymous.close(); console.log('PASS integrated profiles: anonymous');
 writeFileSync(path.join(output, 'profiles-integration-results.json'), JSON.stringify({ mode: 'real integrated app; mocked localhost APIs, not live backend E2E', results }, null, 2));
} finally { await browser.close(); }
