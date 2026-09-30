import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { LIMITS } from '../core/limits';

const capabilitiesResponse = apiEnvelope(
  z
    .object({
      apiVersion: z.literal('v1'),
      environment: z.string(),
      features: z
        .object({
          aiEnabled: z.boolean(),
          webFetch: z.boolean(),
          emailMode: z.enum(['echo', 'resend']),
        })
        .openapi({ description: 'AI 是否启用由 ai_config_versions 决定；不暴露任何密钥' }),
      limits: z.object({
        maxFileBytes: z.number().int(),
        maxPdfPages: z.number().int(),
        pageImageMaxEdge: z.number().int(),
        pageImageMaxBytes: z.number().int(),
        listDefaultPageSize: z.number().int(),
        listMaxPageSize: z.number().int(),
        concurrentAiTasksPerProject: z.number().int(),
        assignmentSuggestionMaxTasks: z.number().int(),
      }),
      competitionTemplate: z
        .object({
          teamSizeLimit: z.number().int().nullable(),
        })
        .openapi({ description: '本赛事模板参数；仅作为创建项目时的默认建议，不硬编码为所有项目的限制' }),
    }),
  'CapabilitiesResponse',
);

const capabilitiesRoute = createRoute({
  method: 'get',
  path: '/api/v1/capabilities',
  tags: ['system'],
  summary: '系统能力与限制（公开接口）',
  responses: {
    200: { content: { 'application/json': { schema: capabilitiesResponse } }, description: '能力与限制' },
  },
});

/** 读取最新 AI 配置版本的启用状态；表尚未建立（如纯 M0 环境）时按未启用处理 */
async function isAiEnabled(db: D1Database): Promise<boolean> {
  try {
    const row = await db
      .prepare('SELECT enabled FROM ai_config_versions ORDER BY version DESC LIMIT 1')
      .first<{ enabled: number }>();
    return row?.enabled === 1;
  } catch {
    return false;
  }
}

/** 读取比赛模板配置；缺失时返回 null */
async function competitionTemplate(db: D1Database): Promise<{ teamSizeLimit: number | null }> {
  try {
    const row = await db
      .prepare("SELECT value_json FROM app_config WHERE key = 'competition_template'")
      .first<{ value_json: string }>();
    if (!row) return { teamSizeLimit: null };
    const parsed = JSON.parse(row.value_json) as { teamSizeLimit?: number };
    return { teamSizeLimit: typeof parsed.teamSizeLimit === 'number' ? parsed.teamSizeLimit : null };
  } catch {
    return { teamSizeLimit: null };
  }
}

/**
 * 路由直接注册到根 OpenAPIHono 实例（带完整 /api/v1 前缀），
 * 保证 getOpenAPI31Document 能收集到全部契约路径。
 */
export function registerCapabilitiesRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(capabilitiesRoute, async (c) => {
    const [aiEnabled, template] = await Promise.all([isAiEnabled(c.env.DB), competitionTemplate(c.env.DB)]);
    return c.json(
      apiData(c, {
        apiVersion: 'v1' as const,
        environment: c.env.ENV_NAME,
        features: {
          aiEnabled,
          webFetch: true,
          emailMode: c.env.EMAIL_MODE,
        },
        limits: {
          maxFileBytes: LIMITS.maxFileBytes,
          maxPdfPages: LIMITS.maxPdfPages,
          pageImageMaxEdge: LIMITS.pageImageMaxEdge,
          pageImageMaxBytes: LIMITS.pageImageMaxBytes,
          listDefaultPageSize: LIMITS.listDefaultPageSize,
          listMaxPageSize: LIMITS.listMaxPageSize,
          concurrentAiTasksPerProject: LIMITS.concurrentAiTasksPerProject,
          assignmentSuggestionMaxTasks: LIMITS.assignmentSuggestionMaxTasks,
        },
        competitionTemplate: template,
      }),
      200,
    );
  });
}
