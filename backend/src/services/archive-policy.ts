/** Default discovery excludes archived content; fixed historical reads deliberately do not use these predicates. */
export function activeMaterialSql(alias = 'm'): string {
  return `${alias}.archived_at IS NULL AND NOT EXISTS(SELECT 1 FROM material_versions archive_version, json_each(archive_version.attachments_json) archive_attachment JOIN files archive_file ON archive_file.id=json_extract(archive_attachment.value,'$.fileId') WHERE archive_version.id=${alias}.current_version_id AND archive_file.archived_at IS NOT NULL)`;
}
export function discoverableFileSql(alias = 'f'): string {
  return `${alias}.archived_at IS NULL AND NOT EXISTS(SELECT 1 FROM task_file_uploads archive_mapping JOIN materials archive_material ON archive_material.id=archive_mapping.material_id WHERE archive_mapping.file_id=${alias}.id AND (archive_material.archived_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM material_versions archive_current,json_each(archive_current.attachments_json) archive_attachment WHERE archive_current.id=archive_material.current_version_id AND json_extract(archive_attachment.value,'$.fileId')=${alias}.id)))`;
}
export function discoverableSourceSql(versionAlias = 'v'): string {
  return `NOT ${recordingChildSourceSql(`${versionAlias}.source_id`)} AND (${versionAlias}.origin!='file' OR EXISTS(SELECT 1 FROM files archive_source_file WHERE archive_source_file.id=${versionAlias}.file_id AND ${discoverableFileSql('archive_source_file')}))`;
}

/** A recording may hide only its automatic source, never a separately imported or referenced original. */
export function recordingChildSourceSql(sourceIdSql: string): string {
  return `EXISTS(SELECT 1 FROM sources recording_source JOIN recording_segments recording_child ON recording_child.source_id=recording_source.id
    JOIN source_versions recording_version ON recording_version.id=recording_child.source_version_id
    WHERE recording_source.id=${sourceIdSql} AND recording_source.automatic_import=1
    AND NOT EXISTS(SELECT 1 FROM material_versions independent_version JOIN materials independent_material ON independent_material.id=independent_version.material_id,json_each(independent_version.attachments_json) independent_attachment
      WHERE independent_material.kind!='file-extracted' AND NOT EXISTS(SELECT 1 FROM recording_sessions own_session WHERE own_session.material_id=independent_material.id)
      AND json_extract(independent_attachment.value,'$.fileId')=recording_version.file_id))`;
}
