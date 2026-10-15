import { effectiveStandardCaptureGuardSql, effectiveStandardGuardSql } from './effective-standard';
import { profileSnapshotGuard } from './personal-profiles';
import { projectSourceContextGuard } from './collaboration-context';
import { projectPermissionSql } from './project-permissions';
import { projectReferenceGuard } from './project-reference-guard';
import { sourceLifecycleGuard } from './source-lifecycle';
import { pristineTasksSql } from './task-planning-policy';

/** Join non-empty SQL predicate expressions with ` AND `. */
export function andSqlPredicates(predicates: Array<string | false | null | undefined>): string {
  return predicates
    .map(p => (typeof p === 'string' ? p.trim().replace(/^AND\s+/i, '') : ''))
    .filter(Boolean)
    .join(' AND ');
}

/** Build the atomic WHERE clause and CTE for `applyProposal` in `collaboration.ts`. */
export function buildProposalApplySql(params: {
  kind: 'decompose' | 'assign';
  planningAction?: 'regenerate' | 'adjust';
}): { cte: string; whereClause: string } {
  const { kind, planningAction } = params;
  const isDecompose = kind === 'decompose';
  const isAssign = kind === 'assign';
  const isRegenerate = isDecompose && planningAction === 'regenerate';

  const validGoalPredicate = `EXISTS(SELECT 1 FROM project_goals g JOIN jobs j ON j.id=collaboration_proposals.job_id WHERE g.project_id=?2 AND g.revision=COALESCE(json_extract(j.input_json,'$.goalRevision'),g.revision) AND g.graph_revision=COALESCE(json_extract(j.input_json,'$.graphRevision'),g.graph_revision))`;

  const validProfilesClause = isAssign
    ? `AND ${profileSnapshotGuard("(SELECT json_extract(input_json,'$.profileStamp') FROM jobs WHERE id=collaboration_proposals.job_id)", '?2')} AND NOT EXISTS(SELECT 1 FROM jobs j,json_each(j.input_json,'$.members') snapshot WHERE j.id=collaboration_proposals.job_id AND NOT EXISTS(SELECT 1 FROM project_members pm WHERE pm.project_id=?2 AND pm.user_id=json_extract(snapshot.value,'$.userId') AND COALESCE((SELECT SUM(effort_hours) FROM tasks WHERE project_id=?2 AND assignee_id=pm.user_id AND status!='done'),0)=json_extract(snapshot.value,'$.loadHours')))`
    : '';

  const validUpdatesPredicate = isDecompose
    ? `NOT EXISTS(SELECT 1 FROM json_each(?9,'$.updates') u WHERE NOT EXISTS(SELECT 1 FROM tasks t WHERE t.project_id=?2 AND t.archived_at IS NULL AND t.id=json_extract(u.value,'$.taskId') AND t.revision=json_extract(u.value,'$.expectedRevision') AND (?6=0 OR (t.lifecycle_state IN ('open','in_progress','improve','rework') OR (t.lifecycle_state IS NULL AND t.status!='done')))))`
    : null;

  const validAssignmentsPredicate = isAssign
    ? `NOT EXISTS(SELECT 1 FROM json_each(?9,'$.assignments') a WHERE NOT EXISTS(SELECT 1 FROM tasks t WHERE t.project_id=?2 AND t.archived_at IS NULL AND t.id=json_extract(a.value,'$.taskId') AND t.revision=json_extract(a.value,'$.expectedRevision') AND (json_extract(a.value,'$.assigneeId') IS NULL OR EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=?2 AND m.user_id=json_extract(a.value,'$.assigneeId'))) AND (?6=0 OR (t.assignee_id IS NULL AND (t.lifecycle_state='open' OR (t.lifecycle_state IS NULL AND t.status!='done'))))))`
    : null;

  const cte = `WITH reference_validation AS (SELECT ${projectReferenceGuard("json_extract(?9,'$.references')", '?2')} valid)`;

  const whereClause = andSqlPredicates([
    "id=?1 AND project_id=?2 AND revision=?3 AND status='pending'",
    `EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?4 AND ${projectPermissionSql('project_members.project_id', 'project_members.user_id', 'taskManage')})`,
    "EXISTS(SELECT 1 FROM projects WHERE id=?2 AND (?6=0 OR (collaboration_revision=collaboration_proposals.settings_revision AND ai_collaboration_enabled=1 AND status='active' AND CASE WHEN collaboration_proposals.kind='assign' THEN assignment_mode ELSE planning_mode END='automatic')))",
    '(?6=0 OR EXISTS(SELECT 1 FROM ai_config_versions WHERE id=?7 AND enabled=1 AND version=(SELECT MAX(version) FROM ai_config_versions)))',
    isDecompose && `${projectPermissionSql('?2', '?4', 'taskManage')} AND (?6=0)`,
    isRegenerate && pristineTasksSql('?2'),
    isRegenerate && validGoalPredicate,
    validAssignmentsPredicate,
    validUpdatesPredicate,
    isDecompose ? `(?6=0 OR (1=1 AND ${validGoalPredicate}))` : '(?6=0 OR (1=1))',
    `((?6=0 AND EXISTS(SELECT 1 FROM collaboration_proposal_revisions correction WHERE correction.proposal_id=collaboration_proposals.id AND correction.project_id=?2 AND length(trim(correction.reason))>0)) OR (1=1 ${validProfilesClause} AND ${projectSourceContextGuard("(SELECT input_json FROM jobs WHERE id=collaboration_proposals.job_id)", '?2')} AND (SELECT valid FROM reference_validation)))`,
    effectiveStandardCaptureGuardSql('?2', "json_extract(?9,'$.effectiveStandardsVersionId')"),
    "(?6=0 OR EXISTS(SELECT 1 FROM jobs WHERE id=collaboration_proposals.job_id AND status IN ('queued','running')))",
  ]);

  return { cte, whereClause };
}

