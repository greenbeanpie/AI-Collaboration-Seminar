/// <reference path="../cloudflare-bindings.d.ts" />
export type EnvName = 'local' | 'staging' | 'production';

export type AiContinuationMessage =
  | { kind: 'job-slice'; jobId: string; slice: number }
  | { kind: 'draft-preview'; instanceId: string };

export interface Env {
  /** Internal Workflow execution slice; never populated from user input or bindings. */
  AI_EXECUTION_SLICE?: true;
  /** Invocation-local dispatch count. A new Workflow instance gets a fresh context. */
  AI_EXECUTION_CONTEXT?: { modelCalls: number; generation?: number };
  AI?: Cloudflare.Env['AI'];
  DOCUMENT_IMPORTS_ENABLED?: string;
  RESOURCE_INDEX_ENABLED?: string;
  OCR_BATCH_ENABLED?: string;
  DB: D1Database;
  FILES: R2Bucket;
  PARSE_WORKFLOW: Workflow;
  AGENT_WORKFLOW: Workflow;
  /** Async barrier between Workflow slices. Optional so cron remains a safe fallback. */
  AI_CONTINUATION_QUEUE?: Queue<AiContinuationMessage>;
  ENV_NAME: EnvName;
  EMAIL_MODE: 'echo' | 'resend';
  /** 逗号分隔的写请求 Origin 白名单 */
  ALLOWED_ORIGINS: string;
  AUTH_SECRET: string;
  AI_CONFIG_SECRET?: string;
  CHECKPOINT_SECRET?: string;
  MEDIA_GRANT_SECRET?: string;
  RATE_LIMIT_SECRET?: string;
  TURNSTILE_HOSTNAMES?: string;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;
  /** Public HTTPS origin used only for short-lived MiMo media grants. */
  MEDIA_FETCH_BASE_URL?: string;
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
  /** 仅项目 owner 可以调整其他成员的 project permissions。 */
  canManagePermissions: boolean;
}

export interface AppVars {
  requestId: string;
  user?: SessionUser;
  member?: ProjectMember;
}

export type AppEnv = { Bindings: Env; Variables: AppVars };
