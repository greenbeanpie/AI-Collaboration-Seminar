import { uniqueEdges } from './task-hierarchy';
import { effectiveStandardCaptureGuardSql } from './effective-standard';
import { assertCanRegenerate, pristineTasksSql } from './task-planning-policy';
import { readinessStatements } from './task-readiness';
import { projectPermissionSql, requireProjectOwner, requireProjectPermission } from './project-permissions';
import type { Env } from '../env';
import { projectReferenceGuard } from './project-reference-guard';
import { validateReadReferences,type ProjectReference } from './project-evidence';
import { projectSourceContextGuard } from './collaboration-context';
import { profileSnapshotGuard } from './personal-profiles';
import { newId, nowIso } from '../core/db';
import { invalidState, notFound, validationFailed,versionConflict } from '../core/errors';
import { projectGoal, graphSnapshot, validateTaskGraph } from './project-simplification';
import { buildProposalApplySql, buildSubmissionDecideWhereSql } from './sql-guards';
export interface CollaborationTask {
    parent_task_id?: string | null;
    id: string;
    project_id: string;
    title: string;
    detail: string;
    status: string;
    assignee_id: string | null;
    revision: number;
    lifecycle_state: string | null;
    criteria: string;
    effort_hours: number;
    due_date?: string | null;
    current_submission_id: string | null;
    source_citations_json: string;
    started_at?: string | null;
    archived_at?: string | null;
    created_at: string;
    updated_at: string;
}
export const toCollaborationTask = (r: CollaborationTask) => ({ parentTaskId:r.parent_task_id??null, taskId: r.id, startedAt:r.started_at??null, archivedAt:r.archived_at??null, title: r.title, detail: r.detail, status: r.status, assigneeId: r.assignee_id, revision: r.revision, lifecycleState: r.lifecycle_state??(r.status==='done'?'accepted':r.status==='doing'?'in_progress':'open'), criteria: r.criteria, citations: JSON.parse(r.source_citations_json || '[]'), effortHours: r.effort_hours, dueDate: r.due_date ?? null, currentSubmissionId: r.current_submission_id, createdAt: r.created_at, updatedAt: r.updated_at });
export interface Submission {
    id: string;
    project_id: string;
    task_id: string;
    round: number;
    submitted_by: string;
    body: string;
    material_versions_json: string;
    criteria: string;
    task_revision: number;
    status: string;
    ai_decision: string | null;
    ai_feedback: string | null;
    ai_report_json: string | null;
    human_score_override_json: string | null;
    decision: string | null;
    feedback: string | null;
    evaluation_job_id: string | null;
    evaluation_attempts: number;
    revision: number;
    created_at: string;
    updated_at: string;
}
export const toSubmission = (r: Submission) => ({ pendingHumanReview: r.status === 'accept' && !!r.ai_report_json && JSON.parse(r.ai_report_json).humanReview?.status === 'pending', submissionId: r.id, taskId: r.task_id, round: r.round, submittedBy: r.submitted_by, body: r.body, materialVersionIds: JSON.parse(r.material_versions_json) as string[], criteria: r.criteria, status: r.status, aiDecision: r.ai_decision, aiFeedback: r.ai_feedback, aiReport: r.ai_report_json ? JSON.parse(r.ai_report_json) : null, humanScoreOverride: r.human_score_override_json ? JSON.parse(r.human_score_override_json) : null, decision: r.decision, feedback: r.feedback, evaluationJobId: r.evaluation_job_id, evaluationAttempts: r.evaluation_attempts, revision: r.revision, createdAt: r.created_at, updatedAt: r.updated_at });
export interface Proposal {
    id: string;
    project_id: string;
    kind: 'decompose' | 'assign';
    payload_json: string;
    settings_revision: number;
    status: string;
    revision: number;
    created_at: string;
    updated_at: string;
}
export const toProposal = (r: Proposal) => ({ proposalId: r.id, kind: r.kind, payload: JSON.parse(r.payload_json), status: r.status, revision: r.revision, createdAt: r.created_at });
export async function owner(env: Env, projectId: string, userId: string, scope: 'taskManage' | 'owner' = 'taskManage') {
    if (scope === 'taskManage') return requireProjectPermission(env,projectId,userId,'taskManage');
    return requireProjectOwner(env,projectId,userId);
}
export function audit(env: Env, projectId: string, userId: string, type: string, id: string, payload: unknown, onlyAfterChange = false) { return env.DB.prepare(`INSERT INTO events(id,project_id,actor_type,actor_id,type,entity_type,entity_id,dedup_key,payload_json,occurred_at) SELECT ?1,?2,'user',?3,?4,'collaboration',?5,?1,?6,?7 ${onlyAfterChange ? 'WHERE changes()=1' : ''}`).bind(newId(), projectId, userId, type, id, JSON.stringify(payload), nowIso()); }
export async function applyProposal(env: Env, projectId: string, proposalId: string, expectedRevision: number, actorId: string, automatic = false, configVersionId?: string, selection?: {selectedTaskKeys?:string[];selectedUpdateTaskIds?:string[];selectedAssignmentTaskIds?:string[]}): Promise<{
    taskIds: string[];
}> {
    await owner(env, projectId, actorId);
    const p = await env.DB.prepare('SELECT * FROM collaboration_proposals WHERE id=?1 AND project_id=?2').bind(proposalId, projectId).first<Proposal>();
    if (!p)
        throw notFound();
    const payload = JSON.parse(p.payload_json) as {
        planningAction?: 'regenerate' | 'adjust';
        references?:ProjectReference[];
        brief?: string;
        goal?:{title:string;detail:string};
        tasks?: Array<{
            title: string;
            key?:string;dependsOn?:string[];parent?:string|null;
            detail: string;
            criteria: string;
            effortHours: number;
            citations?: unknown[];
        }>;
        updates?: Array<{ parentTaskId?:string|null;taskId: string; title: string; detail: string; criteria: string; effortHours: number; expectedRevision: number; citations?: unknown[] }>;
        assignments?: Array<{
            taskId: string;
            assigneeId: string | null;
            expectedRevision: number;
            reason: string;
        }>;
    };
    if(selection){
      const select=<T>(values:T[]|undefined,ids:string[]|undefined,key:(value:T,index:number)=>string):T[]|undefined=>{
       if(ids===undefined)return values;
       if(new Set(ids).size!==ids.length||ids.some(id=>!values?.some((value,index)=>key(value,index)===id)))throw validationFailed('部分应用包含未知或重复条目');
       return values?.filter((value,index)=>ids.includes(key(value,index)));
      };
      payload.tasks=select(payload.tasks,selection.selectedTaskKeys,(t,i)=>t.key??`t${i+1}`);
      payload.updates=select(payload.updates,selection.selectedUpdateTaskIds,t=>t.taskId);
      payload.assignments=select(payload.assignments,selection.selectedAssignmentTaskIds,t=>t.taskId);
    }
    const correction=await env.DB.prepare('SELECT 1 FROM collaboration_proposal_revisions WHERE proposal_id=?1 AND project_id=?2 AND length(trim(reason))>0 LIMIT 1').bind(proposalId,projectId).first();
    if(automatic||!correction)await validateReadReferences(env,projectId,payload.references??[]);
    if(p.kind==='decompose'){
      if(automatic)throw invalidState('任务方案须由项目负责人或拥有任务管理权限的成员明确确认');
      // 批准/应用 AI 任务方案属于任务管理型操作，与前端 taskManage 门控一致。
      await requireProjectPermission(env,projectId,actorId,'taskManage');
      if(payload.planningAction==='regenerate'){
        if(!payload.tasks?.length || payload.updates?.length)throw validationFailed('整套重新生成需要新的任务清单，不能清空计划或同时修改即将归档的旧任务');
        await assertCanRegenerate(env,projectId);
      }
    }
    const nonce = newId();
    const taskIds: string[] = [];
    const batch: D1PreparedStatement[] = [];
    const goal=await projectGoal(env,projectId);
    const { cte: proposalApplyCte, whereClause: proposalApplyWhere } = buildProposalApplySql({
      kind: p.kind,
      planningAction: payload.planningAction,
    });
    batch.push(env.DB.prepare(`${proposalApplyCte} UPDATE collaboration_proposals SET status='applied',revision=revision+1,mutation_token=?5,updated_at=?8 WHERE ${proposalApplyWhere} ${p.kind==='decompose'?`AND EXISTS(SELECT 1 FROM project_goals WHERE project_id=?2 AND graph_revision=${goal.graphRevision})`:''}`).bind(proposalId, projectId, expectedRevision, actorId, nonce, automatic ? 1 : 0, configVersionId ?? null, nowIso(),JSON.stringify(payload)));
    const gate = `EXISTS(SELECT 1 FROM collaboration_proposals WHERE id=?1 AND status='applied' AND mutation_token=?2)`;
    if (p.kind === 'decompose') {
        if ((!payload.tasks?.length && !payload.updates?.length))
            throw validationFailed('拆解结果无效');
        const replacing=payload.planningAction==='regenerate';
        const graph=replacing?{taskIds:[] as string[],edges:[]}:await graphSnapshot(env,projectId),taskKeys=new Map<string,string>();
        if(replacing && payload.updates?.length)throw validationFailed('重新生成不得修改旧任务');
        if(replacing)batch.push(env.DB.prepare(`UPDATE tasks SET archived_at=?3,revision=revision+1,updated_at=?3 WHERE project_id=?4 AND archived_at IS NULL AND ${gate}`).bind(proposalId,nonce,nowIso(),projectId));
        for(let i=0;i<(payload.tasks??[]).length;i++){const key=payload.tasks![i]!.key??`t${i+1}`;if(taskKeys.has(key)||graph.taskIds.includes(key))throw validationFailed('拆解任务标识不可重复或覆盖已有任务 ID');taskKeys.set(key,newId());}
        if((payload.tasks??[]).some(task=>new Set(task.dependsOn??[]).size!==(task.dependsOn??[]).length))throw validationFailed('依赖不可重复');
        const newEdges=(payload.tasks??[]).flatMap((t,i)=>(t.dependsOn??[]).map(key=>({taskId:taskKeys.get(t.key??`t${i+1}`)!,dependsOnTaskId:taskKeys.get(key)??key})));
        const parentChanges = [
          ...(payload.tasks??[]).map((task,i)=>({taskId:taskKeys.get(task.key??`t${i+1}`)!,parentTaskId:task.parent?taskKeys.get(task.parent)??task.parent:null})),
          ...(payload.updates??[]).filter(task=>task.parentTaskId!==undefined).map(task=>({taskId:task.taskId,parentTaskId:task.parentTaskId!})),
        ];
        const existingParents=replacing?[]:(await env.DB.prepare('SELECT id,parent_task_id FROM tasks WHERE project_id=?1 AND archived_at IS NULL').bind(projectId).all<{id:string;parent_task_id:string|null}>()).results;
        const manualEdges=replacing?[]:(await env.DB.prepare('SELECT task_id,depends_on_task_id FROM task_dependencies WHERE project_id=?1 AND manual_origin=1').bind(projectId).all<{task_id:string;depends_on_task_id:string}>()).results;
        const remainingEdges=graph.edges.filter(edge=>!parentChanges.some(change=>change.taskId===edge.dependsOnTaskId&&existingParents.some(task=>task.id===change.taskId&&task.parent_task_id===edge.taskId))||manualEdges.some(manual=>manual.task_id===edge.taskId&&manual.depends_on_task_id===edge.dependsOnTaskId));
        validateTaskGraph([...graph.taskIds,...taskKeys.values()],uniqueEdges([...remainingEdges,...newEdges,...parentChanges.flatMap(change=>change.parentTaskId?[{taskId:change.parentTaskId,dependsOnTaskId:change.taskId}]:[])]));
        batch.push(env.DB.prepare(`UPDATE project_goals SET title=?3,detail=?4,revision=revision+?5,graph_revision=graph_revision+1,updated_at=?6 WHERE project_id=?7 AND ${gate}`).bind(proposalId,nonce,payload.goal?.title??goal.title,payload.goal?.detail??goal.detail,payload.goal?1:0,nowIso(),projectId));
        for (const [i,t] of (payload.tasks ?? []).entries()) {
            if (!t.title || !t.criteria || !Number.isFinite(t.effortHours) || t.effortHours < 0.25 || t.effortHours > 200)
                throw validationFailed('任务内容无效');
            const taskId = taskKeys.get(t.key??`t${i+1}`)!;
            taskIds.push(taskId);
            batch.push(env.DB.prepare(`INSERT INTO tasks(id,project_id,title,detail,status,revision,created_by,created_at,updated_at,lifecycle_state,criteria,effort_hours,plan_proposal_id,source_citations_json) SELECT ?3,?4,?5,?6,'todo',1,?7,?8,?8,'open',?9,?10,?11,?12 WHERE ${gate}`).bind(proposalId, nonce, taskId, projectId, t.title, t.detail || '', actorId, nowIso(), t.criteria, t.effortHours, proposalId, JSON.stringify(t.citations ?? [])));
        }
        for(const edge of newEdges)batch.push(env.DB.prepare(`INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,created_at) SELECT ?3,?4,?5,?6 WHERE ${gate}`).bind(proposalId,nonce,projectId,edge.taskId,edge.dependsOnTaskId,nowIso()));
        // Apply parent links only after every new task exists. Triggers maintain source-tagged dependencies.
        for(const change of parentChanges)batch.push(env.DB.prepare(`UPDATE tasks SET parent_task_id=?3 WHERE id=?4 AND project_id=?5 AND ${gate}`).bind(proposalId,nonce,change.parentTaskId,change.taskId,projectId));
        if (new Set(payload.updates?.map(t => t.taskId)).size !== (payload.updates?.length ?? 0)) throw validationFailed('重复的任务调整');
        for (const update of payload.updates ?? []) {
            if (!update.title || !update.criteria || update.title.length > 200 || update.detail.length > 4000 || update.criteria.length > 4000 || !Number.isFinite(update.effortHours) || update.effortHours < 0.25 || update.effortHours > 200) throw validationFailed('任务调整内容无效');
            batch.push(env.DB.prepare(`UPDATE tasks SET title=?3,detail=?4,criteria=?5,effort_hours=?6,source_citations_json=?11,revision=revision+1,updated_at=?7 WHERE id=?8 AND project_id=?9 AND revision=?10 AND ${gate}`).bind(proposalId, nonce, update.title, update.detail, update.criteria, update.effortHours, nowIso(), update.taskId, projectId, update.expectedRevision, JSON.stringify(update.citations ?? [])));
        }
    }
    else {
        if (!payload.assignments?.length || new Set(payload.assignments.map(a => a.taskId)).size !== payload.assignments.length)
            throw validationFailed('分工结果无效');
        for (const a of payload.assignments)
            batch.push(env.DB.prepare(`UPDATE tasks SET assignee_id=?3,current_submission_id=CASE WHEN lifecycle_state='accepted' THEN current_submission_id ELSE NULL END,lifecycle_state=CASE WHEN lifecycle_state='accepted' THEN lifecycle_state WHEN ?3 IS NULL THEN 'open' ELSE 'in_progress' END,status=CASE WHEN lifecycle_state='accepted' THEN status WHEN ?3 IS NULL THEN 'todo' ELSE 'doing' END,revision=revision+1,updated_at=?4 WHERE id=?5 AND project_id=?6 AND revision=?7 AND assignee_id IS NOT ?3 AND ${gate}`).bind(proposalId, nonce, a.assigneeId, nowIso(), a.taskId, projectId, a.expectedRevision));
    }
    batch.push(env.DB.prepare(`INSERT INTO events(id,project_id,actor_type,actor_id,type,entity_type,entity_id,dedup_key,payload_json,occurred_at) SELECT ?3,?4,?5,?6,'collaboration.proposal_applied','collaboration',?1,?2,?7,?8 WHERE ${gate}`).bind(proposalId, nonce, newId(), projectId, automatic ? 'ai' : 'user', automatic ? `project-ai:${projectId}` : actorId, JSON.stringify(payload), nowIso()));
    if(p.kind==='decompose')batch.push(...readinessStatements(env,projectId,taskIds));
    const results = await env.DB.batch(batch);
    if (!results[0]!.meta.changes)
        throw invalidState('建议已失效、成员或任务已变化，请重新生成');
    return { taskIds };
}
export async function decideSubmission(env: Env, projectId: string, submissionId: string, expectedRevision: number, decision: 'accept' | 'improve' | 'rework', feedback: string, actorId: string, automatic = false, settingsRevision?: number, configVersionId?: string, rubricGuard?: { standardsVersionId?:string; id: string; version: number; weights_json: string; notes: string | null } | null, provisionalReview?: { reasonCodes: Array<'unread_attachments' | 'unread_references'>; reasons: string[] }): Promise<void> {
    if (!automatic)
        await owner(env, projectId, actorId);
    const nonce = newId();
    const result = await env.DB.batch([
        env.DB.prepare(`UPDATE task_submissions SET decision=?4,feedback=?5,status=?4,ai_report_json=CASE WHEN ?17 IS NOT NULL AND ?8=1 AND ?4='accept' THEN json_set(ai_report_json,'$.humanReview',json(?17)) WHEN ?8=0 AND json_extract(ai_report_json,'$.humanReview.status')='pending' THEN json_set(ai_report_json,'$.humanReview.status','resolved','$.humanReview.decision',?4,'$.humanReview.decidedBy',?6,'$.humanReview.decidedAt',?11) ELSE ai_report_json END,decided_by=?6,revision=revision+1,mutation_token=?7,updated_at=?11 WHERE ${buildSubmissionDecideWhereSql()}`).bind(submissionId,
          projectId, expectedRevision, decision, feedback, actorId, nonce, automatic ? 1 : 0, settingsRevision ?? null,
          configVersionId ?? null, nowIso(), rubricGuard === undefined ? 0 : rubricGuard === null ? 1 : 2,
          rubricGuard?.id ?? null, rubricGuard?.version ?? null, rubricGuard?.weights_json ?? null, rubricGuard?.notes ?? null,
          provisionalReview ? JSON.stringify({status:'pending',...provisionalReview}) : null, rubricGuard?.standardsVersionId ?? null),
        env.DB.prepare(`UPDATE tasks SET lifecycle_state=?3,status=?4,revision=revision+1,updated_at=?5 WHERE project_id=?2 AND current_submission_id=?1 AND EXISTS(SELECT 1 FROM task_submissions WHERE id=?1 AND mutation_token=?6)`).bind(submissionId, projectId, decision === 'accept' ? 'accepted' : decision, decision === 'accept' ? 'done' : 'doing', nowIso(), nonce),
        env.DB.prepare(`INSERT INTO events(id,project_id,actor_type,actor_id,type,entity_type,entity_id,dedup_key,payload_json,occurred_at) SELECT ?3,?2,?4,?5,'collaboration.submission_decided','submission',?1,?6,?7,?8 WHERE EXISTS(SELECT 1 FROM task_submissions WHERE id=?1 AND mutation_token=?6)`).bind(submissionId, projectId, newId(), automatic ? 'ai' : 'user', automatic ? `project-ai:${projectId}` : actorId, nonce, JSON.stringify({ decision, feedback, pendingHumanReview: !!provisionalReview }), nowIso()),
    ]);
    if (!result[0]!.meta.changes)
        throw invalidState('提交、任务执行人或设置已变化，请刷新');
}

