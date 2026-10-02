import { z } from 'zod';
import type { Env } from '../env';
import { notFound, invalidState } from '../core/errors';
import { sourceLifecycleGuard } from './source-lifecycle';

export const discoveryDefinitions = [
  ['get_project_overview', '读取项目背景、目标和任务状态统计'],
  ['list_project_resources', '分页列出全部项目来源与材料；query 可按标题过滤'],
  ['read_resource', '按固定版本分页读取来源正文或材料正文'],
  ['list_tasks', '分页读取任务说明、验收标准、归属、进度和依赖'],
  ['read_task', '读取指定任务及其相关提交、反馈、依赖'],
  ['read_submission', '读取固定成果提交、材料版本及评价反馈'],
  ['read_project_standards', '分页读取已确认要求、统一标准和评分规则'],
  ['list_project_decisions', '分页读取项目决策和管理员反馈'],
  ['read_project_history', '分页读取项目事件与协作评论'],
  ['read_member_workload', '分页读取成员项目角色与任务负载，不披露个人资料'],
] as const;
export const discoveryArgs = z.object({ offset: z.number().int().nonnegative().default(0), query: z.string().max(200).optional(),
  id: z.string().uuid().optional(), resourceType: z.enum(['source','material']).optional(), versionId: z.string().uuid().optional() }).strict();
const PAGE = 20, CHARS = 6000;
const page = (rows: unknown[], offset: number) => ({ untrustedData: true, items: rows.slice(0,PAGE), nextOffset: rows.length > PAGE ? offset+PAGE : null });

