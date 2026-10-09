SELECT name, sql FROM sqlite_master
WHERE type IN ('index', 'trigger')
  AND tbl_name IN ('usage_reservations', 'ai_calls', 'ai_diagnostics')
ORDER BY name;

EXPLAIN QUERY PLAN
SELECT id, created_at, attempts_started FROM usage_reservations
WHERE job_id = 'd1-read-audit-missing' AND status = 'reserved'
ORDER BY created_at DESC LIMIT 1;

SELECT id, created_at, attempts_started FROM usage_reservations
WHERE job_id = 'd1-read-audit-missing' AND status = 'reserved'
ORDER BY created_at DESC LIMIT 1;

EXPLAIN QUERY PLAN
SELECT EXISTS (SELECT 1 FROM ai_calls WHERE job_id = 'd1-read-audit-missing');

SELECT EXISTS (SELECT 1 FROM ai_calls WHERE job_id = 'd1-read-audit-missing');

SELECT r.job_id FROM usage_reservations r
LEFT JOIN jobs j ON j.id = r.job_id
WHERE r.status = 'reserved'
  AND (j.status IN ('succeeded','failed','cancelled','waiting_input')
    OR (j.id IS NULL AND r.created_at <= '2000-01-01T00:00:00.000Z')
    OR EXISTS (SELECT 1 FROM ai_executions e
      WHERE e.target_kind = 'job' AND e.target_id = r.job_id AND e.state = 'paused'));

SELECT id FROM (
  SELECT id, ROW_NUMBER() OVER (ORDER BY id DESC) AS entry_rank,
    SUM(byte_size) OVER (ORDER BY id DESC ROWS UNBOUNDED PRECEDING) AS newest_bytes
  FROM ai_diagnostics
) WHERE entry_rank > 1000 OR newest_bytes > 999488;

SELECT
  (SELECT COUNT(*) FROM ai_calls) AS ai_calls,
  (SELECT COUNT(*) FROM usage_reservations) AS reservations,
  (SELECT COUNT(*) FROM ai_diagnostics) AS diagnostics,
  (SELECT COALESCE(SUM(byte_size),0) FROM ai_diagnostics) AS diagnostic_bytes;
