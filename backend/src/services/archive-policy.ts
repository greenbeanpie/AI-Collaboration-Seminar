/** Default discovery excludes archived content; fixed historical reads deliberately do not use these predicates. */
export function activeMaterialSql(alias = 'm'): string {
  return `${alias}.archived_at IS NULL AND NOT EXISTS(SELECT 1 FROM material_versions archive_version, json_each(archive_version.attachments_json) archive_attachment JOIN files archive_file ON archive_file.id=json_extract(archive_attachment.value,'$.fileId') WHERE archive_version.id=${alias}.current_version_id AND archive_file.archived_at IS NOT NULL)`;
}
export function discoverableFileSql(alias = 'f'): string {
  return `${alias}.archived_at IS NULL AND NOT EXISTS(SELECT 1 FROM task_file_uploads archive_mapping JOIN materials archive_material ON archive_material.id=archive_mapping.material_id WHERE archive_mapping.file_id=${alias}.id AND (archive_material.archived_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM material_versions archive_current,json_each(archive_current.attachments_json) archive_attachment WHERE archive_current.id=archive_material.current_version_id AND json_extract(archive_attachment.value,'$.fileId')=${alias}.id)))`;
}
export function discoverableSourceSql(versionAlias = 'v'): string {
  return `(${versionAlias}.origin!='file' OR EXISTS(SELECT 1 FROM files archive_source_file WHERE archive_source_file.id=${versionAlias}.file_id AND ${discoverableFileSql('archive_source_file')}))`;
}