/** Build the atomic WHERE clause for `decideSubmission` in `collaboration.ts`. */
export function buildSubmissionDecideWhereSql(): string {
  return andSqlPredicates([
    'id=?1 AND project_id=?2 AND revision=?3',
    "(?8=0 OR status IN ('pending','evaluated'))",
    "EXISTS(SELECT 1 FROM tasks t JOIN project_members m ON m.project_id=t.project_id AND m.user_id=t.assignee_id WHERE t.id=task_submissions.task_id AND t.current_submission_id=?1 AND (?8=0 OR (t.lifecycle_state='submitted' AND t.revision=task_submissions.task_revision AND t.assignee_id=task_submissions.submitted_by)))",
    `EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?6 AND (${projectPermissionSql('project_members.project_id', 'project_members.user_id', 'taskManage')} OR (?8=1 AND user_id=task_submissions.submitted_by)))`,
    "EXISTS(SELECT 1 FROM projects WHERE id=?2 AND (?8=0 OR (ai_collaboration_enabled=1 AND status='active' AND evaluation_mode='automatic' AND collaboration_revision=?9)))",
    "(?8=0 OR EXISTS(SELECT 1 FROM jobs WHERE id=task_submissions.evaluation_job_id AND status IN ('queued','running')))",
    '(?8=0 OR EXISTS(SELECT 1 FROM ai_config_versions WHERE id=?10 AND enabled=1 AND version=(SELECT MAX(version) FROM ai_config_versions)))',
    "(?8=0 OR ?12=0 OR (?12=1 AND NOT EXISTS(SELECT 1 FROM standards_versions WHERE project_id=?2)) OR (?12=2 AND EXISTS(SELECT 1 FROM standards_versions WHERE project_id=?2 AND id=?18 AND version=(SELECT MAX(version) FROM standards_versions WHERE project_id=?2) AND json_extract(snapshot_json,'$.rubric.rubricVersionId')=?13 AND json_extract(snapshot_json,'$.rubric.version')=?14 AND json_extract(snapshot_json,'$.rubric.weights')=?15 AND json_extract(snapshot_json,'$.rubric.notes') IS ?16)))",
  ]);
}

