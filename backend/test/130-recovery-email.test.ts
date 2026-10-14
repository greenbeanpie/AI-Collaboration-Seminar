import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { registerPasswordRecoveryRoutes } from '../src/api/password-recovery';
import { env, BASE } from './helpers/env';
import { seedUser, authCookie } from './helpers/seed';
import { hashPassword, verifyPassword } from '../src/services/password';
import { recoveryLinkOrigin, sendRecoveryEmail } from '../src/email/resend';
import { newId, sha256Hex } from '../src/core/db';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import type { Env } from '../src/env';

const app=createApp();registerPasswordRecoveryRoutes(app);
const currentPassword='current-password-12345',newPassword='new-recovery-password-12345';
let messages:{path:string;init:RequestInit;body:{to:string[];text:string}}[]=[];
const configured=()=>({...env,EMAIL_MODE:'resend' as const,EMAIL_FROM:'补位 <login@auth.example.com>',RESEND_API_KEY:'synthetic-test-key',APP_ORIGIN:'https://example.com',TURNSTILE_REQUIRED:'false'});
const send=async(path:string,body:unknown,cookie?:string,method='POST',runtime:Env & {APP_ORIGIN?:string}=configured())=>{
  const ctx=createExecutionContext();
  const response=await app.request(BASE+path,{method,headers:{'content-type':'application/json',...(cookie?{cookie,'X-Account-Settings':'1'}:{}),'cf-connecting-ip':'192.0.2.1'},...(method==='GET'?{}:{body:JSON.stringify(body)})},runtime,ctx);
  await waitOnExecutionContext(ctx);return response;
};
const code=()=>new URL(messages.at(-1)!.body.text.match(/https:\/\/[^\s]+/)![0]).hash.slice('#token='.length);
async function user(){const result=await seedUser();await env.DB.prepare('UPDATE auth_accounts SET password_hash=?2 WHERE user_id=?1').bind(result.userId,await hashPassword(currentPassword)).run();return result;}
async function bind(user:Awaited<ReturnType<typeof seedUser>>,email='verified@example.com'){
  expect((await send('/api/v1/auth/recovery-email',{email,currentPassword},authCookie(user.token))).status).toBe(200);
  const token=code();expect((await send('/api/v1/auth/recovery-email/verify',{token},authCookie(user.token))).status).toBe(200);return token;
}
beforeEach(async()=>{
  messages=[];await env.DB.batch(['auth_email_dispatches','auth_email_daily_usage','auth_email_recipient_usage','auth_password_rate_limits'].map(table=>env.DB.prepare(`DELETE FROM ${table}`)));
  vi.spyOn(globalThis,'fetch').mockImplementation(async(path,init)=>{messages.push({path:String(path),init:init!,body:JSON.parse(init!.body as string)});return Response.json({id:'synthetic'});});
});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});

