/// <reference path="../cloudflare-bindings.d.ts" />
export type EnvName = 'local' | 'staging' | 'production';

export interface Env {
  /** Internal Workflow execution slice; never populated from user input or bindings. */
  AI_EXECUTION_SLICE?: true;
  AI?: Cloudflare.Env['AI'];
  DOCUMENT_IMPORTS_ENABLED?: string;
  RESOURCE_INDEX_ENABLED?: string;
  OCR_BATCH_ENABLED?: string;
  DB: D1Database;
  FILES: R2Bucket;
  PARSE_WORKFLOW: Workflow;
  AGENT_WORKFLOW: Workflow;
  ENV_NAME: EnvName;
  EMAIL_MODE: 'echo' | 'resend';
  /** 逗号分隔的写请求 Origin 白名单 */
  ALLOWED_ORIGINS: string;
  AUTH_SECRET: string;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;
  ADMIN_TOKEN: string;
  RESEND_API_KEY?: string;
  /** 验证码邮件发件人（如 验证码 <noreply@example.com>）；Resend 需已验证域名 */
  EMAIL_FROM?: string;
  TURNSTILE_REQUIRED?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  AUTH_MODE?: 'invite-only' | 'turnstile';
  AUTH_ALLOWED_EMAILS?: string;
  EMAIL_DAILY_LIMIT?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

export interface SessionUser {
  id: string;
  email: string | null;
  username: string | null;
  displayName: string;
  role: import('./core/account-role').AccountRole;
  isAdmin: boolean;
}

export interface ProjectMember {
  projectId: string;
  userId: string;
  role: 'owner' | 'member';
  permissions: import('./services/project-permissions').ProjectPermissions;
  permissionsRevision: number;
  /** owner 或本项目内的平台管理员：可以调整其他成员的 project permissions。 */
  canManagePermissions: boolean;
}

export interface AppVars {
  requestId: string;
  user?: SessionUser;
  member?: ProjectMember;
}

export type AppEnv = { Bindings: Env; Variables: AppVars };
