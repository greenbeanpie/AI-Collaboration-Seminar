-- Additive: existing Gemini files and Whisper records retain their original behavior.
ALTER TABLE media_processing ADD COLUMN provider TEXT NOT NULL DEFAULT 'gemini' CHECK(provider IN ('gemini','mimo'));
ALTER TABLE media_calls ADD COLUMN provider TEXT NOT NULL DEFAULT 'gemini' CHECK(provider IN ('gemini','mimo'));
ALTER TABLE media_calls ADD COLUMN cached_tokens INTEGER;
ALTER TABLE media_calls ADD COLUMN audio_tokens INTEGER;
ALTER TABLE media_calls ADD COLUMN video_tokens INTEGER;