it('sends no recovery email for unverified or missing accounts, with the same public accepted shape',async()=>{
  const target=await user();
  const missing=await send('/api/v1/auth/password-recovery/request',{account:'missing-user'}),unverified=await send('/api/v1/auth/password-recovery/request',{account:target.email});
  expect(missing.status).toBe(200);expect(unverified.status).toBe(200);
  expect((await missing.json() as {data:unknown}).data).toEqual((await unverified.json() as {data:unknown}).data);
  expect(messages).toHaveLength(0);expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM password_recovery_tokens').first<{n:number}>())!.n).toBe(0);
});
it('verifies possession under the original account only, stores hash and never returns token to the requester',async()=>{
  const target=await user(),other=await user();
  expect((await send('/api/v1/auth/recovery-email',{email:'new@example.com',currentPassword:'wrong'},authCookie(target.token))).status).toBe(400);expect(messages).toHaveLength(0);
  const requested=await send('/api/v1/auth/recovery-email',{email:'new@example.com',currentPassword},authCookie(target.token));
  expect(requested.status).toBe(200);expect(await requested.text()).not.toContain('token');
  const token=code(),record=await env.DB.prepare('SELECT * FROM recovery_email_verifications WHERE user_id=?1').bind(target.userId).first();
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(record?.token_hash).toBe(await sha256Hex(token));expect(JSON.stringify(record)).not.toContain(token);
  expect((await send('/api/v1/auth/recovery-email/verify',{token},authCookie(other.token))).status).toBe(400);
  const responses=await Promise.all([1,2].map(()=>send('/api/v1/auth/recovery-email/verify',{token},authCookie(target.token))));expect(responses.map(response=>response.status).sort()).toEqual([200,400]);
  const status=await send('/api/v1/auth/recovery-email',null,authCookie(target.token),'GET');expect((await status.json() as {data:unknown}).data).toEqual({email:'new@example.com',verified:true});
  expect(messages[0]!.path).toBe('https://api.resend.com/emails');expect(new Headers(messages[0]!.init.headers).get('Idempotency-Key')).toMatch(/^recovery-email\//);
});
it('email password recovery is single-use, revokes sessions, and refuses recovery after unbinding and rebinding the same email',async()=>{
  const target=await user();await bind(target);
  await env.DB.prepare("UPDATE auth_email_dispatches SET created_at='2000-01-01'").run();
  const response=await send('/api/v1/auth/password-recovery/request',{account:'verified@example.com'});expect(response.status).toBe(200);
  const token=code();expect(await response.text()).not.toContain(token);
  const results=await Promise.all([newPassword,newPassword+'other'].map(password=>send('/api/v1/auth/password-recovery/redeem',{token,newPassword:password})));expect(results.filter(result=>result.status===200)).toHaveLength(1);
  const account=await env.DB.prepare('SELECT password_hash FROM auth_accounts WHERE user_id=?1').bind(target.userId).first<{password_hash:string}>();expect(await verifyPassword(newPassword,account!.password_hash)||await verifyPassword(newPassword+'other',account!.password_hash)).toBe(true);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?1 AND revoked_at IS NULL').bind(target.userId).first<{n:number}>())?.n).toBe(0);
  // A second account proves email version fencing, including the ABA return to the same address.
  const next=await user();await bind(next,'next@example.com');await env.DB.prepare("UPDATE auth_email_dispatches SET created_at='2000-01-01'").run();
  await send('/api/v1/auth/password-recovery/request',{account:'next@example.com'});const stale=code();
  expect((await send('/api/v1/auth/recovery-email',{currentPassword},authCookie(next.token),'DELETE')).status).toBe(200);
  await env.DB.prepare("UPDATE auth_email_dispatches SET created_at='2000-01-01'").run();await bind(next,'next@example.com');
  expect((await send('/api/v1/auth/password-recovery/redeem',{token:stale,newPassword})).status).toBe(400);
});
it('invalidates verification when password/email changes and enforces unique email at consumption',async()=>{
  const target=await user(),other=await user();
  await send('/api/v1/auth/recovery-email',{email:'taken@example.com',currentPassword},authCookie(target.token));const taken=code();
  await env.DB.prepare("UPDATE auth_accounts SET contact_email_norm='taken@example.com',contact_email='taken@example.com' WHERE user_id=?1").bind(other.userId).run();
  expect((await send('/api/v1/auth/recovery-email/verify',{token:taken},authCookie(target.token))).status).toBe(400);
  await send('/api/v1/auth/recovery-email',{email:'changed@example.com',currentPassword},authCookie(target.token));const changed=code();
  await env.DB.prepare("UPDATE auth_accounts SET password_hash='changed' WHERE user_id=?1").bind(target.userId).run();
  expect((await send('/api/v1/auth/recovery-email/verify',{token:changed},authCookie(target.token))).status).toBe(400);
});
it('uses only a strictly configured origin and fragments, rejecting origin injection and multiple fallback origins',async()=>{
  const target=await user();
  expect(recoveryLinkOrigin({...configured(),APP_ORIGIN:undefined,ALLOWED_ORIGINS:'https://first.example,https://second.example'})).toBeNull();
  for(const value of ['https://evil.example/path','https://u:p@evil.example','https://evil.example?redirect=1','https://evil.example#x','https://evil.example\\@example.com','http://example.com'])expect(recoveryLinkOrigin({...configured(),APP_ORIGIN:value})).toBeNull();
  await send('/api/v1/auth/recovery-email',{email:'safe@example.com',currentPassword},authCookie(target.token));
  expect(messages[0]!.body.text).toContain('https://example.com/email-verify#token=');expect(messages[0]!.body.text).not.toContain('?token=');
  expect(await sendRecoveryEmail({...configured(),APP_ORIGIN:'https://evil.example/path'},{id:newId(),userId:target.userId,recipient:'safe@example.com',kind:'verification',token:'a'.repeat(43)})).toBe('unavailable');expect(messages).toHaveLength(1);
});
it('atomically caps all concurrent send reservations at platform30 and leaves unknown attempts charged',async()=>{
  const target=await user();
  expect(recoveryLinkOrigin(configured())).toBe('https://example.com');
  const outcomes=await Promise.all(Array.from({length:40},(_,index)=>sendRecoveryEmail(configured(),{id:newId(),userId:target.userId,recipient:`recipient${index}@example.com`,kind:index%2?'verification':'recovery',token:'a'.repeat(43)})));
  expect(outcomes.filter(value=>value==='sent'),JSON.stringify(outcomes)).toHaveLength(30);expect(messages).toHaveLength(30);expect((await env.DB.prepare('SELECT sends FROM auth_email_daily_usage').first<{sends:number}>())?.sends).toBe(30);
});
it('keeps unknown delivery valid and never retries a 15second sender interruption',async()=>{
  const target=await user();vi.useFakeTimers();
  vi.mocked(fetch).mockImplementation(async(_path,init)=>new Promise((_resolve,reject)=>{messages.push({path:String(_path),init:init!,body:JSON.parse(init!.body as string)});init!.signal!.addEventListener('abort',()=>reject(new DOMException('timeout','AbortError')));}));
  const result=sendRecoveryEmail(configured(),{id:newId(),userId:target.userId,recipient:'unknown@example.com',kind:'verification',token:'a'.repeat(43)});
  // Wait for D1 admission to finish before advancing the sender's own timer.
  await vi.waitFor(()=>expect(messages).toHaveLength(1));await vi.advanceTimersByTimeAsync(15_000);
  expect(await result).toBe('unknown');expect(messages).toHaveLength(1);
  expect((await env.DB.prepare('SELECT status FROM auth_email_dispatches').first())?.status).toBe('unknown');expect((await env.DB.prepare('SELECT sends FROM auth_email_daily_usage').first())?.sends).toBe(1);
});
it('enforces required Turnstile before lookup/sending and limits public identity guessing',async()=>{
  const response=await send('/api/v1/auth/password-recovery/request',{account:'anything'},undefined,'POST',{...configured(),TURNSTILE_REQUIRED:'true'});expect(response.status).toBe(403);expect(messages).toHaveLength(0);
  await env.DB.prepare('DELETE FROM auth_password_rate_limits').run();
  for(let index=0;index<5;index++)expect((await send('/api/v1/auth/password-recovery/request',{account:'unknown'})).status).toBe(200);
  expect((await send('/api/v1/auth/password-recovery/request',{account:'unknown'})).status).toBe(429);
});

it('returns accepted before supplier delivery finishes and keeps its token usable after unknown delivery',async()=>{
 const target=await user();await env.DB.prepare('UPDATE auth_accounts SET email_verified=1 WHERE user_id=?1').bind(target.userId).run();
 let finish:(value:Response)=>void=()=>{};
 vi.mocked(fetch).mockImplementation(async(path,init)=>{messages.push({path:String(path),init:init!,body:JSON.parse(init!.body as string)});return new Promise(resolve=>{finish=resolve;});});
 const ctx=createExecutionContext();
 const response=await app.request(BASE+'/api/v1/auth/password-recovery/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({account:target.email})},configured(),ctx);
 expect(response.status).toBe(200);expect((await response.json() as {data:unknown}).data).toEqual({accepted:true});
 await vi.waitFor(()=>expect(messages).toHaveLength(1));const token=code();finish(new Response(null,{status:503}));await waitOnExecutionContext(ctx);
 expect((await env.DB.prepare('SELECT status FROM auth_email_dispatches').first())?.status).toBe('unknown');
 expect((await send('/api/v1/auth/password-recovery/redeem',{token,newPassword})).status).toBe(200);expect(messages).toHaveLength(1);
});

it('caps recipients across both mail types with cooldown and five per day',async()=>{
 const target=await user();const mail=(kind:'verification'|'recovery')=>sendRecoveryEmail(configured(),{id:newId(),userId:target.userId,recipient:'bounded@example.com',kind,token:'a'.repeat(43)});
 expect(await mail('verification')).toBe('sent');expect(await mail('recovery')).toBe('limited');
 for(let index=1;index<5;index++){await env.DB.prepare("UPDATE auth_email_dispatches SET created_at='2000-01-01'").run();expect(await mail(index%2?'recovery':'verification')).toBe('sent');}
 await env.DB.prepare("UPDATE auth_email_dispatches SET created_at='2000-01-01'").run();expect(await mail('recovery')).toBe('limited');expect(messages).toHaveLength(5);
});

it('administrator fallback codes also carry the email version snapshot and never trust unverified email',async()=>{
 const actor=await user(),target=await user();await env.DB.prepare("UPDATE auth_accounts SET account_role='super_admin' WHERE user_id=?1").bind(actor.userId).run();
 const response=await app.request(BASE+`/api/v1/admin/accounts/${target.userId}/password-recovery`,{method:'POST',headers:{'content-type':'application/json',cookie:authCookie(actor.token),'X-Password-Recovery':'1'},body:JSON.stringify({reason:'通过线下资料及成员关系确认账户归属',ownershipVerified:true})},configured());
 expect(response.status).toBe(201);const {token}=(await response.json() as {data:{token:string}}).data;
 expect((await send('/api/v1/auth/recovery-email',{currentPassword},authCookie(target.token),'DELETE')).status).toBe(200);
 expect((await send('/api/v1/auth/password-recovery/redeem',{token,newPassword})).status).toBe(400);expect(messages).toHaveLength(0);
});

it('echo mode never discloses a development recovery code and provider failures never expose provider bodies',async()=>{
 const target=await user();await env.DB.prepare('UPDATE auth_accounts SET email_verified=1 WHERE user_id=?1').bind(target.userId).run();
 const warning=vi.spyOn(console,'warn').mockImplementation(()=>{}),error=vi.spyOn(console,'error').mockImplementation(()=>{});
 const response=await send('/api/v1/auth/password-recovery/request',{account:target.email},undefined,'POST',{...configured(),EMAIL_MODE:'echo'});
 expect(response.status).toBe(200);expect(await response.text()).not.toMatch(/devCode|token|email/);expect(messages).toHaveLength(0);
 vi.mocked(fetch).mockImplementation(async(path,init)=>{messages.push({path:String(path),init:init!,body:JSON.parse(init!.body as string)});return new Response('sensitive-provider-body',{status:422});});
 const failed=await send('/api/v1/auth/password-recovery/request',{account:target.email});expect(failed.status).toBe(200);expect(await failed.text()).not.toContain('sensitive-provider-body');
 const token=code();expect(JSON.stringify([...warning.mock.calls,...error.mock.calls])).not.toContain(token);expect(JSON.stringify([...warning.mock.calls,...error.mock.calls])).not.toContain(target.email);
});

it('an expired email verification token and revoked session cannot mutate the email binding',async()=>{
 const target=await user();await send('/api/v1/auth/recovery-email',{email:'expire@example.com',currentPassword},authCookie(target.token));const token=code();
 await env.DB.prepare("UPDATE recovery_email_verifications SET expires_at='2000-01-01' WHERE user_id=?1").bind(target.userId).run();
 expect((await send('/api/v1/auth/recovery-email/verify',{token},authCookie(target.token))).status).toBe(400);
 await env.DB.prepare("UPDATE sessions SET revoked_at='2026-01-01' WHERE user_id=?1").bind(target.userId).run();expect((await send('/api/v1/auth/recovery-email/verify',{token},authCookie(target.token))).status).toBe(401);
 expect((await env.DB.prepare('SELECT email_verified FROM auth_accounts WHERE user_id=?1').bind(target.userId).first())?.email_verified).toBe(0);
});
