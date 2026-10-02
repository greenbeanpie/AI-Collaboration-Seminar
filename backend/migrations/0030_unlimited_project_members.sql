-- Planned team size is a planning input, never an invitation capacity.
-- Existing projects were created using the template cap or the mistaken draft
-- planned count; owners had no API for configuring a separate capacity.
UPDATE projects
SET team_size_limit = NULL, revision = revision + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE team_size_limit IS NOT NULL;
UPDATE app_config
SET value_json = json_remove(value_json, '$.teamSizeLimit'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE key = 'competition_template' AND json_valid(value_json);
