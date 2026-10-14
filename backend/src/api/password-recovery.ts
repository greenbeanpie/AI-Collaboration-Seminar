import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { clearSessionCookie, requireUser } from '../core/auth';
import { permissionDenied } from '../core/errors';
import { issuePasswordRecovery, redeemPasswordRecovery, requestEmailPasswordRecovery } from '../services/password-recovery';
import { recoveryEmailStatus, removeRecoveryEmail, requestRecoveryEmailVerification, verifyRecoveryEmail } from '../services/recovery-email';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../services/password';

const issue = createRoute({ method: 'post', path: '/api/v1/admin/accounts/{userId}/password-recovery', tags: ['admin'],
  request: { params: z.object({ userId: z.string().uuid() }), body: { required: true, content: { 'application/json': { schema: z.object({ reason: z.string().trim().min(10).max(1000), ownershipVerified: z.literal(true) }).strict() } } } },
  responses: { 201: { content: { 'application/json': { schema: apiEnvelope(z.object({ id: z.string(), token: z.string(), expiresAt: z.string() }), 'PasswordRecoveryIssueResponse') } }, description: '仅此一次返回恢复代码；由超级管理员人工交付' } } });
const redeem = createRoute({ method: 'post', path: '/api/v1/auth/password-recovery/redeem', tags: ['auth'],
  request: { body: { required: true, content: { 'application/json': { schema: z.object({ token: z.string().max(200), newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH) }).strict() } } } },
  responses: { 200: { content: { 'application/json': { schema: apiEnvelope(z.object({ revoked: z.literal(true) }), 'PasswordRecoveryRedeemResponse') } }, description: '恢复密码并撤销全部旧会话，请重新登录' } } });
const challenge = { turnstileToken:z.string().max(2048).optional() };
const accepted = z.object({accepted:z.literal(true)});
const body = (schema:z.ZodType) => ({required:true,content:{'application/json':{schema}}});
const response = (schema:z.ZodType,name:string) => ({200:{content:{'application/json':{schema:apiEnvelope(schema,name)}},description:'账户恢复'}});
const requestEmail = createRoute({method:'post',path:'/api/v1/auth/password-recovery/request',tags:['auth'],request:{body:body(z.object({account:z.string().trim().min(1).max(254),...challenge}).strict())},responses:response(accepted,'PasswordRecoveryRequestResponse')});
const emailStatus = createRoute({method:'get',path:'/api/v1/auth/recovery-email',tags:['auth'],responses:response(z.object({email:z.string().nullable(),verified:z.boolean()}),'RecoveryEmailStatusResponse')});
const emailRequest = createRoute({method:'post',path:'/api/v1/auth/recovery-email',tags:['auth'],request:{body:body(z.object({email:z.email().max(254),currentPassword:z.string().min(1).max(128),...challenge}).strict())},responses:response(accepted,'RecoveryEmailRequestResponse')});
const emailRemove = createRoute({method:'delete',path:'/api/v1/auth/recovery-email',tags:['auth'],request:{body:body(z.object({currentPassword:z.string().min(1).max(128)}).strict())},responses:response(z.object({removed:z.literal(true)}),'RecoveryEmailRemoveResponse')});
const emailVerify = createRoute({method:'post',path:'/api/v1/auth/recovery-email/verify',tags:['auth'],request:{body:body(z.object({token:z.string().max(200)}).strict())},responses:response(z.object({verified:z.literal(true)}),'RecoveryEmailVerifyResponse')});

export function registerPasswordRecoveryRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use('/api/v1/auth/recovery-email',requireUser,async(c,next)=>{
    if(c.req.method!=='GET'&&c.req.header('X-Account-Settings')!=='1')throw permissionDenied('请从账户设置核实恢复邮箱');
    await next();
  });
  app.use('/api/v1/auth/recovery-email/verify',requireUser,async(c,next)=>{
    if(c.req.header('X-Account-Settings')!=='1')throw permissionDenied('请从账户设置核实恢复邮箱');
    await next();
  });
  const ip=(c:{req:{header(name:string):string|undefined}})=>c.req.header('cf-connecting-ip')??'unknown';
  app.openapi(requestEmail,async c=>c.json(apiData(c,await requestEmailPasswordRecovery(c.env,c.req.valid('json') as {account:string;turnstileToken?:string},ip(c),work=>c.executionCtx.waitUntil(work))),200));
  app.openapi(emailStatus,async c=>c.json(apiData(c,await recoveryEmailStatus(c.env,c.get('user')!.id)),200));
  app.openapi(emailRequest,async c=>c.json(apiData(c,await requestRecoveryEmailVerification(c.env,c.get('user')!.id,c.req.valid('json') as {email:string;currentPassword:string;turnstileToken?:string},ip(c))),200));
  app.openapi(emailRemove,async c=>c.json(apiData(c,await removeRecoveryEmail(c.env,c.get('user')!.id,(c.req.valid('json') as {currentPassword:string}).currentPassword)),200));
  app.openapi(emailVerify,async c=>c.json(apiData(c,await verifyRecoveryEmail(c.env,c.get('user')!.id,(c.req.valid('json') as {token:string}).token,ip(c))),200));
  app.use('/api/v1/admin/accounts/:userId/password-recovery', requireUser, async (c, next) => {
    if (c.get('user')?.role !== 'super_admin' || c.req.header('X-Password-Recovery') !== '1') throw permissionDenied('需要超级管理员账户核实恢复请求');
    await next();
  });
  app.openapi(issue, async c => c.json(apiData(c, await issuePasswordRecovery(c.env, c.get('user')!, c.req.valid('param').userId, c.req.valid('json').reason)), 201));
  app.openapi(redeem, async c => {
    const { token, newPassword } = c.req.valid('json');
    await redeemPasswordRecovery(c.env, token, newPassword, c.req.header('cf-connecting-ip') ?? 'unknown');
    c.header('Set-Cookie', clearSessionCookie());
    return c.json(apiData(c, { revoked: true as const }), 200);
  });
}
