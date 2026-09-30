import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// One-shot loopback input. Never persist or print the submitted credential.
const host = '127.0.0.1';
const port = 8791;
const origin = `http://${host}:${port}`;
const nonce = randomBytes(32).toString('hex');
const backend = fileURLToPath(new URL('../backend/', import.meta.url));
const cli = fileURLToPath(new URL('../backend/node_modules/wrangler/bin/wrangler.js', import.meta.url));
let busy = false;
let saved = false;
const html = (content) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Resend 密钥安全输入</title><style>body{font:16px system-ui;max-width:650px;margin:10vh auto;padding:24px;color:#16243b;background:#f5f7fb}main{background:white;padding:32px;border-radius:18px;box-shadow:0 8px 35px #1231}input,button{box-sizing:border-box;width:100%;padding:13px;margin:12px 0;font:inherit}button{color:white;background:#2458d3;border:0;border-radius:8px}p{line-height:1.6}</style><main>${content}</main></html>`;
function respond(res, status, content) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(html(content));
}
function saveSecret(secret) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'secret', 'put', 'RESEND_API_KEY', '--env', 'production'], { cwd: backend, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    // Discard output: provider/CLI diagnostics must not echo credentials into this task.
    child.stdout.resume(); child.stderr.resume();
    const timer = setTimeout(() => { child.kill(); reject(new Error('保存超时，请检查 Cloudflare 登录状态')); }, 60000);
    child.on('error', () => { clearTimeout(timer); reject(new Error('无法启动 Wrangler')); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Worker Secret 保存失败，请检查 Wrangler 登录与权限后重试')); });
    child.stdin.on('error', () => {});
    child.stdin.end(secret + '\n');
  });
}
const server = http.createServer(async (req, res) => {
  if (req.headers.host !== `${host}:${port}`) return respond(res, 403, '<h1>拒绝请求</h1>');
  if (req.method === 'GET' && req.url === '/') {
    if (saved) return respond(res, 200, '<h1>密钥已保存</h1><p>生产 Worker 的 RESEND_API_KEY 已写入。可关闭此页面。发信域名与实际投递仍需继续验收。</p>');
    return respond(res, 200, `<h1>Resend API key</h1><p>仅本机入口。密钥只用于保存到 <strong>greenbp-team-office-backend</strong> 的生产 Worker Secret，不写入本地文件，不会回显。</p><form method="post" action="/save"><input type="hidden" name="nonce" value="${nonce}"><label for="key">粘贴刚复制的 API key</label><input id="key" name="key" type="password" autocomplete="off" required minlength="10" maxlength="4096" autofocus><button type="submit">保存到生产 Worker Secret</button></form><p>此操作只配置 Secret，不发送邮件或调用 AI。</p>`);
  }
  // Embedded app browsers can submit from an opaque origin. The per-process nonce,
  // loopback Host restriction, no CORS headers and form content type remain mandatory.
  if (req.method !== 'POST' || req.url !== '/save' || (req.headers.origin && req.headers.origin !== 'null' && req.headers.origin !== origin) || !String(req.headers['content-type']).startsWith('application/x-www-form-urlencoded')) return respond(res, 403, '<h1>拒绝请求</h1>');
  if (saved || busy) return respond(res, 409, '<h1>已保存或正在处理中</h1>');
  let raw = '';
  try {
    for await (const chunk of req) { raw += chunk.toString('utf8'); if (Buffer.byteLength(raw) > 8192) throw new Error('输入过长'); }
    const fields = new URLSearchParams(raw);
    const submittedNonce = fields.get('nonce') ?? '';
    if (submittedNonce.length !== nonce.length || !timingSafeEqual(Buffer.from(submittedNonce), Buffer.from(nonce))) return respond(res, 403, '<h1>输入页已失效，请刷新</h1>');
    let secret = fields.get('key')?.trim() ?? '';
    if (!/^re_[A-Za-z0-9_-]{7,4093}$/.test(secret)) return respond(res, 400, '<h1>格式不正确</h1><p>请粘贴 Resend 页面显示的完整 API key，刷新后重试。</p>');
    busy = true;
    await saveSecret(secret);
    secret = ''; raw = ''; fields.delete('key'); saved = true;
    console.log('PASS: production RESEND_API_KEY saved; value never printed.');
    respond(res, 200, '<h1>密钥已安全保存</h1><p>已写入生产 Worker 的 RESEND_API_KEY Secret。API key 不会回显。</p><p>下一步验证发信域名、DNS 和真实验证码投递。</p>');
    setTimeout(() => server.close(), 60000).unref();
  } catch { respond(res, 502, '<h1>保存未完成</h1><p>请检查 Cloudflare 登录与网络状态，刷新后重试。密钥未写入本地文件。</p>'); }
  finally { busy = false; raw = ''; }
});
server.requestTimeout = 15000;
server.listen(port, host, () => console.log(`Secure Resend input ready at ${origin}`));
setTimeout(() => server.close(), 30 * 60_000).unref();
