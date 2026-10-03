import { projectPermissionSql, requireProjectPermission } from './project-permissions';
import { z } from 'zod';
import type { Env } from '../env';
import { newId, nowIso } from '../core/db';
import { invalidState, notFound, permissionDenied, validationFailed, versionConflict } from '../core/errors';
import { assessmentEvidenceSchema, assessmentInputs, assessmentView, type AssessmentRow, type ScoringReport } from './assessments';
import { calculateRubricWeightedTotal } from './collaboration-ai';
import { recordEvent } from './events';

const dimension = z.object({
  key: z.string().min(1).max(40), score: z.number().min(0).max(100).nullable(),
  comment: z.string().max(2000).default('人工评分'),
  evidence: z.array(assessmentEvidenceSchema).max(20).default([]),
}).strict();
export const manualAssessmentInput = z.object({
  standardsVersionId: z.string().uuid(), materialVersionIds: z.array(z.string().uuid()).default([]),
  goalRevision: z.number().int().positive().optional(), scores: z.array(dimension).max(10),
  summary: z.string().max(8000).default('项目负责人独立人工评分'), reason: z.string().trim().min(1).max(4000),
}).strict();
export const correctionInput = z.object({
  expectedRevision: z.number().int().positive(), scores: z.array(dimension).min(1).max(10),
  summary: z.string().max(8000).optional(), reason: z.string().trim().min(1).max(4000),
}).strict();

async function validateEvidence(env: Env, row: AssessmentRow, scores: z.infer<typeof dimension>[]) {
  const input = JSON.parse(row.inputs_json) as Awaited<ReturnType<typeof assessmentInputs>>;
  for (const score of scores) for (const e of score.evidence) {
    let text: string | null = null;
    if (e.type === 'material') {
      if (!input.materialVersionIds.includes(e.materialVersionId)) throw validationFailed('证据不是本轮固定评价对象');
      const item = await env.DB.prepare('SELECT v.markdown FROM material_versions v JOIN materials m ON m.id=v.material_id WHERE v.id=?1 AND m.project_id=?2').bind(e.materialVersionId, row.project_id).first<{ markdown: string }>();
      text = item?.markdown ?? null;
    } else if (row.entity_id) {
      const turn = await env.DB.prepare("SELECT content_json FROM rehearsal_turns WHERE rehearsal_id=?1 AND project_id=?2 AND sequence=?3 AND kind='answer'").bind(row.entity_id, row.project_id, e.turnSequence).first<{content_json:string}>();
      text = turn ? String(JSON.parse(turn.content_json).content ?? '') : null;
    }
    if (!text?.includes(e.quote)) throw validationFailed('人工证据与材料或实际回答不符');
  }
}

function revise(row: AssessmentRow, overrides: z.infer<typeof dimension>[], summary: string | undefined, partial: boolean): ScoringReport {
  const input = JSON.parse(row.inputs_json) as Awaited<ReturnType<typeof assessmentInputs>>;
  const weights = input.standard.rubric.weights;
  const keys = new Set(overrides.map(s => s.key));
  if (keys.size !== overrides.length || overrides.some(s => !weights.some(w => w.key === s.key))) throw validationFailed('评分维度重复或不属于本轮标准');
  if (!partial && weights.some(w => !keys.has(w.key))) throw validationFailed('独立人工评分须覆盖全部维度，可填未知分数');
  const previous = row.report_json ? JSON.parse(row.report_json) as ScoringReport : null;
  const scores = weights.map(w => {
    const override = overrides.find(s => s.key === w.key);
    if (override) return { ...override, label: w.label, confidence: null, origin: 'human' as const };
    return previous?.scores.find(s => s.key === w.key) ?? { key:w.key,label:w.label,score:null,confidence:0,comment:'尚未评分',evidence:[] };
  });
  const scored = scores.length > 0 && scores.every(s => s.score !== null);
  return { kind:'assistive',status:scored?'scored':'unscorable',standardsVersionId:input.standard.standardsVersionId,standardsVersion:input.standard.version,scores,
    weightedTotal:scored?calculateRubricWeightedTotal(weights,scores.map(s=>({key:s.key,score:s.score!}))):null,
    summary:summary??previous?.summary??'项目负责人修正评分',limitations:previous?.limitations??[],
    requirementChecks:previous?.requirementChecks??input.standard.requirements.map(r=>({requirementId:r.requirementId,status:'unknown' as const,comment:'本轮为人工维度评分',evidence:[]})) };
}