/** Caller enforces membership before and after each read. Queries never accept project identity from the model. */
export async function executeDiscoveryTool(env: Env, projectId: string, name: string, input: unknown): Promise<Record<string,unknown>> {
  const a = discoveryArgs.parse(input);
  if (name === 'get_project_overview') {
    const project = await env.DB.prepare('SELECT id,name,description,revision,competition_deadline_date FROM projects WHERE id=?1').bind(projectId).first();
    const goal = await env.DB.prepare('SELECT title,detail,revision,graph_revision FROM project_goals WHERE project_id=?1').bind(projectId).first();
    const tasks = await env.DB.prepare('SELECT status,lifecycle_state,COUNT(*) count FROM tasks WHERE project_id=?1 GROUP BY status,lifecycle_state').bind(projectId).all();
    return {untrustedData:true,project,goal,tasks:tasks.results,resourceType:'project',resourceId:projectId,text:JSON.stringify({project,goal,tasks:tasks.results})};
  }
  if (name === 'list_project_resources') {
    const rows = await env.DB.prepare(`SELECT * FROM (
      SELECT 'source' resourceType,s.id resourceId,s.title,s.purpose,s.current_version_id versionId,s.lifecycle_version revision,p.text_status processingStatus
      FROM sources s JOIN source_versions v ON v.id=s.current_version_id LEFT JOIN source_processing p ON p.source_version_id=v.id
      WHERE s.project_id=?1 AND ${sourceLifecycleGuard('v.id','NULL')}
      UNION ALL SELECT 'material',m.id,m.title,m.purpose,m.current_version_id,m.revision,'ready' FROM materials m WHERE m.project_id=?1)
      WHERE (?2='' OR instr(lower(title),lower(?2))>0) ORDER BY resourceType,resourceId LIMIT 21 OFFSET ?3`).bind(projectId,a.query??'',a.offset).all();
    return page(rows.results,a.offset);
  }
  if (name === 'read_resource') {
    if(!a.resourceType || !a.versionId) throw invalidState('读取资料需要 resourceType 和 versionId');
    if(a.resourceType==='source') {
      const row = await env.DB.prepare(`SELECT s.id,s.title,s.lifecycle_version,v.id versionId,p.text_status FROM source_versions v JOIN sources s ON s.id=v.source_id
        LEFT JOIN source_processing p ON p.source_version_id=v.id WHERE v.id=?1 AND v.project_id=?2 AND ${sourceLifecycleGuard('v.id','NULL')}`).bind(a.versionId,projectId).first<{id:string;title:string;lifecycle_version:number;versionId:string;text_status:string}>();
      if(!row) throw notFound('来源版本不存在或已回收');
      const rows = await env.DB.prepare(`SELECT id,page_number,substr(content,MAX(1,?3-start+1),6000) content,start,total FROM
        (SELECT id,page_number,content,COALESCE(SUM(length(content)+1) OVER(ORDER BY seq,id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) start,
        SUM(length(content)+1) OVER() total FROM source_fragments WHERE source_version_id=?1 AND project_id=?2)
        WHERE start+length(content)>?3 AND start<?3+6000 ORDER BY start`).bind(a.versionId,projectId,a.offset).all<{id:string;page_number:number|null;content:string;start:number;total:number}>();
      let remain=CHARS;
      const fragments=rows.results.map(f=>{const chars=Array.from(f.content).slice(0,remain);remain-=chars.length;return {fragmentId:f.id,pageNumber:f.page_number,quote:chars.join('')};}).filter(f=>f.quote);
      return {untrustedData:true,resourceType:'source',resourceId:row.id,versionId:a.versionId,title:row.title,revision:row.lifecycle_version,
        status:fragments.length?'ready':'unavailable',coverage:row.text_status==='ready'?'complete':'partial',fragments,offset:a.offset,
        nextOffset:(rows.results[0]?.total??0)>a.offset+CHARS?a.offset+CHARS:null};
    }
    const row=await env.DB.prepare(`SELECT m.id,m.title,v.revision,length(v.markdown) total,substr(v.markdown,?3+1,6000) text FROM material_versions v JOIN materials m ON m.id=v.material_id
      WHERE v.id=?1 AND v.project_id=?2 AND m.project_id=?2`).bind(a.versionId,projectId,a.offset).first<{id:string;title:string;revision:number;total:number;text:string}>();
    if(!row) throw notFound('材料版本不存在');
    return {untrustedData:true,resourceType:'material',resourceId:row.id,versionId:a.versionId,title:row.title,revision:row.revision,text:row.text,status:'ready',offset:a.offset,nextOffset:row.total>a.offset+CHARS?a.offset+CHARS:null};
  }
  if(name==='list_tasks' || name==='read_task') {
    if(name==='read_task'&&!a.id) throw invalidState('缺少任务 id');
    const rows=await env.DB.prepare(`SELECT t.id,t.title,t.detail,t.criteria,t.assignee_id,t.due_date,t.status,t.lifecycle_state,t.revision,t.effort_hours,t.current_submission_id,
      (SELECT json_group_array(depends_on_task_id) FROM task_dependencies d WHERE d.task_id=t.id AND d.project_id=t.project_id) dependencies
      FROM tasks t WHERE t.project_id=?1 AND (?2 IS NULL OR t.id=?2) AND (?3='' OR instr(lower(t.title||t.detail),lower(?3))>0) ORDER BY t.id LIMIT 21 OFFSET ?4`).bind(projectId,a.id??null,a.query??'',a.offset).all();
    const result={...page(rows.results,a.offset),resourceType:'task'};
    if(name==='read_task') {
      const submissions=await env.DB.prepare('SELECT id,round,status,decision,feedback,revision FROM task_submissions WHERE project_id=?1 AND task_id=?2 ORDER BY round DESC LIMIT 21 OFFSET ?3').bind(projectId,a.id,a.offset).all();
      return {...result,submissions:page(submissions.results,a.offset)};
    }
    return result;
  }
  if(name==='read_submission') {
    if(!a.id) throw invalidState('缺少提交 id');
    const row=await env.DB.prepare('SELECT id,task_id,round,revision,substr(body,?3+1,6000) body,length(body) total,material_versions_json,criteria,status,decision,feedback,ai_decision,ai_feedback FROM task_submissions WHERE project_id=?1 AND id=?2').bind(projectId,a.id,a.offset).first<{total:number}>();
    if(!row) throw notFound('提交不存在');
    return {untrustedData:true,...row,resourceType:'submission',resourceId:a.id,offset:a.offset,nextOffset:row.total>a.offset+CHARS?a.offset+CHARS:null};
  }
  if(name==='read_project_standards') {
    const standards=await env.DB.prepare("SELECT id,version,revision,title,snapshot_json FROM standards_versions WHERE project_id=?1 AND status='confirmed' ORDER BY version DESC LIMIT 21 OFFSET ?2").bind(projectId,a.offset).all();
    const requirements=await env.DB.prepare("SELECT r.* FROM requirements r JOIN requirement_sets s ON s.id=r.requirement_set_id WHERE r.project_id=?1 AND s.status='confirmed' ORDER BY r.id LIMIT 21 OFFSET ?2").bind(projectId,a.offset).all();
    const rubrics=await env.DB.prepare("SELECT id,version,weights_json,notes FROM rubric_versions WHERE project_id=?1 AND status='confirmed' ORDER BY version DESC LIMIT 21 OFFSET ?2").bind(projectId,a.offset).all();
    return {untrustedData:true,standards:{...page(standards.results,a.offset),resourceType:'standard'},requirements:{...page(requirements.results,a.offset),resourceType:'requirement'},rubrics:{...page(rubrics.results,a.offset),resourceType:'rubric'}};
  }
  if(name==='list_project_decisions') return {...page((await env.DB.prepare('SELECT id,title,detail,decided_at,related_json FROM decisions WHERE project_id=?1 ORDER BY decided_at DESC,id LIMIT 21 OFFSET ?2').bind(projectId,a.offset).all()).results,a.offset),resourceType:'decision'};
  if(name==='read_project_history') {
    const events=await env.DB.prepare('SELECT id,type,entity_type,entity_id,payload_json,occurred_at FROM events WHERE project_id=?1 ORDER BY occurred_at DESC,id LIMIT 21 OFFSET ?2').bind(projectId,a.offset).all();
    const comments=await env.DB.prepare('SELECT id,target_type,target_id,body,created_at FROM comments WHERE project_id=?1 ORDER BY created_at DESC,id LIMIT 21 OFFSET ?2').bind(projectId,a.offset).all();
    return {untrustedData:true,events:{...page(events.results,a.offset),resourceType:'event'},comments:{...page(comments.results,a.offset),resourceType:'comment'}};
  }
  if(name==='read_member_workload') return page((await env.DB.prepare(`SELECT m.user_id,m.role,COALESCE(SUM(CASE WHEN t.status!='done' THEN t.effort_hours ELSE 0 END),0) loadHours
    FROM project_members m LEFT JOIN tasks t ON t.assignee_id=m.user_id AND t.project_id=m.project_id WHERE m.project_id=?1 GROUP BY m.user_id,m.role ORDER BY m.user_id LIMIT 21 OFFSET ?2`).bind(projectId,a.offset).all()).results,a.offset);
  throw invalidState('未授权工具名称');
}
