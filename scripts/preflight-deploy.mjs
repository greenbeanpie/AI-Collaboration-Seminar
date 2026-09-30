import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../backend/package.json', import.meta.url));
const ts = require('typescript');
const environment = process.argv[2];
if (!['staging', 'production'].includes(environment)) {
  console.error('Usage: npm run preflight:deploy -- staging|production');
  process.exit(1);
}
function config(path) {
  const parsed = ts.parseConfigFileTextToJson(path, readFileSync(new URL(path, import.meta.url), 'utf8'));
  if (parsed.error) throw new Error(`Invalid config ${path}`);
  return parsed.config;
}
const backend = config('../backend/wrangler.jsonc');
const frontend = config('../frontend/wrangler.jsonc');
const api = backend.env?.[environment];
const web = frontend.env?.[environment];
const problems = [];
const check = (condition, message) => { if (!condition) problems.push(message); };
check(api && web, '缺少目标环境配置');
check(api?.vars?.ENV_NAME === environment, 'ENV_NAME 与目标环境不符');
check(api?.vars?.EMAIL_MODE === 'resend', '云端必须使用真实邮件模式');
check(Boolean(api?.vars?.EMAIL_FROM) && !/@resend\.dev(?:>|$)/i.test(api?.vars?.EMAIL_FROM ?? ''), '填写自有已验证域名的 EMAIL_FROM（不能使用 resend.dev 测试发件人）');
check(api?.vars?.AUTH_MODE === 'invite-only' || (api?.vars?.TURNSTILE_REQUIRED === 'true' && Boolean(api?.vars?.TURNSTILE_SITE_KEY)), '云端登录必须为邀请制或已启用 Turnstile；禁止无防护公开注册');
check(api?.d1_databases?.some(db => db.binding === 'DB' && /^[0-9a-f-]{36}$/i.test(db.database_id)), '填写真实 D1 database_id');
check(api?.r2_buckets?.some(bucket => bucket.binding === 'FILES' && bucket.bucket_name && !bucket.bucket_name.includes('local')), '填写云端私有 R2 绑定');
check(api?.workflows?.some(w => w.binding === 'PARSE_WORKFLOW') && api?.workflows?.some(w => w.binding === 'AGENT_WORKFLOW'), '两个 Workflow 绑定必须齐全');
check(web?.services?.some(service => service.binding === 'API' && service.service === api?.name), '前端 API Service Binding 必须指向同环境后端');
const origins = api?.vars?.ALLOWED_ORIGINS?.split(',').map(x => x.trim()).filter(Boolean) ?? [];
check(origins.length > 0 && origins.every(origin => {
  try { const url = new URL(origin); return url.protocol === 'https:' && url.origin === origin && !['localhost', '127.0.0.1'].includes(url.hostname); } catch { return false; }
}), '填写前端 HTTPS Origin 白名单（无路径）');
if (problems.length) { problems.forEach(p => console.error(`BLOCKED: ${p}`)); process.exitCode = 1; }
else console.log(`PASS: ${environment} 静态部署配置。仍需验收 Secrets、邮件、模型、监控和恢复；此命令不会部署。`);
