import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { requireUser, requireProjectMember } from '../core/auth';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { taskAgentEligibilitySchema, readTaskAgentEligibility, enqueueTaskAgentEligibility } from '../services/task-agent-eligibility';

export function registerTaskAgentEligibilityRoutes(app: OpenAPIHono<AppEnv>): void {
  const path = '/api/v1/projects/{projectId}/collaboration/tasks/{taskId}/agent-eligibility';
  app.use('/api/v1/projects/:projectId/collaboration/tasks/:taskId/agent-eligibility',requireUser,requireProjectMember());
  const params = z.object({projectId:z.string().uuid(),taskId:z.string().uuid()});
  const responses = {200:{description:'任务 AI 执行适用性检查状态',content:{'application/json':{schema:apiEnvelope(taskAgentEligibilitySchema,'TaskAgentEligibilityResponse')}}}};
  app.openapi(createRoute({method:'get',path,tags:['collaboration'],summary:'读取任务 AI 执行适用性检查',request:{params},responses}),async c => {
    const {projectId,taskId} = c.req.valid('param');
    return c.json(apiData(c,await readTaskAgentEligibility(c.env,projectId,taskId,c.get('user')!.id)),200);
  });
  app.openapi(createRoute({method:'post',path,tags:['collaboration'],summary:'请求模型判断任务 AI 执行适用性',request:{params,body:{required:true,content:{'application/json':{schema:z.object({expectedRevision:z.number().int().positive(),retry:z.boolean().optional()}).strict()}}}},responses}),async c => {
    const {projectId,taskId} = c.req.valid('param'),{expectedRevision,retry} = c.req.valid('json');
    return c.json(apiData(c,await enqueueTaskAgentEligibility(c.env,projectId,taskId,c.get('user')!.id,expectedRevision,retry)),200);
  });
}
