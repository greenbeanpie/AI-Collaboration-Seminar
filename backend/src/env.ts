export type EnvName = 'local' | 'staging' | 'production';

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
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
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
}

export interface ProjectMember {
  projectId: string;
  userId: string;
  role: 'owner' | 'member';
}

export interface AppVars {
  requestId: string;
  user?: SessionUser;
  member?: ProjectMember;
}

export type AppEnv = { Bindings: Env; Variables: AppVars };
