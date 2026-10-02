import { fileReferenceAvailability, sourceCitationAvailability, sourceReferenceAvailability } from '../services/source-inputs';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { requireProjectMember, requireUser } from '../core/auth';
import { nowIso } from '../core/db';
import { notFound } from '../core/errors';
import { parsePaging, nextCursor } from '../core/pagination';
import { projectParams } from './projects';
import { goalSchema, standardSchema, assessmentSchema } from './project-simplification';
import { projectGoal, standardView, type StandardRow } from '../services/project-simplification';
import { assessmentView, type AssessmentRow } from '../services/assessments';

// ========== 事件账本 ==========
const eventsRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/events',
  tags: ['ledger'],
  summary: '活动历史事件流（游标分页）',
  request: {
    params: projectParams,
    query: z.object({ cursor: z.string().optional(), limit: z.string().optional(), type: z.string().optional() }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: apiEnvelope(
            z.object({
              items: z.array(
                z.object({
                  eventId: z.string().uuid(),
                  type: z.string(),
                  actorType: z.enum(['user', 'ai', 'system']),
                  actorId: z.string(),
                  entityType: z.string(),
                  entityId: z.string(),
                  payload: z.record(z.string(), z.unknown()),
                  occurredAt: z.string(),
                }),
              ),
              nextCursor: z.string().nullable(),
            }),
            'EventListResponse',
          ),
        },
      },
      description: '事件列表',
    },
  },
});

// ========== 导出 ==========
const exportRequirementSchema = z.object({
  requirementId: z.string().uuid(),
  seq: z.number().int(),
  category: z.enum(['deadline', 'deliverable', 'format', 'scoring', 'team', 'other']),
  title: z.string(),
  detail: z.string(),
  dueDate: z.string().nullable(),
  duePrecision: z.enum(['date', 'datetime', 'unknown']),
  citations: z.array(z.object({
    sourceVersionId: z.string().uuid(),
    fragmentId: z.string().uuid(),
    pageNumber: z.number().int().nullable(),
    quote: z.string(),
    availability: z.literal('unavailable').optional(),
    deletedAt: z.string().nullable().optional(),
  })),
  fieldState: z.enum(['ai_suggestion', 'edited', 'confirmed']),
});