export async function createManualAssessment(env:Env,projectId:string,actorId:string,raw:unknown) {
  await requireProjectPermission(env,projectId,actorId,'scoreInitiate');
  const b=manualAssessmentInput.parse(raw),input=await assessmentInputs(env,projectId,b.standardsVersionId,b.materialVersionIds,b.goalRevision),id=newId(),now=nowIso();
  const row:AssessmentRow={id,project_id:projectId,kind:'material_review',entity_id:null,goal_revision:input.goal.revision,standards_version_id:b.standardsVersionId,inputs_json:JSON.stringify(input),status:'succeeded',report_json:null,job_id:null,created_by:actorId,created_at:now};
  await validateEvidence(env,row,b.scores);
  const report=revise(row,b.scores,b.summary,false);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO assessments(id,project_id,kind,goal_revision,standards_version_id,inputs_json,status,report_json,created_by,created_at,origin) SELECT ?1,?2,'material_review',?3,?4,?5,'succeeded',?6,?7,?8,'manual' WHERE ${projectPermissionSql('?2','?7','scoreInitiate')}`).bind(id,projectId,input.goal.revision,b.standardsVersionId,row.inputs_json,JSON.stringify(report),actorId,now),
    env.DB.prepare('INSERT INTO assessment_corrections(id,assessment_id,project_id,actor_id,revision,reason,report_json,created_at) SELECT ?1,?2,?3,?4,1,?5,?6,?7 WHERE EXISTS(SELECT 1 FROM assessments WHERE id=?2)').bind(newId(),id,projectId,actorId,b.reason,JSON.stringify(report),now),
  ]);
  const saved=await env.DB.prepare('SELECT * FROM assessments WHERE id=?1 AND project_id=?2').bind(id,projectId).first<AssessmentRow>();
  if(!saved)throw permissionDenied();
  await recordEvent(env,{projectId,actorType:'user',actorId,type:'assessment.manual_created',entityType:'assessment',entityId:id,dedupKey:`${id}:1`,payload:{reason:b.reason,scores:b.scores}});
  return assessmentView(env,saved);
}

export async function correctAssessment(env:Env,projectId:string,id:string,actorId:string,raw:unknown) {
  await requireProjectPermission(env,projectId,actorId,'scoreCorrect');
  const b=correctionInput.parse(raw),row=await env.DB.prepare('SELECT * FROM assessments WHERE id=?1 AND project_id=?2').bind(id,projectId).first<AssessmentRow & {revision:number}>();
  if(!row)throw notFound();
  if(row.revision!==b.expectedRevision)throw versionConflict(row.revision);
  if(!['succeeded','failed'].includes(row.status))throw invalidState('本轮尚未结束，不能修正评分');
  if(row.kind==='rehearsal'&&row.status==='active')throw invalidState('请结束演练后再人工复评');
  await validateEvidence(env,row,b.scores);
  const report=revise(row,b.scores,b.summary,true),now=nowIso(),token=newId();
  const results=await env.DB.batch([
    env.DB.prepare(`UPDATE assessments SET ai_report_json=COALESCE(ai_report_json,CASE WHEN origin='ai' THEN report_json END),report_json=?4,origin=CASE WHEN origin='manual' THEN 'manual' ELSE 'ai_adjusted' END,status='succeeded',revision=revision+1 WHERE id=?1 AND project_id=?2 AND revision=?3 AND status IN ('succeeded','failed') AND ${projectPermissionSql('?2','?5','scoreCorrect')}`).bind(id,projectId,b.expectedRevision,JSON.stringify(report),actorId),
    env.DB.prepare(`INSERT INTO assessment_corrections(id,assessment_id,project_id,actor_id,revision,reason,previous_report_json,report_json,created_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9 WHERE EXISTS(SELECT 1 FROM assessments WHERE id=?2 AND project_id=?3 AND revision=?5 AND report_json=?8)`).bind(token,id,projectId,actorId,b.expectedRevision+1,b.reason,row.report_json,JSON.stringify(report),now),
  ]);
  if(!results[0]?.meta.changes)throw invalidState('评分或权限已变化，请刷新');
  await recordEvent(env,{projectId,actorType:'user',actorId,type:'assessment.corrected',entityType:'assessment',entityId:id,dedupKey:`${id}:${b.expectedRevision+1}`,payload:{reason:b.reason,scores:b.scores}});
  return assessmentView(env,(await env.DB.prepare('SELECT * FROM assessments WHERE id=?1').bind(id).first<AssessmentRow>())!);
}
