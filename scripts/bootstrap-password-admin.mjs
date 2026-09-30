import { randomBytes, randomUUID, pbkdf2Sync, scryptSync, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const environment = process.argv.includes('--production') ? 'production' : process.argv.includes('--local') ? 'local' : null;
if (!environment || (process.argv.includes('--local') && process.argv.includes('--production'))) throw new Error('Use exactly one of --local or --production explicitly');
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, '.local-secrets');
const credentialsPath = join(directory, 'admin-credentials.json');
const username = 'greenbp';
const email = 'zgpride87@outlook.com';
mkdirSync(directory, { recursive: true, mode: 0o700 });

// On Windows, limit inherited file access to the current user's identity.
if (process.platform === 'win32') {
  const aclScript = `$target = '${directory.replaceAll("'", "''")}'; $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name; $acl = [System.Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true, $false); $acl.SetAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')); [System.IO.FileSystemAclExtensions]::SetAccessControl([System.IO.DirectoryInfo]::new($target), $acl)`;
  execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', aclScript], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}
execFileSync('git', ['check-ignore', '--quiet', credentialsPath], { cwd: root, stdio: 'ignore' });
const credentials = existsSync(credentialsPath) ? JSON.parse(readFileSync(credentialsPath, 'utf8')) : { version: 1, accounts: {} };
if (!credentials.accounts[environment]) {
  credentials.accounts[environment] = { username, email, password: randomBytes(24).toString('base64url'), loginUrl: environment === 'production' ? 'https://greenbp-team-office.hddhp.workers.dev/login' : 'http://localhost:5173/login', createdAt: new Date().toISOString(), initialized: false };
  writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600 });
}
const account = credentials.accounts[environment];
if (account.username !== username || account.email !== email) throw new Error('Credential file belongs to a different administrator; not overwriting');
const cli = join(root, 'backend/node_modules/wrangler/bin/wrangler.js');
const environmentArgs = environment === 'production' ? ['--env', 'production', '--remote'] : ['--local'];
const sqlPath = join(directory, `bootstrap-${environment}.sql`);
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
function query(sql) {
  writeFileSync(sqlPath, sql, { mode: 0o600 });
  try {
    const raw = execFileSync(process.execPath, [cli, 'd1', 'execute', 'DB', ...environmentArgs, '--config', join(root, 'backend/wrangler.jsonc'), ...(sql.trimStart().startsWith('SELECT') ? ['--command', sql] : ['--file', sqlPath]), '--json'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(raw.slice(raw.indexOf('['))).flatMap(result => result.results ?? []);
  } catch (error) {
    const diagnostic = (String(error.stderr ?? '') + String(error.stdout ?? '')).replaceAll(account.password, '[REDACTED]').replace(/(?:pbkdf2-sha256|scrypt)\$[^'\s]+/g, '[HASH REDACTED]');
    const messages = diagnostic.split(/\r?\n/).filter(line => /error|failed|constraint|syntax|transaction/i.test(line));
    throw new Error('Administrator bootstrap query failed: ' + messages.join(' ').slice(0, 600));
  }
  finally { rmSync(sqlPath, { force: true }); }
}
const kdfOptions = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
function verify(password, encoded) {
  const parts = String(encoded).split('$');
  let calculated; let bytes;
  if (parts.length === 6 && parts.slice(0,4).join('$') === 'scrypt$32768$8$3') {
    calculated = scryptSync(password, Buffer.from(parts[4], 'base64'), 32, kdfOptions);
    bytes = Buffer.from(parts[5], 'base64');
  } else if (parts.length === 4 && parts[0] === 'pbkdf2-sha256' && parts[1] === '600000' && process.argv.includes('--upgrade-kdf')) {
    calculated = pbkdf2Sync(password, Buffer.from(parts[2], 'base64'), 600000, 32, 'sha256');
    bytes = Buffer.from(parts[3], 'base64');
  } else return false;
  return bytes.length === calculated.length && timingSafeEqual(bytes, calculated);
}
const matches = query(`SELECT DISTINCT u.id FROM users u LEFT JOIN auth_accounts a ON a.user_id = u.id WHERE lower(u.email) = ${quote(email)} OR a.contact_email_norm = ${quote(email)};`);
if (matches.length > 1) throw new Error('Multiple existing identities match the administrator email; manual reconciliation required');
const existing = query(`SELECT user_id, password_hash, is_admin FROM auth_accounts WHERE username_norm = ${quote(username)};`);
if (existing.length && (!matches.length || existing[0].user_id !== matches[0].id)) throw new Error('Administrator username is owned by a different identity; not overwriting');
if (account.initialized && existing.length) {
  if (existing[0].is_admin !== 1) throw new Error('Saved account no longer has system administrator permissions; manual reconciliation required');
  if (!verify(account.password, existing[0].password_hash)) throw new Error('Existing password differs from saved credentials; not resetting silently');
  if (String(existing[0].password_hash).startsWith('scrypt$')) {
    console.log(`PASS: ${environment} administrator already initialized; private credential file reused.`);
    process.exit(0);
  }
  if (!process.argv.includes('--upgrade-kdf')) throw new Error('Existing KDF requires explicit --upgrade-kdf');
}
const userId = matches[0]?.id ?? randomUUID();
const salt = randomBytes(16);
const passwordHash = `scrypt$32768$8$3$${salt.toString('base64')}$${scryptSync(account.password, salt, 32, kdfOptions).toString('base64')}`;
const now = new Date().toISOString();
const commands = [];
if (!matches.length) commands.push(`INSERT INTO users (id, email, display_name, created_at) VALUES (${quote(userId)}, ${quote('account:' + userId)}, ${quote(username)}, ${quote(now)});`);
commands.push(`INSERT INTO auth_accounts (user_id,username,username_norm,contact_email,contact_email_norm,email_verified,password_hash,is_admin,account_role,created_at) VALUES (${quote(userId)},${quote(username)},${quote(username)},${quote(email)},${quote(email)},${matches.length ? 1 : 0},${quote(passwordHash)},1,'super_admin',${quote(now)}) ON CONFLICT(user_id) DO UPDATE SET username=excluded.username,username_norm=excluded.username_norm,contact_email=excluded.contact_email,contact_email_norm=excluded.contact_email_norm,email_verified=excluded.email_verified,password_hash=excluded.password_hash,is_admin=1,account_role='super_admin';`);
commands.push(`UPDATE sessions SET revoked_at=${quote(now)} WHERE user_id=${quote(userId)} AND revoked_at IS NULL;`);
query(commands.join('\n'));
const checked = query(`SELECT user_id, is_admin FROM auth_accounts WHERE username_norm=${quote(username)};`);
if (checked[0]?.user_id !== userId || checked[0]?.is_admin !== 1) throw new Error('Administrator initialization not confirmed');
account.userId = userId; account.initialized = true;
account.existingIdentityPreserved = Boolean(matches.length);
writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600 });
console.log(`PASS: ${environment} administrator initialized; existing identity preserved=${Boolean(matches.length)}. Credentials saved only to .local-secrets/admin-credentials.json (gitignored).`);