const exportBundleResponse = apiEnvelope(z.object({
  project: z.object({
    id: z.string().uuid(),
    name: z.string(),
    description: z.string(),
    competition_deadline_date: z.string().nullable(),
    status: z.string(),
  }),
  generatedAt: z.string(),
  mainGoal: goalSchema,
  standardsVersions: z.array(standardSchema),
  assessments: z.array(assessmentSchema),
  legacyReviews: z.array(z.object({ reviewId: z.string(), requirementSetId: z.string(), rubricVersionId: z.string(), materialVersionIds: z.array(z.string()), status: z.string(), report: z.unknown().nullable(), createdAt: z.string() })),
  taskDependencies: z.array(z.object({ taskId: z.string(), dependsOnTaskId: z.string() })),
  taskLinks: z.array(z.object({ linkId: z.string(), taskId: z.string(), kind: z.string(), targetId: z.string(), createdAt: z.string() })),
  taskSubmissions: z.array(z.object({ submissionId: z.string(), taskId: z.string(), round: z.number().int(), submittedBy: z.string(), body: z.string(), criteria: z.string(), status: z.string(), materialVersionIds: z.array(z.string()), aiReport: z.unknown().nullable(), humanScoreOverride: z.unknown().nullable(), decision: z.string().nullable(), feedback: z.string().nullable(), createdAt: z.string() })),
  sources: z.array(z.object({ sourceId: z.string(), title: z.string(), purpose: z.string(), currentVersionId: z.string().nullable(), deletedAt: z.string().nullable() })),
  sourceVersions: z.array(z.object({ sourceVersionId: z.string(), sourceId: z.string(), revision: z.number().int(), origin: z.string(), fileId: z.string().nullable(), status: z.string(), createdAt: z.string(), fragments: z.array(z.object({ fragmentId: z.string(), pageNumber: z.number().int().nullable(), seq: z.number().int(), content: z.string() })) })),
  materialVersions: z.array(z.object({ versionId: z.string(), materialId: z.string(), revision: z.number().int(), markdown: z.string(), createdAt: z.string(), attachments: z.array(z.object({ fileId: z.string(), name: z.string(), availability: z.literal('unavailable').optional(), deletedAt: z.string().nullable().optional() })) })),
  rehearsalTurns: z.array(z.object({ rehearsalId: z.string(), sequence: z.number().int(), kind: z.string(), content: z.unknown(), createdAt: z.string() })),
  materials: z.array(z.object({ materialId: z.string(), versionId: z.string(), purpose: z.string(), title: z.string(), markdown: z.string(), revision: z.number().int(), attachments: z.array(z.object({ fileId: z.string(), name: z.string(), availability: z.literal('unavailable').optional(), deletedAt: z.string().nullable().optional() })) })),
  requirementSets: z.array(z.object({
    requirementSetId: z.string().uuid(),
    sourceVersionId: z.string().uuid().nullable(),
    sourceAvailability: z.literal('unavailable').optional(),
    sourceDeletedAt: z.string().nullable().optional(),
    status: z.enum(['draft', 'confirmed']),
    revision: z.number().int(),
    confirmedAt: z.string().nullable(),
    requirements: z.array(exportRequirementSchema),
  })),
  rubricVersions: z.array(z.object({
    rubricId: z.string().uuid(),
    version: z.number().int(),
    source: z.enum(['official', 'custom']),
    weights: z.array(z.object({ key: z.string(), label: z.string(), weight: z.number() })),
    notes: z.string().nullable(),
    status: z.enum(['draft', 'confirmed']),
    confirmedAt: z.string().nullable(),
    createdAt: z.string(),
  })),
  tasks: z.array(z.object({ taskId: z.string(), title: z.string(), detail: z.string(), criteria: z.string(), effortHours: z.number(), revision: z.number().int(), lifecycleState: z.string().nullable(), parentTaskId: z.string().nullable(), currentSubmissionId: z.string().nullable(), dependsOnTaskIds: z.array(z.string()), citations: z.array(exportRequirementSchema.shape.citations.element), status: z.string(), assignee_id: z.string().nullable(), due_date: z.string().nullable() })),
  events: z.array(z.object({ type: z.string(), occurred_at: z.string() })),
  aiUsage: z.object({
    calls: z.number().int(),
    promptTokens: z.number().int(),
    completionTokens: z.number().int(),
    costStatus: z.string(),
    note: z.string(),
  }),
}), 'ExportBundleResponse');

const exportRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/export-bundle',
  tags: ['ledger'],
  summary: '导出成果说明 JSON 汇总（材料 Markdown + 要求 + 活动历史）',
  request: { params: projectParams },
  responses: {
    200: { content: { 'application/json': { schema: exportBundleResponse } }, description: '导出汇总' },
  },
});