/** Owner edits remain possible after automatic application. Preserve original proposal revisions. */
export async function reviseProposal(env:Env,projectId:string,proposalId:string,expectedRevision:number,payload:unknown,reason:string,actorId:string):Promise<Proposal>{
 await owner(env,projectId,actorId);
 const p=await env.DB.prepare('SELECT * FROM collaboration_proposals WHERE id=?1 AND project_id=?2').bind(proposalId,projectId).first<Proposal>();
 if(!p)throw notFound();
 if(p.revision!==expectedRevision)throw versionConflict(p.revision);
 if(!reason.trim())throw validationFailed('请说明人工修订理由');
 payload={...(payload as Record<string,unknown>),effectiveStandardsVersionId:JSON.parse(p.payload_json).effectiveStandardsVersionId??null};
 if(p.kind==='decompose')payload={...(payload as Record<string,unknown>),planningAction:p.status==='applied'?'adjust':JSON.parse(p.payload_json).planningAction??'adjust'};
 const next=payload as {tasks?:unknown[];updates?:unknown[];assignments?:unknown[];goal?:unknown};
 if(p.status==='applied'&&next.tasks?.length)throw validationFailed('已应用方案只能调整现有任务；新增任务请另建方案，避免重复创建');
 if(p.kind==='assign'&&(next.tasks?.length||next.updates?.length||next.goal))throw validationFailed('分工方案不能修改任务或主目标');
 if(p.kind==='decompose'&&next.assignments?.length)throw validationFailed('任务规划不能包含分工');
 const now=nowIso();
 const results=await env.DB.batch([
  env.DB.prepare(`INSERT INTO collaboration_proposal_revisions(id,proposal_id,project_id,revision,payload_json,status,actor_id,reason,created_at) SELECT ?1,id,project_id,revision,payload_json,status,?4,?5,?6 FROM collaboration_proposals WHERE id=?2 AND project_id=?3 AND revision=?7 AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?3 AND user_id=?4 AND ${projectPermissionSql('project_members.project_id','project_members.user_id','taskManage')})`).bind(newId(),proposalId,projectId,actorId,reason,now,expectedRevision),
  env.DB.prepare(`UPDATE collaboration_proposals SET payload_json=?4,status='pending',revision=revision+1,updated_at=?5 WHERE id=?1 AND project_id=?2 AND revision=?3 AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?6 AND ${projectPermissionSql('project_members.project_id','project_members.user_id','taskManage')})`).bind(proposalId,projectId,expectedRevision,JSON.stringify(payload),now,actorId),
  audit(env,projectId,actorId,'collaboration.proposal_revised',proposalId,{reason,expectedRevision},true)
 ]);
 if(!results[1]!.meta.changes){const latest=await env.DB.prepare('SELECT revision FROM collaboration_proposals WHERE id=?1 AND project_id=?2').bind(proposalId,projectId).first<{revision:number}>();if(latest&&latest.revision!==expectedRevision)throw versionConflict(latest.revision);throw invalidState('方案权限已变化');}
 return (await env.DB.prepare('SELECT * FROM collaboration_proposals WHERE id=?1').bind(proposalId).first<Proposal>())!;
}