/** Build the atomic guard predicate list for `retryFailedAiJob` in `admin-ai-retries.ts`. */
export function buildAdminAiRetryGuards(params: {
  projectId: string | null;
  requiredPermission: 'owner' | 'taskManage' | 'scoreCorrect' | 'scoreInitiate' | null;
  input: Record<string, any>;
  chatContextStampSql: string;
}): { guards: string[]; reset: Array<{ table: string; pointer: string; extra?: string }> } {
  const { projectId, requiredPermission, input, chatContextStampSql } = params;
  const guards: string[] = [
    'EXISTS(SELECT 1 FROM auth_accounts WHERE user_id=?4 AND password_hash IS NOT NULL)',
    "old.status='failed'",
    'old.updated_at=?3',
    'NOT EXISTS(SELECT 1 FROM admin_ai_retry_links WHERE parent_job_id=old.id)',
  ];

  if (projectId) {
    guards.push("EXISTS(SELECT 1 FROM projects p JOIN project_members m ON m.project_id=p.id WHERE p.id=old.project_id AND p.status='active' AND m.user_id=?4)");
    if (requiredPermission === 'owner') {
      guards.push("EXISTS(SELECT 1 FROM project_members WHERE project_id=old.project_id AND user_id=?4 AND role='owner')");
    } else if (requiredPermission) {
      guards.push(projectPermissionSql('old.project_id', '?4', requiredPermission));
    }
  }
  if (input.goalRevision !== undefined || input.goal?.revision !== undefined) {
    guards.push("EXISTS(SELECT 1 FROM project_goals WHERE project_id=old.project_id AND revision=COALESCE(json_extract(old.input_json,'$.goalRevision'),json_extract(old.input_json,'$.goal.revision')))");
  }
  if (input.operation === 'standards.generate' || input.operation?.startsWith('collaboration.')) {
    guards.push("EXISTS(SELECT 1 FROM ai_config_versions WHERE id=json_extract(old.input_json,'$.configVersionId') AND enabled=1 AND version=(SELECT MAX(version) FROM ai_config_versions))");
  }
  if (input.sourceVersionId) {
    guards.push(sourceLifecycleGuard("json_extract(old.input_json,'$.sourceVersionId')", "COALESCE(json_extract(old.input_json,'$.sourceLifecycleVersion'),1)"));
    if (input.operation !== 'source.summary' && input.operation !== 'media.summary') {
      guards.push("EXISTS(SELECT 1 FROM source_versions v JOIN sources s ON s.id=v.source_id WHERE v.id=json_extract(old.input_json,'$.sourceVersionId') AND s.current_version_id=v.id) AND NOT EXISTS(SELECT 1 FROM jobs newer WHERE newer.project_id=old.project_id AND newer.id!=old.id AND json_extract(newer.input_json,'$.sourceVersionId')=json_extract(old.input_json,'$.sourceVersionId') AND newer.kind=old.kind AND COALESCE(json_extract(newer.input_json,'$.operation'),'')=COALESCE(json_extract(old.input_json,'$.operation'),'') AND COALESCE(json_extract(newer.input_json,'$.phase'),'')=COALESCE(json_extract(old.input_json,'$.phase'),'') AND (newer.created_at>old.created_at OR newer.status IN ('queued','running','waiting_input')))");
    }
    guards.push("EXISTS(SELECT 1 FROM source_versions v JOIN sources s ON s.id=v.source_id WHERE v.id=json_extract(old.input_json,'$.sourceVersionId') AND s.current_version_id=v.id)");
  }
  if (input.operation === 'media.summary') {
    guards.push("NOT EXISTS(SELECT 1 FROM source_processing WHERE source_version_id=json_extract(old.input_json,'$.sourceVersionId') AND summary_job_id IS NOT NULL AND summary_job_id!=old.id)");
  }
  if (input.standardsVersionId) {
    guards.push(effectiveStandardGuardSql('old.project_id', "json_extract(old.input_json,'$.standardsVersionId')"));
  }
  if (input.settingsRevision !== undefined) {
    guards.push("EXISTS(SELECT 1 FROM projects WHERE id=old.project_id AND ai_collaboration_enabled=1 AND collaboration_revision=json_extract(old.input_json,'$.settingsRevision'))");
  }
  if (input.operation === 'project.chat') {
    guards.push(
      "EXISTS(SELECT 1 FROM project_ai_chat_questions q JOIN project_ai_chat_sessions s ON s.id=q.session_id AND s.generation=q.generation WHERE q.id=json_extract(old.input_json,'$.questionId') AND q.job_id=old.id AND s.job_id=old.id AND q.user_id=?4 AND EXISTS(SELECT 1 FROM projects WHERE id=old.project_id AND ai_collaboration_enabled=1) AND q.context_stamp=(" +
        chatContextStampSql.replaceAll('?1', 'old.project_id') +
        '))',
    );
  }

  const reset: Array<{ table: string; pointer: string; extra?: string }> = [];
  const requireRow = (table: string, pointer: string, condition: string) => {
    guards.push(`EXISTS(SELECT 1 FROM ${table} WHERE ${pointer}=old.id AND ${condition})`);
  };

  if (input.operation === 'project.chat') {
    reset.push({ table: 'project_ai_chat_questions', pointer: 'job_id' }, { table: 'project_ai_chat_sessions', pointer: 'job_id' });
  }
  if (input.operation === 'media.draft') {
    guards.push("EXISTS(SELECT 1 FROM creation_draft_files f JOIN project_creation_drafts d ON d.id=f.draft_id WHERE f.id=json_extract(old.input_json,'$.fileId') AND d.id=json_extract(old.input_json,'$.draftId') AND f.removed=0 AND d.status='active' AND d.owner_id=?4)");
  }
  if (input.operation === 'source.summary') {
    requireRow('source_processing', 'summary_job_id', "summary_status='failed'");
    reset.push({ table: 'source_processing', pointer: 'summary_job_id', extra: "summary_status='queued',summary_error=NULL," });
  }
  if (input.runId) {
    requireRow('agent_runs', 'job_id', "status='failed'");
    reset.push({ table: 'agent_runs', pointer: 'job_id', extra: "status='running',output_json=NULL," });
  }
  if (input.reviewId) {
    requireRow('reviews', 'job_id', "status='failed' AND created_by=?4");
    reset.push({ table: 'reviews', pointer: 'job_id', extra: "status='pending'," });
  }
  if (input.rehearsalId) {
    requireRow('rehearsals', 'processing_job_id', "status='active' AND created_by=?4");
    reset.push({ table: 'rehearsals', pointer: 'processing_job_id', extra: 'finish_job_id=CASE WHEN finish_job_id=?1 THEN ?2 ELSE finish_job_id END,' });
  }
  if (input.followupId) {
    requireRow(
      'assessment_followups',
      'job_id',
      "status='failed' AND user_id=?4 AND EXISTS(SELECT 1 FROM assessments a WHERE a.id=assessment_followups.assessment_id AND a.revision=assessment_followups.base_revision AND a.status='succeeded')",
    );
    reset.push({ table: 'assessment_followups', pointer: 'job_id', extra: "status='queued',error_json=NULL," });
  }
  if (!input.followupId && (input.assessmentId || input.rehearsalId)) {
    requireRow('assessments', 'job_id', "status!='succeeded' AND origin='ai' AND revision=1");
    reset.push({ table: 'assessments', pointer: 'job_id', extra: "status='active'," });
  }
  if (input.submissionId) {
    requireRow(
      'task_submissions',
      'evaluation_job_id',
      "status IN ('pending','evaluated') AND EXISTS(SELECT 1 FROM tasks t WHERE t.current_submission_id=task_submissions.id AND t.lifecycle_state='submitted' AND t.revision=task_submissions.task_revision AND t.assignee_id=task_submissions.submitted_by) AND (submitted_by=?4 OR " +
        projectPermissionSql('task_submissions.project_id', '?4', 'taskManage') +
        ')',
    );
    reset.push({ table: 'task_submissions', pointer: 'evaluation_job_id' });
  }
  if (input.operation === 'collaboration.decompose' || input.operation === 'collaboration.assign') {
    guards.push("NOT EXISTS(SELECT 1 FROM collaboration_proposals WHERE job_id=old.id AND status!='pending')");
    reset.push({ table: 'collaboration_proposals', pointer: 'job_id' });
  }
  const caches: Record<string, string> = {
    'collaboration.summary': 'task_summaries',
    'collaboration.agent-eligibility': 'task_agent_eligibility',
    'collaboration.assistance-plan': 'task_assistance_plans',
  };
  if (caches[input.operation]) {
    requireRow(caches[input.operation]!, 'job_id', "status='failed'");
    reset.push({ table: caches[input.operation]!, pointer: 'job_id', extra: "status='queued'," });
  }
  if (input.taskId) {
    guards.push(
      "EXISTS(SELECT 1 FROM tasks WHERE id=json_extract(old.input_json,'$.taskId') AND project_id=old.project_id AND (assignee_id=?4 OR " +
        projectPermissionSql('old.project_id', '?4', 'taskManage') +
        '))',
    );
  }

  return { guards, reset };
}