export function registerLedgerRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use('/api/v1/projects/:projectId/events/*', requireUser, requireProjectMember());
  app.use('/api/v1/projects/:projectId/export-bundle/*', requireUser, requireProjectMember());

  app.openapi(eventsRoute, async (c) => {
    const member = c.get('member')!;
    const paging = parsePaging(c.req.valid('query'));
    const type = c.req.valid('query').type;
    const binds: unknown[] = [member.projectId];
    let where = 'project_id = ?1';
    if (type) {
      binds.push(type);
      where += ` AND type = ?${binds.length}`;
    }
    if (paging.cursor) {
      binds.push(paging.cursor.createdAt, paging.cursor.createdAt, paging.cursor.id);
      where += ' AND (occurred_at < ? OR (occurred_at = ? AND id < ?))';
    }
    binds.push(paging.limit + 1);
    const rows = await c.env.DB.prepare(
      `SELECT * FROM events WHERE ${where} ORDER BY occurred_at DESC, id DESC LIMIT ?`,
    )
      .bind(...binds)
      .all<{ id: string; type: string; actor_type: string; actor_id: string; entity_type: string; entity_id: string; payload_json: string; occurred_at: string }>();
    const hasMore = rows.results.length > paging.limit;
    const pageRows = rows.results.slice(0, paging.limit);
    const lastRow = pageRows[pageRows.length - 1];
    return c.json(
      apiData(c, {
        items: pageRows.map((r) => ({
          eventId: r.id,
          type: r.type,
          actorType: r.actor_type as 'user' | 'ai' | 'system',
          actorId: r.actor_id,
          entityType: r.entity_type,
          entityId: r.entity_id,
          payload: JSON.parse(r.payload_json) as Record<string, unknown>,
          occurredAt: r.occurred_at,
        })),
        nextCursor: nextCursor(hasMore, lastRow ? { createdAt: lastRow.occurred_at, id: lastRow.id } : undefined) ?? null,
      }),
      200,
    );
  });

  app.openapi(exportRoute, async (c) => {
    const member = c.get('member')!;
    const projectId = member.projectId;

    const project = await c.env.DB.prepare('SELECT id, name, description, competition_deadline_date, status FROM projects WHERE id = ?1')
      .bind(projectId)
      .first<{ id: string; name: string; description: string; competition_deadline_date: string | null; status: string }>();
    if (!project) throw notFound('项目不存在');

    const materials = await c.env.DB.prepare(
      `SELECT m.id AS materialId, v.id AS versionId, m.purpose, m.title, v.markdown, v.attachments_json, v.revision FROM materials m JOIN material_versions v ON v.id = m.current_version_id WHERE m.project_id = ?1 ORDER BY m.created_at`,
    )
      .bind(projectId)
      .all<{ materialId: string; versionId: string; purpose: string; title: string; markdown: string; revision: number; attachments_json: string }>();

    const requirementSets = await c.env.DB.prepare(
      'SELECT id, source_version_id, status, revision, confirmed_at FROM requirement_sets WHERE project_id = ?1 ORDER BY created_at, id',
    )
      .bind(projectId)
      .all<{ id: string; source_version_id: string | null; status: 'draft' | 'confirmed'; revision: number; confirmed_at: string | null }>();
    const requirements = await c.env.DB.prepare(
      'SELECT id, requirement_set_id, seq, category, title, detail, due_date, due_precision, citations_json, field_state FROM requirements WHERE project_id = ?1 ORDER BY requirement_set_id, seq, id',
    )
      .bind(projectId)
      .all<{
        id: string; requirement_set_id: string; seq: number; category: string; title: string; detail: string;
        due_date: string | null; due_precision: string; citations_json: string; field_state: string;
      }>();
    const requirementsBySet = new Map<string, typeof requirements.results>();
    for (const requirement of requirements.results) {
      const list = requirementsBySet.get(requirement.requirement_set_id) ?? [];
      list.push(requirement);
      requirementsBySet.set(requirement.requirement_set_id, list);
    }

    const rubricVersions = await c.env.DB.prepare(
      'SELECT id, version, source, weights_json, notes, status, confirmed_at, created_at FROM rubric_versions WHERE project_id = ?1 ORDER BY version',
    )
      .bind(projectId)
      .all<{
        id: string; version: number; source: 'official' | 'custom'; weights_json: string; notes: string | null;
        status: 'draft' | 'confirmed'; confirmed_at: string | null; created_at: string;
      }>();

    const tasks = await c.env.DB.prepare('SELECT id, title, detail, criteria, effort_hours, revision, lifecycle_state, parent_task_id, current_submission_id, source_citations_json, status, assignee_id, due_date FROM tasks WHERE project_id = ?1 ORDER BY created_at,id')
      .bind(projectId)
      .all<{ id: string; title: string; detail: string; criteria: string; effort_hours: number; revision: number; lifecycle_state: string | null; parent_task_id: string | null; current_submission_id: string | null; source_citations_json: string; status: string; assignee_id: string | null; due_date: string | null }>();

    const [mainGoal, standardRows, assessmentRows, dependencyRows, submissionRows, sourceRows, sourceVersionRows, materialVersionRows, legacyReviews, legacyRehearsals] = await Promise.all([
      projectGoal(c.env, projectId),
      c.env.DB.prepare('SELECT * FROM standards_versions WHERE project_id=?1 ORDER BY version').bind(projectId).all<StandardRow>(),
      c.env.DB.prepare('SELECT * FROM assessments WHERE project_id=?1 ORDER BY created_at,id').bind(projectId).all<AssessmentRow>(),
      c.env.DB.prepare('SELECT task_id,depends_on_task_id FROM task_dependencies WHERE project_id=?1 ORDER BY task_id,depends_on_task_id').bind(projectId).all<{ task_id: string; depends_on_task_id: string }>(),
      c.env.DB.prepare('SELECT id,task_id,round,submitted_by,body,criteria,status,material_versions_json,ai_report_json,human_score_override_json,decision,feedback,created_at FROM task_submissions WHERE project_id=?1 ORDER BY task_id,round').bind(projectId).all<{ id: string; task_id: string; round: number; submitted_by: string; body: string; criteria: string; status: string; material_versions_json: string; ai_report_json: string | null; human_score_override_json: string | null; decision: string | null; feedback: string | null; created_at: string }>(),
      c.env.DB.prepare('SELECT id,title,purpose,current_version_id,deleted_at FROM sources WHERE project_id=?1 ORDER BY created_at,id').bind(projectId).all<{ id: string; title: string; purpose: string; current_version_id: string | null; deleted_at: string | null }>(),
      c.env.DB.prepare(`SELECT v.id,v.source_id,v.revision,v.origin,v.file_id,v.status,v.created_at,
        (SELECT json_group_array(json_object('fragmentId',f.id,'pageNumber',f.page_number,'seq',f.seq,'content',f.content)) FROM source_fragments f WHERE f.source_version_id=v.id AND f.project_id=?1) fragments_json
        FROM source_versions v WHERE v.project_id=?1 ORDER BY v.source_id,v.revision`).bind(projectId).all<{ id: string; source_id: string; revision: number; origin: string; file_id: string | null; status: string; created_at: string; fragments_json: string }>(),
      c.env.DB.prepare('SELECT id,material_id,revision,markdown,attachments_json,created_at FROM material_versions WHERE project_id=?1 ORDER BY material_id,revision').bind(projectId).all<{ id: string; material_id: string; revision: number; markdown: string; attachments_json: string; created_at: string }>(),
      c.env.DB.prepare('SELECT id,requirement_set_id,rubric_version_id,status,material_version_ids_json,report_json,created_at FROM reviews WHERE project_id=?1 AND NOT EXISTS(SELECT 1 FROM assessments a WHERE a.entity_id=reviews.id) ORDER BY created_at,id').bind(projectId).all<{ id: string; requirement_set_id: string; rubric_version_id: string; status: string; material_version_ids_json: string; report_json: string | null; created_at: string }>(),
      c.env.DB.prepare(`SELECT r.id,r.status,r.material_version_ids_json,r.created_at,
        (SELECT content_json FROM rehearsal_turns t WHERE t.rehearsal_id=r.id AND t.kind='summary' ORDER BY sequence DESC LIMIT 1) report_json
        FROM rehearsals r WHERE r.project_id=?1 AND NOT EXISTS(SELECT 1 FROM assessments a WHERE a.entity_id=r.id) ORDER BY r.created_at,r.id`).bind(projectId).all<{ id: string; status: string; material_version_ids_json: string; report_json: string | null; created_at: string }>(),
    ]);
    const taskDependencies = dependencyRows.results.map(row => ({ taskId: row.task_id, dependsOnTaskId: row.depends_on_task_id }));
    const taskLinks = await c.env.DB.prepare('SELECT id,task_id,kind,target_id,created_at FROM task_links WHERE project_id=?1 ORDER BY task_id,created_at,id').bind(projectId).all<{ id: string; task_id: string; kind: string; target_id: string; created_at: string }>();
    const rehearsalTurns = await c.env.DB.prepare('SELECT rehearsal_id,sequence,kind,content_json,created_at FROM rehearsal_turns WHERE project_id=?1 ORDER BY rehearsal_id,sequence').bind(projectId).all<{ rehearsal_id: string; sequence: number; kind: string; content_json: string; created_at: string }>();
    const historicalAssessments = [
      ...legacyReviews.results.map(row => ({ assessmentId: row.id, kind: 'material_review' as const, status: row.status, goalRevision: null, goal: null, standardsVersionId: null, standardsVersion: null, materialVersionIds: JSON.parse(row.material_version_ids_json) as string[], rehearsalId: null, jobId: null, jobError: null, report: row.report_json ? JSON.parse(row.report_json) as unknown : null, createdAt: row.created_at, historical: true as const })),
      ...legacyRehearsals.results.map(row => ({ assessmentId: row.id, kind: 'rehearsal' as const, status: row.status, goalRevision: null, goal: null, standardsVersionId: null, standardsVersion: null, materialVersionIds: JSON.parse(row.material_version_ids_json) as string[], rehearsalId: row.id, jobId: null, jobError: null, report: row.report_json ? JSON.parse(row.report_json) as unknown : null, createdAt: row.created_at, historical: true as const })),
    ];

    const events = await c.env.DB.prepare('SELECT type, occurred_at FROM events WHERE project_id = ?1 ORDER BY occurred_at DESC LIMIT 200')
      .bind(projectId)
      .all<{ type: string; occurred_at: string }>();

    const aiUsage = await c.env.DB.prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
              CASE WHEN COUNT(*) = 0 OR SUM(CASE WHEN cost_status = 'unknown' THEN 1 ELSE 0 END) > 0
                   THEN 'unknown' ELSE 'known' END AS cost_status
         FROM ai_calls WHERE project_id = ?1`,
    )
      .bind(projectId)
      .first<{ calls: number; prompt_tokens: number; completion_tokens: number; cost_status: string }>();

    return c.json(
      apiData(c, {
        project,
        generatedAt: nowIso(),
        mainGoal,
        standardsVersions: await Promise.all(standardRows.results.map(row => standardView(c.env, row))),
        assessments: [...await Promise.all(assessmentRows.results.map(row => assessmentView(c.env, row))), ...historicalAssessments],
        legacyReviews: legacyReviews.results.map(row => ({ reviewId: row.id, requirementSetId: row.requirement_set_id, rubricVersionId: row.rubric_version_id, materialVersionIds: JSON.parse(row.material_version_ids_json) as string[], status: row.status, report: row.report_json ? JSON.parse(row.report_json) as unknown : null, createdAt: row.created_at })),
        taskDependencies,
        taskLinks: taskLinks.results.map(row => ({ linkId: row.id, taskId: row.task_id, kind: row.kind, targetId: row.target_id, createdAt: row.created_at })),
        taskSubmissions: submissionRows.results.map(row => ({ submissionId: row.id, taskId: row.task_id, round: row.round, submittedBy: row.submitted_by, body: row.body, criteria: row.criteria, status: row.status, materialVersionIds: JSON.parse(row.material_versions_json) as string[], aiReport: row.ai_report_json ? JSON.parse(row.ai_report_json) as unknown : null, humanScoreOverride: row.human_score_override_json ? JSON.parse(row.human_score_override_json) as unknown : null, decision: row.decision, feedback: row.feedback, createdAt: row.created_at })),
        sources: sourceRows.results.map(row => ({ sourceId: row.id, title: row.title, purpose: row.purpose, currentVersionId: row.current_version_id, deletedAt: row.deleted_at })),
        sourceVersions: sourceVersionRows.results.map(row => ({ sourceVersionId: row.id, sourceId: row.source_id, revision: row.revision, origin: row.origin, fileId: row.file_id, status: row.status, createdAt: row.created_at, fragments: (JSON.parse(row.fragments_json) as Array<{ fragmentId: string; pageNumber: number | null; seq: number; content: string }>).sort((a, b) => a.seq - b.seq) })),
        materialVersions: await Promise.all(materialVersionRows.results.map(async row => ({ versionId: row.id, materialId: row.material_id, revision: row.revision, markdown: row.markdown, createdAt: row.created_at, attachments: await Promise.all((JSON.parse(row.attachments_json) as Array<{ fileId: string; name: string }>).map(async attachment => ({ ...attachment, ...await fileReferenceAvailability(c.env, projectId, attachment.fileId) }))) }))),
        rehearsalTurns: rehearsalTurns.results.map(row => ({ rehearsalId: row.rehearsal_id, sequence: row.sequence, kind: row.kind, content: JSON.parse(row.content_json) as unknown, createdAt: row.created_at })),
        materials: await Promise.all(materials.results.map(async ({ attachments_json, ...material }) => ({ ...material, attachments: await Promise.all((JSON.parse(attachments_json) as Array<{ fileId: string; name: string }>).map(async attachment => ({ ...attachment, ...await fileReferenceAvailability(c.env, projectId, attachment.fileId) }))) }))),
        requirementSets: await Promise.all(requirementSets.results.map(async (set) => {
          const availability = set.source_version_id ? await sourceReferenceAvailability(c.env, projectId, set.source_version_id) : undefined;
          return {
            requirementSetId: set.id,
            sourceVersionId: set.source_version_id,
            ...(availability ? { sourceAvailability: availability.availability, sourceDeletedAt: availability.deletedAt } : {}),
            status: set.status,
            revision: set.revision,
            confirmedAt: set.confirmed_at,
            requirements: await Promise.all((requirementsBySet.get(set.id) ?? []).map(async (requirement) => ({
              requirementId: requirement.id,
              seq: requirement.seq,
              category: requirement.category as 'deadline' | 'deliverable' | 'format' | 'scoring' | 'team' | 'other',
              title: requirement.title,
              detail: requirement.detail,
              dueDate: requirement.due_date,
              duePrecision: requirement.due_precision as 'date' | 'datetime' | 'unknown',
              citations: await Promise.all((JSON.parse(requirement.citations_json) as Array<{ sourceVersionId?: string; fragmentId: string; pageNumber: number | null; quote: string }>).map(async citation => ({ ...citation, ...await sourceCitationAvailability(c.env, projectId, citation) }))),
              fieldState: requirement.field_state as 'ai_suggestion' | 'edited' | 'confirmed',
            }))),
          };
        })),
        rubricVersions: rubricVersions.results.map((rubric) => ({
          rubricId: rubric.id,
          version: rubric.version,
          source: rubric.source,
          weights: JSON.parse(rubric.weights_json) as Array<{ key: string; label: string; weight: number }>,
          notes: rubric.notes,
          status: rubric.status,
          confirmedAt: rubric.confirmed_at,
          createdAt: rubric.created_at,
        })),
        tasks: await Promise.all(tasks.results.map(async row => ({ taskId: row.id, title: row.title, detail: row.detail, criteria: row.criteria, effortHours: row.effort_hours, revision: row.revision, lifecycleState: row.lifecycle_state, parentTaskId: row.parent_task_id, currentSubmissionId: row.current_submission_id, dependsOnTaskIds: taskDependencies.filter(edge => edge.taskId === row.id).map(edge => edge.dependsOnTaskId), citations: await Promise.all((JSON.parse(row.source_citations_json || '[]') as Array<{ sourceVersionId: string; fragmentId: string; pageNumber: number | null; quote: string }>).map(async citation => ({ ...citation, ...await sourceCitationAvailability(c.env, projectId, citation) }))), status: row.status, assignee_id: row.assignee_id, due_date: row.due_date }))),
        events: events.results,
        aiUsage: {
          calls: aiUsage?.calls ?? 0,
          promptTokens: aiUsage?.prompt_tokens ?? 0,
          completionTokens: aiUsage?.completion_tokens ?? 0,
          costStatus: aiUsage?.cost_status ?? 'unknown',
          note: '费用未知时如实标注，不填零',
        },
      }),
      200,
    );
  });
}
