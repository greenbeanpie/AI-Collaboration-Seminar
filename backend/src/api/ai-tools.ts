import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { requireUser, requireProjectMember } from '../core/auth';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { projectParams } from './projects';
import { loadAiConfig } from '../ai/config';
import { nativeSearchCapability } from '../ai/tool-transport';
export function registerAiToolRoutes(app: OpenAPIHono<AppEnv>) {
  app.use('/api/v1/projects/:projectId/ai-tools/*', requireUser, requireProjectMember());
  app.openapi(createRoute({
    method: 'get', path: '/api/v1/projects/{projectId}/ai-tools/capabilities', tags: ['agent'], request: {
      params: projectParams
    }, responses: {
      200: {
        description: '项目工具和所配供应商搜索能力', content: {
          'application/json': {
            schema: apiEnvelope(z.object({
              fileTools: z.boolean(), search: z.object({
                supported: z.boolean(), reason: z.string()
              }), searchCost: z.literal('unknown')
            }), 'ProjectAiToolsResponse')
          }
        }
      }
    }
  }), async (c) => {
    const cfg = await loadAiConfig(c.env.DB), project = await c.env.DB.prepare('SELECT ai_budget_usd FROM projects WHERE id=?1').bind(c.get('member')!.projectId).first<{
      ai_budget_usd: number | null;
    }>();
    return c.json(apiData(c, {
      fileTools: Boolean(cfg?.enabled), search: project?.ai_budget_usd != null ? {
        supported: false, reason: '有限金额预算无法保证供应商搜索附加费用上界；当前项目搜索不可用'
      } : cfg?.enabled ? nativeSearchCapability(cfg.config.textEconomy) : {
        supported: false, reason: '系统 AI 未启用'
      }, searchCost: 'unknown' as const
    }), 200);
  });
  app.openapi(createRoute({
    method: 'get', path: '/api/v1/projects/{projectId}/ai-tools/calls', tags: ['agent'], request: {
      params: projectParams, query: z.object({
        jobId: z.string().uuid(), offset: z.string().regex(/^\d+$/).optional()
      })
    }, responses: {
      200: {
        description: '有界工具元数据，最多20项', content: {
          'application/json': {
            schema: apiEnvelope(z.object({
              items: z.array(z.object({
                id: z.string(), name: z.string(), status: z.string(), args: z.record(z.string(), z.unknown()), result: z.record(z.string(), z.unknown()).nullable(), createdAt: z.string()
              })), nextOffset: z.number().nullable()
            }), 'ProjectAiToolCallsResponse')
          }
        }
      }
    }
  }), async (c) => {
    const q = c.req.valid('query'), offset = Math.min(1000, Number(q.offset ?? 0));
    const rows = await c.env.DB.prepare('SELECT id,name,status,args_json,result_json,created_at FROM ai_tool_calls WHERE project_id=?1 AND job_id=?2 ORDER BY created_at,id LIMIT 21 OFFSET ?3').bind(c.get('member')!.projectId, q.jobId, offset).all<{
      id: string;
      name: string;
      status: string;
      args_json: string;
      result_json: string | null;
      created_at: string;
    }>();
    return c.json(apiData(c, {
      items: rows.results.slice(0, 20).map(r => ({
        id: r.id, name: r.name, status: r.status, args: JSON.parse(r.args_json), result: r.result_json ? JSON.parse(r.result_json) : null, createdAt: r.created_at
      })), nextOffset: rows.results.length > 20 ? offset + 20 : null
    }), 200);
  });
}
