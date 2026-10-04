import { registerDocumentImportRoutes } from './api/document-imports';
import { resourceIndexApi } from './api/resource-index';
import { registerMultipartRoutes } from './api/file-multipart';
import { registerUsernameInvitationRoutes } from './api/username-invitations';
import { registerTaskInquiryRoutes } from './api/task-inquiries';
import { registerProjectSimplificationRoutes } from './api/project-simplification';
import { registerResourceRoutes } from './api/resources';
import { registerAiToolRoutes } from './api/ai-tools';
import { registerCreationDraftRoutes } from './api/creation-drafts';
import { registerNotificationRoutes } from './api/notifications';
import { registerPersonalProfileRoutes } from './api/personal-profiles';
import { registerCollaborationRoutes } from './api/collaboration';
import { registerSupportTicketRoutes } from './api/support-tickets';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from './env';
import { AppError, validationFailed } from './core/errors';
import { failureBody, requestIdMiddleware } from './core/http';
import { registerSystemRoutes } from './api/health';
import { registerCapabilitiesRoutes } from './api/capabilities';
import { registerFileRoutes } from './api/files';
import { registerAdminRoutes } from './api/admin';
import { registerAiDiagnosticsRoutes } from './api/ai-diagnostics';
import { registerAccountSettingsRoutes } from './api/account-settings';
import { registerAuthRoutes } from './api/auth';
import { registerProjectRoutes } from './api/projects';
import { registerMemberRoutes } from './api/members';
import { registerInvitationRoutes } from './api/invitations';
import { registerSourceRoutes } from './api/sources';
import { registerSourceProcessingRoutes } from './api/source-processing';
import { registerRequirementRoutes } from './api/requirements';
import { registerJobRoutes } from './api/jobs';
import { registerTaskRoutes } from './api/tasks';
import { registerAssignmentRoutes } from './api/assignment';
import { registerMaterialRoutes } from './api/materials';
import { registerAgentRoutes } from './api/agents';
import { registerReviewRoutes } from './api/reviews';
import { registerRehearsalRoutes } from './api/rehearsals';
import { registerLedgerRoutes } from './api/ledger';
import { requireAllowedOrigin } from './core/origin';
import { registerOfflineSyncRoutes } from './api/offline-sync';

export function createApp(): OpenAPIHono<AppEnv> {
  // 校验失败统一走 ApiFailure 契约（不再使用 zod-openapi 默认的 {success:false} 形状）
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        throw validationFailed('请求参数不合法', {
          issues: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
        });
      }
      // 校验成功时不干预，放行到业务 handler
      return undefined as unknown as Response;
    },
  });

  app.use('*', requestIdMiddleware);
  // Private account/support data, including validation, auth and Origin failures, must not be cached.
  app.use('*', async (c, next) => {
    if (/^\/api\/v1\/(?:invitations(?:\/|$)|creation-drafts(?:\/|$)|jobs(?:\/|$)|projects\/[^/]+\/(?:files|sources|resource-library|goal|standards|assessments|ai-tools|ai\/clarifications|username-invitations|invitation-requests|offline-sync|collaboration\/(?:proposals|feedback))(?:\/|$)|profiles(?:\/|$)|support(?:\/|$)|notifications(?:\/|$)|admin\/(?:accounts|ai-config|ai-diagnostics)(?:\/|$)|auth(?:\/|$))/.test(c.req.path)) c.header('Cache-Control', 'no-store');
    await next();
  });
  app.use('*', requireAllowedOrigin);

  app.onError((err, c) => {
    const requestId = c.get('requestId') ?? crypto.randomUUID();
    if (err instanceof AppError) {
      if (err.status >= 500) {
        console.error(JSON.stringify({event:'request_failed',requestId,code:err.code,httpStatus:err.status,retryable:err.retryable}));
      }
      return c.json(failureBody(err.code, err.message, err.retryable, requestId, err.details), err.status as 400);
    }
    console.error(JSON.stringify({event:'request_failed',requestId,code:'INTERNAL',httpStatus:500,retryable:false}));
    return c.json(failureBody('INTERNAL', '服务器内部错误', false, requestId), 500);
  });

  app.notFound((c) => {
    const requestId = c.get('requestId') ?? crypto.randomUUID();
    return c.json(failureBody('NOT_FOUND', '接口不存在', false, requestId), 404);
  });

  // 所有域路由直接注册到本实例（带完整 /api/v1 前缀），保证契约文档完整
  registerSystemRoutes(app);
  registerCapabilitiesRoutes(app);
  registerAuthRoutes(app);
  registerAccountSettingsRoutes(app);
  registerPersonalProfileRoutes(app);
  registerCreationDraftRoutes(app);
  registerProjectRoutes(app);
  registerProjectSimplificationRoutes(app);
  registerMemberRoutes(app);
  registerInvitationRoutes(app);
  registerUsernameInvitationRoutes(app);
  registerSourceRoutes(app);
  registerSourceProcessingRoutes(app);
  registerRequirementRoutes(app);
  registerJobRoutes(app);
  registerTaskRoutes(app);
  registerTaskInquiryRoutes(app);
  registerCollaborationRoutes(app);
  registerAssignmentRoutes(app);
  registerMaterialRoutes(app);
  registerResourceRoutes(app);
  registerAgentRoutes(app);
  registerAiToolRoutes(app);
  registerReviewRoutes(app);
  registerRehearsalRoutes(app);
  registerLedgerRoutes(app);
  registerFileRoutes(app);
  registerMultipartRoutes(app);
  registerDocumentImportRoutes(app);
  app.route('/api/v1',resourceIndexApi);
  registerAdminRoutes(app);
  registerAiDiagnosticsRoutes(app);
  registerSupportTicketRoutes(app);
  registerNotificationRoutes(app);
  registerOfflineSyncRoutes(app);

  app.doc31('/api/v1/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: '「补位」AI 项目办公室 API',
      version: '0.1.0',
      description:
        '契约唯一来源：前端 MSW 以此为依据。接口契约由双方共同确认，不得单方面修改（见 backend_plan.md 第 1 节）。',
    },
    servers: [{ url: '/' }],
  });

  return app;
}
