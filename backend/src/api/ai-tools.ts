import { permissionDenied } from '../core/errors';
import { clarificationSchema, answerSchema, listProjectClarifications, projectClarificationBinding, answerClarification, cancelClarification } from '../services/ai-clarifications';
import { activeExecutionSlice, dispatchExecutionSlice } from '../services/ai-execution-slices';
import { getJob } from '../services/jobs';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { requireUser, requireProjectMember } from '../core/auth';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { projectParams } from './projects';
import { loadAiConfig } from '../ai/config';
import { nativeSearchCapability } from '../ai/tool-transport';
export function registerAiToolRoutes(app: OpenAPIHono<AppEnv>) {
  const clarificationBase='/api/v1/projects/{projectId}/ai/clarifications';
  app.use('/api/v1/projects/:projectId/ai/clarifications',requireUser,requireProjectMember());
  app.use('/api/v1/projects/:projectId/ai/clarifications/*',requireUser,requireProjectMember());
  app.openapi(createRoute({method:'get',path:clarificationBase,tags:['agent'],request:{params:projectParams},responses:{200:{description:'本轮发起人待回答的问题，刷新后恢复',content:{'application/json':{schema:apiEnvelope(z.object({items:z.array(clarificationSchema)}),'ProjectAiClarificationsResponse')}}}}}),async c=>c.json(apiData(c,{items:await listProjectClarifications(c.env,c.req.valid('param').projectId,c.get('user')!.id)}),200));
  for(const action of ['answer','cancel'] as const){
    app.openapi(createRoute({method:'post',path:clarificationBase+'/{questionId}/'+action,tags:['agent'],request:{params:projectParams.extend({questionId:z.string().uuid()}),body:{required:true,content:{'application/json':{schema:action==='answer'?answerSchema:z.object({expectedRevision:z.number().int().min(1)}).strict()}}}},responses:{200:{description:'回答后恢复原任务，或取消等待',content:{'application/json':{schema:apiEnvelope(z.object({jobId:z.string().uuid(),status:z.string()}),'ProjectAiClarificationActionResponse')}}}}}),async c=>{
      const {projectId,questionId}=c.req.valid('param'),body=c.req.valid('json');
      const binding=await projectClarificationBinding(c.env,projectId,c.get('user')!.id,questionId);
      if(action==='answer'){
        await answerClarification(c.env,binding,questionId,body);
        const slice=await activeExecutionSlice(c.env,binding.jobId!);if(slice?.status==='pending')await dispatchExecutionSlice(c.env,slice);
      }else await cancelClarification(c.env,binding,questionId,body.expectedRevision);
      const job=await getJob(c.env,binding.jobId!);
      return c.json(apiData(c,{jobId:job.id,status:job.status}),200);
    });
  }

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
              })
            }), 'ProjectAiToolsResponse')
          }
        }
      }
    }
  }), async (c) => {
    const cfg = await loadAiConfig(c.env.DB);
    return c.json(apiData(c, {
      fileTools: Boolean(cfg?.enabled), search: cfg?.enabled && cfg.config.searchEnabled === true ? nativeSearchCapability(cfg.config.textEconomy) : {
        supported: false, reason: cfg?.enabled ? '管理员尚未启用互联网搜索' : '系统 AI 未启用'
      }
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
    const job=await getJob(c.env,q.jobId),input=JSON.parse(job.input_json) as {operation?:string;questionId?:string;requestedBy?:string};
    if(input.operation==='project.chat'&&(input.requestedBy!==c.get('user')!.id||!await c.env.DB.prepare('SELECT 1 FROM project_ai_chat_questions WHERE id=?1 AND user_id=?2').bind(input.questionId??null,c.get('user')!.id).first()))throw permissionDenied('问答历史不存在或不属于当前用户');
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
