-- Project-scoped opt-in. Preserve historical project data, modes and budgets.
ALTER TABLE projects ADD COLUMN ai_collaboration_enabled INTEGER NOT NULL DEFAULT 0 CHECK(ai_collaboration_enabled IN (0,1));

-- Human assistive override is separate; never replace immutable AI evidence.
ALTER TABLE task_submissions ADD COLUMN human_score_override_json TEXT;
