ALTER TABLE ai_calls ADD COLUMN cached_tokens INTEGER;
ALTER TABLE ai_calls ADD COLUMN cache_miss_tokens INTEGER;
ALTER TABLE ai_calls ADD COLUMN context_metadata_json TEXT;
