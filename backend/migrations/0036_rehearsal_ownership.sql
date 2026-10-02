ALTER TABLE rehearsals ADD COLUMN processing_job_id TEXT;
ALTER TABLE rehearsal_turns ADD COLUMN author_id TEXT REFERENCES users(id);
UPDATE rehearsal_turns SET author_id=(SELECT created_by FROM rehearsals WHERE id=rehearsal_turns.rehearsal_id) WHERE kind='answer';
UPDATE rehearsals SET processing_job_id=(SELECT id FROM jobs WHERE kind='rehearsal_turn' AND json_extract(input_json,'$.rehearsalId')=rehearsals.id ORDER BY created_at DESC,id DESC LIMIT 1) WHERE status='active';
UPDATE rehearsals SET processing_job_id=NULL WHERE processing_job_id IN (SELECT id FROM jobs WHERE status IN ('succeeded','cancelled'));
