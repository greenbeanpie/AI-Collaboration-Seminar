import assert from 'node:assert/strict';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';

// No credentials, cookies, PKCE material, callback URLs, screenshots or traces are saved.
const origins = ['https://team.greenbp.dpdns.org', 'https://greenbp-team-office.hddhp.workers.dev'];
const prefix = '/api/v1/auth/';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, state: randomBytes(32).toString('base64url'), challenge: createHash('sha256').update(verifier).digest('base64url') };
}
function ordinaryAccount(saved) {
  const candidates = saved.acceptanceAccounts ?? [];
  const account = candidates.findLast(a => a?.username && a?.password && !a.isAdmin && (!a.role || a.role === 'user'));
  assert(account, 'ordinary_account_missing');
  return account;
}
function authorizationPath(path, transactionId) {
  assert(uuid.test(transactionId), 'invalid_transaction');
  const parsed = new URL(path, origins[0]);
  assert.equal(path, `/app/native-authorize?transaction=${transactionId}`, 'invalid_authorization_path');
  assert.equal(parsed.origin, origins[0]);
  return path;
}
function callbackCode(uri, state) {
  const parsed = new URL(uri);
  assert.equal(parsed.protocol, 'buwei-native-preview:');
  assert.equal(parsed.hostname, 'auth');
  assert.equal(parsed.pathname, '/callback');
  assert(!parsed.username && !parsed.password && !parsed.port && !parsed.hash);
  assert.deepEqual([...parsed.searchParams.keys()].sort(), ['code', 'state']);
  const actual = Buffer.from(parsed.searchParams.get('state') ?? '');
  const expected = Buffer.from(state);
  assert(actual.length === expected.length && timingSafeEqual(actual, expected), 'state_mismatch');
  const code = parsed.searchParams.get('code');
  assert(/^[A-Za-z0-9_-]{43}$/.test(code ?? ''), 'invalid_code');
  return code;
}
function browserWriteAllowed(origin, url, method, transactionId) {
  const parsed = new URL(url);
  if (method === 'GET') return true;
  if (parsed.origin !== origin || parsed.search || parsed.hash) return false;
  return method === 'POST' && (parsed.pathname === `${prefix}sessions` ||
    (uuid.test(transactionId ?? '') && parsed.pathname === `${prefix}native/transactions/${transactionId}/approve`));
}
async function cleanupSessions(contexts, request, record) {
  // Try each independently, even when the first context or revocation fails.
  for (const [name, context] of contexts) {
    if (!context) continue;
    try {
      const result = await request(context, 'DELETE', `${prefix}session`);
      const status = result.status();
      const after = await request(context, 'GET', `${prefix}session`);
      record({ step: `logout_${name}`, status, result: [200, 401].includes(status) && after.status() === 401 ? 'passed' : 'failed' });
    } catch { record({ step: `logout_${name}`, result: 'failed' }); }
  }
}
async function selfTest() {
  const material = pkce();
  for (const value of Object.values(material)) assert(/^[A-Za-z0-9_-]{43}$/.test(value));
  assert.equal(material.challenge, createHash('sha256').update(material.verifier).digest('base64url'));
  const id = '12345678-1234-1234-1234-123456789abc';
  assert.equal(authorizationPath(`/app/native-authorize?transaction=${id}`, id), `/app/native-authorize?transaction=${id}`);
  for (const path of ['https://evil.example/app/native-authorize', '//evil.example/', '/app/native-authorize?transaction=wrong']) assert.throws(() => authorizationPath(path, id));
  const uri = `buwei-native-preview://auth/callback?code=${material.challenge}&state=${material.state}`;
  assert.equal(callbackCode(uri, material.state), material.challenge);
  for (const bad of [uri.replace(material.state, 'wrong'), uri.replace('auth/', 'evil/'), uri + '&code=duplicate', uri.replace('buwei-native-preview:', 'https:')]) assert.throws(() => callbackCode(bad, material.state));
  assert(browserWriteAllowed(origins[0], origins[0] + prefix + 'sessions', 'POST', id));
  assert(browserWriteAllowed(origins[0], origins[0] + prefix + `native/transactions/${id}/approve`, 'POST', id));
  for (const [url, method] of [[origins[0] + '/api/v1/projects', 'POST'], [origins[0] + prefix + 'sessions?x=1', 'POST'], ['https://evil.example' + prefix + 'sessions', 'POST'], [origins[0] + prefix + 'sessions', 'DELETE']]) assert(!browserWriteAllowed(origins[0], url, method, id));
  assert.equal(ordinaryAccount({ acceptanceAccounts: [{ username: 'one', password: 'fixture' }, { username: 'admin', password: 'fixture', role: 'admin' }] }).username, 'one');
  assert.throws(() => ordinaryAccount({ accounts: { production: {} } }));
  const attempts = [], records = [];
  await cleanupSessions([['browser', {}], ['native', {}]], async (_, method) => { attempts.push(method); if (attempts.length === 1) throw new Error('fixture'); return { status: () => method === 'GET' ? 401 : 200 }; }, value => records.push(value));
  assert.deepEqual(attempts, ['DELETE', 'DELETE', 'GET']);
  assert.deepEqual(records.map(r => r.result), ['failed', 'passed']);
  console.log(JSON.stringify({ result: 'passed', step: 'offline_self_test', groups: 6 }));
}
async function production() {
  assert(process.argv.includes('--production'), 'explicit_production_flag_required');
  assert(isAbsolute(process.env.NATIVE_AUTH_CREDENTIALS_PATH ?? ''), 'explicit_absolute_credentials_path_required');
  const account = ordinaryAccount(JSON.parse(readFileSync(process.env.NATIVE_AUTH_CREDENTIALS_PATH, 'utf8')));
  const origin = process.env.RELEASE_URL || origins[1];
  assert(origins.includes(origin), 'origin_not_allowed');
  // Playwright debug tracing could print sensitive API payloads; disable it before loading.
  delete process.env.DEBUG;
  const require = createRequire(import.meta.url);
  const { chromium, request: playwrightRequest } = require(process.env.UI_PLAYWRIGHT_PATH || 'C:/Users/hmz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const report = { result: 'incomplete', steps: [] };
  const record = value => report.steps.push(value);
  let browser, context, native, step = 'initialize', transactionId;
  const counts = new Map();
  const request = async (client, method, path, data) => {
    assert(path === `${prefix}session` && ['GET', 'DELETE'].includes(method) || method === 'POST' && [`${prefix}native/transactions`, `${prefix}native/exchange`].includes(path) || method === 'GET' && uuid.test(transactionId ?? '') && path === `${prefix}native/transactions/${transactionId}`, 'request_not_allowed');
    return client.fetch(origin + path, { method, data, headers: { Origin: origin }, maxRedirects: 0, maxRetries: 0, timeout: 20000 });
  };
  try {
    const material = pkce();
    native = await playwrightRequest.newContext();
    step = 'create_transaction';
    const begin = await request(native, 'POST', `${prefix}native/transactions`, { codeChallenge: material.challenge, state: material.state });
    record({ step, status: begin.status(), result: begin.status() === 201 ? 'passed' : 'failed' });
    assert.equal(begin.status(), 201);
    const transaction = (await begin.json()).data;
    transactionId = transaction.transactionId;
    const path = authorizationPath(transaction.authorizationPath, transactionId);
    step = 'unauthenticated_transaction_info';
    const info = await request(native, 'GET', `${prefix}native/transactions/${transactionId}`);
    record({ step, status: info.status(), result: info.status() === 401 ? 'passed' : 'failed' });
    assert.equal(info.status(), 401);
    browser = await chromium.launch({ executablePath: process.env.UI_CHROMIUM_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
    await context.route('**/*', async route => {
      const req = route.request();
      if (req.method() !== 'GET') {
        const key = new URL(req.url()).pathname;
        if (!browserWriteAllowed(origin, req.url(), req.method(), transactionId) || (counts.get(key) ?? 0) >= 1) {
          record({ step: 'browser_write_guard', result: 'blocked', method: req.method() });
          return route.abort('blockedbyclient');
        }
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    step = 'authorization_document_reachable';
    const arrival = await page.goto(origin + path);
    assert.equal(arrival.status(), 200);
    record({ step, status: arrival.status(), result: 'passed' });
    await page.goto(origin + '/login');
    const button = page.getByRole('button', { name: '登录工作区', exact: true });
    await page.getByRole('textbox', { name: '用户名或邮箱', exact: true }).fill(account.username);
    await page.getByLabel('密码', { exact: true }).fill(account.password);
    step = 'login_readiness';
    // Observe normal widget readiness; never solve or remove the challenge.
    const ready = await button.waitFor({ state: 'visible' }).then(() => page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === '登录工作区' && !b.disabled), { }, { timeout: 20000 })).then(() => true, () => false);
    const challengePresent = await page.locator('[aria-label="人机验证"], .cf-turnstile, iframe[src*="challenges.cloudflare.com"]').count() > 0;
    record({ step, result: ready ? 'ready' : 'blocked', challengePresent, loginButtonEnabled: await button.isEnabled(), loginPosts: counts.get(`${prefix}sessions`) ?? 0 });
    if (!ready) {
      report.result = 'blocked';
      record({ step: 'password_login', result: challengePresent ? 'human_challenge_required' : 'login_not_ready' });
      return;
    }
    step = 'password_login';
    // Attach rejection handling before clicking so no orphan waiter rejects on timeout.
    const loginResponse = page.waitForResponse(r => new URL(r.url()).pathname === `${prefix}sessions` && r.request().method() === 'POST', { timeout: 20000 }).then(r => r, () => null);
    let login;
    try { await button.click(); } finally { login = await loginResponse; }
    record({ step, status: login?.status() ?? null, result: login?.status() === 201 ? 'passed' : login?.status() === 403 ? 'human_challenge_required' : 'failed' });
    if (login?.status() === 403) { report.result = 'blocked'; return; }
    assert.equal(login?.status(), 201);
    const browserSession = await request(context.request, 'GET', `${prefix}session`);
    assert.equal(browserSession.status(), 200);
    const user = (await browserSession.json()).data.user;
    assert.equal(user.role, 'user'); assert.equal(user.isAdmin, false);
    assert.equal(user.username, account.username);
    record({ step: 'browser_session', result: 'passed', role: user.role });
    step = 'explicit_authorization';
    await page.goto(origin + path);
    await page.getByRole('button', { name: '确认登录此账户', exact: true }).click();
    const link = page.getByRole('link', { name: '返回补位原生预览', exact: true });
    await link.waitFor();
    const code = callbackCode(await link.getAttribute('href'), material.state);
    record({ step, result: 'passed' });
    step = 'pkce_exchange';
    const body = { code, codeVerifier: material.verifier };
    const exchange = await request(native, 'POST', `${prefix}native/exchange`, body);
    record({ step, status: exchange.status(), result: exchange.status() === 201 ? 'passed' : 'failed' });
    assert.equal(exchange.status(), 201);
    const nativeSession = await request(native, 'GET', `${prefix}session`);
    assert.equal(nativeSession.status(), 200);
    const nativeUser = (await nativeSession.json()).data.user;
    assert.equal(nativeUser.id, user.id); assert.equal(nativeUser.role, user.role);
    assert.equal(nativeUser.username, user.username); assert.equal(nativeUser.isAdmin, false);
    record({ step: 'independent_native_session_matches_browser', result: 'passed', role: nativeUser.role });
    step = 'reject_code_replay';
    const replay = await request(native, 'POST', `${prefix}native/exchange`, body);
    record({ step, status: replay.status(), result: replay.status() === 400 ? 'passed' : 'failed' });
    assert.equal(replay.status(), 400);
    report.result = 'passed';
  } catch {
    // Raw exception messages can include callback URLs, request bodies or cookies.
    record({ step, result: 'failed' }); report.result = 'failed';
  } finally {
    await cleanupSessions([['browser', context?.request], ['native', native]], request, record);
    if (report.steps.some(s => s.step.startsWith('logout_') && s.result !== 'passed')) report.result = 'failed';
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await native?.dispose().catch(() => {});
    const output = resolve(process.env.NATIVE_AUTH_OUTPUT_DIR || 'output/native-production-auth');
    mkdirSync(output, { recursive: true });
    writeFileSync(resolve(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
    if (report.result !== 'passed') process.exitCode = 1;
  }
}

try {
  if (process.argv.includes('--self-test') && !process.argv.includes('--production')) await selfTest();
  else await production();
} catch {
  console.error(JSON.stringify({ step: 'preflight', result: 'failed', usage: 'Use --self-test, or --production with NATIVE_AUTH_CREDENTIALS_PATH pointing to existing saved credentials.' }));
  process.exitCode = 1;
}
