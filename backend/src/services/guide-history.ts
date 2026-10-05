import { z } from 'zod';
import type { Env } from '../env';
import type { ToolDefinition } from '../ai/tool-transport';
import { permissionDenied, notFound } from '../core/errors';

export interface GuideHistoryContext { projectId: string; userId: string; guideSessionId?: string }
export const guideTextSql = "COALESCE(json_extract(turn.payload_json,'$.answer'),json_extract(turn.payload_json,'$.question'),json_extract(turn.payload_json,'$.markdown'),json_extract(turn.payload_json,'$.instruction'),'')";
const listArgs = z.object({ offset: z.number().int().min(0).max(1000000) }).strict();
const readArgs = z.object({ turnId: z.string().uuid(), offset: z.number().int().min(0).max(1000000) }).strict();
export const guideHistoryDefinitions: ToolDefinition[] = ([
  ['list_guide_turns', '分页列出本次带做会话的历史轮次、角色和全文长度；目录不代表已读回答。只能访问服务器绑定的当前会话。', listArgs],
  ['read_guide_turn', '读取当前带做会话指定轮次的原文，每页最多4000字符，按 nextOffset 继续可读完整回答；不触发新的 AI 请求。', readArgs],
] as const).map(([name, description, schema]) => {
  const { $schema: _schema, ...parameters } = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' });
  return { name, description, parameters };
});
export async function assertGuideHistoryAccess(env: Env, context: GuideHistoryContext) {
  if (!context.guideSessionId) throw permissionDenied('本轮没有可读取的带做会话');
  const session = await env.DB.prepare(`SELECT session.id FROM agent_sessions session JOIN projects project ON project.id=session.project_id JOIN project_members member ON member.project_id=project.id AND member.user_id=?3 WHERE session.id=?1 AND session.project_id=?2 AND session.created_by=?3 AND session.capability='guide' AND session.status='active' AND project.status='active'`)
    .bind(context.guideSessionId, context.projectId, context.userId).first();
  if (!session) throw permissionDenied('当前带做会话访问权限已失效');
}
export async function executeGuideHistoryTool(env: Env, context: GuideHistoryContext, name: string, input: unknown): Promise<Record<string, unknown>> {
  await assertGuideHistoryAccess(env, context);
  if (name === 'list_guide_turns') {
    const args = listArgs.parse(input);
    const rows = await env.DB.prepare(`SELECT turn.id,turn.sequence,turn.role,turn.kind,length(${guideTextSql}) charCount FROM agent_turns turn WHERE turn.session_id=?1 AND turn.project_id=?2 ORDER BY turn.sequence LIMIT 21 OFFSET ?3`)
      .bind(context.guideSessionId!, context.projectId, args.offset).all();
    await assertGuideHistoryAccess(env, context);
    return { untrustedData: true, directoryOnly: true, items: rows.results.slice(0, 20), nextOffset: rows.results.length > 20 ? args.offset + 20 : null };
  }
  const args = readArgs.parse(input);
  if (name !== 'read_guide_turn') throw notFound('带做历史工具不存在');
  const row = await env.DB.prepare(`SELECT turn.id,turn.sequence,turn.role,turn.kind,substr(${guideTextSql},?4+1,4000) text,length(${guideTextSql}) charCount FROM agent_turns turn WHERE turn.id=?1 AND turn.session_id=?2 AND turn.project_id=?3`)
    .bind(args.turnId, context.guideSessionId!, context.projectId, args.offset).first<{ id: string; sequence: number; role: string; kind: string; text: string; charCount: number }>();
  if (!row) throw notFound('该轮次不属于当前带做会话');
  await assertGuideHistoryAccess(env, context);
  return { untrustedData: true, resourceType: 'guide_turn', resourceId: row.id, versionId: context.guideSessionId, title: `带做第${row.sequence}轮（${row.role}）`, role: row.role, kind: row.kind, text: row.text, offset: args.offset, charCount: row.charCount, nextOffset: row.charCount > args.offset + 4000 ? args.offset + 4000 : null };
}
/** A bounded index replaces silently truncated answers. Full text remains tool-readable. */
export async function buildGuideHistory(env: Env, context: GuideHistoryContext): Promise<string> {
  const index = await executeGuideHistoryTool(env, context, 'list_guide_turns', { offset: 0 });
  return '已有对话目录（未包含回答正文，不能据此认定已读回答）：' + JSON.stringify(index) + '\n使用 list_guide_turns 分页列出全部轮次；使用 read_guide_turn 按 turnId、offset=0 开始读取，持续读取 nextOffset 获取完整原文。回答可达8000字符，末尾信息同样重要，形成决策前应读取相关回答。';
}
