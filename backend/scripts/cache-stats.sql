-- Read-only; run with wrangler d1 execute <database> --remote --file scripts/cache-stats.sql.
-- Missing cache usage is excluded from the cache-rate denominator and shown in coverage.
-- repeatedReads counts repeated tool-read attempts for each call's step, not a cumulative total.
SELECT
  COALESCE(job_id, draft_id, run_id, id) AS task_id,
  json_extract(context_metadata_json, '$.protocol') AS protocol,
  prompt_version,
  json_extract(context_metadata_json, '$.stage') AS stage,
  COUNT(*) AS calls,
  SUM(prompt_tokens) AS reported_input_tokens,
  SUM(completion_tokens) AS reported_output_tokens,
  SUM(cached_tokens) AS reported_cached_input_tokens,
  SUM(CASE WHEN prompt_tokens IS NOT NULL AND cached_tokens IS NOT NULL THEN 1 ELSE 0 END) AS calls_with_cache_usage,
  1.0 * SUM(CASE WHEN prompt_tokens IS NOT NULL AND cached_tokens IS NOT NULL THEN 1 ELSE 0 END) / COUNT(*) AS usage_coverage,
  1.0 * SUM(CASE WHEN prompt_tokens IS NOT NULL AND cached_tokens IS NOT NULL THEN cached_tokens ELSE 0 END)
    / NULLIF(SUM(CASE WHEN prompt_tokens IS NOT NULL AND cached_tokens IS NOT NULL THEN prompt_tokens ELSE 0 END), 0) AS cache_hit_rate,
  SUM(latency_ms) AS total_latency_ms,
  AVG(latency_ms) AS mean_latency_ms,
  SUM(json_extract(context_metadata_json, '$.repeatedReads')) AS repeated_reads,
  MAX(json_extract(context_metadata_json, '$.readTrackingWindow')) AS recent_distinct_read_window,
  SUM(CASE WHEN json_extract(context_metadata_json, '$.repeatedReads') IS NOT NULL THEN 1 ELSE 0 END) AS calls_with_read_metadata
FROM ai_calls
GROUP BY COALESCE(job_id, draft_id, run_id, id),
  json_extract(context_metadata_json, '$.protocol'), prompt_version, json_extract(context_metadata_json, '$.stage')
ORDER BY task_id, stage;

-- Task totals across stages/prompt versions; rates remain weighted by known input tokens.
SELECT COALESCE(job_id, draft_id, run_id, id) AS task_id,
  COUNT(*) AS calls, SUM(prompt_tokens) AS reported_input_tokens,
  SUM(completion_tokens) AS reported_output_tokens, SUM(latency_ms) AS total_latency_ms,
  1.0 * SUM(CASE WHEN prompt_tokens IS NOT NULL AND cached_tokens IS NOT NULL THEN 1 ELSE 0 END) / COUNT(*) AS usage_coverage,
  1.0 * SUM(CASE WHEN prompt_tokens IS NOT NULL AND cached_tokens IS NOT NULL THEN cached_tokens ELSE 0 END)
    / NULLIF(SUM(CASE WHEN prompt_tokens IS NOT NULL AND cached_tokens IS NOT NULL THEN prompt_tokens ELSE 0 END),0) AS cache_hit_rate
FROM ai_calls
GROUP BY COALESCE(job_id, draft_id, run_id, id)
ORDER BY task_id;
