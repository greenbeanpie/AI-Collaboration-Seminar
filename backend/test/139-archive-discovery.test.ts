import { describe, expect, it } from 'vitest';
import { env } from './helpers/env';
import { seedUser, seedProject } from './helpers/seed';
import { executeDiscoveryTool } from '../src/services/project-context';
import { executeFileTool } from '../src/services/project-ai-tools';
import { newId, nowIso } from '../src/core/db';
import { saveTaskFile } from '../src/services/task-files';

describe('archived AI discovery and historical evidence', () => {
  it('excludes archived materials from default discovery and search but permits explicit fixed reads', async () => {
    const owner = await seedUser(), project = await seedProject(owner.userId), material = newId(), version = newId(), now = nowIso();
    await env.DB.prepare("INSERT INTO materials(id,project_id,title,kind,purpose,current_version_id,revision,created_by,created_at,updated_at,archived_at) VALUES(?1,?2,'归档秘密','document','output',?3,1,?4,?5,?5,?5)").bind(material,project,version,owner.userId,now).run();
    await env.DB.prepare("INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at) VALUES(?1,?2,?3,1,'{}','归档秘密正文','manual',?4,?5)").bind(version,material,project,owner.userId,now).run();
    const list = await executeDiscoveryTool(env, project, 'list_project_resources', { offset: 0 });
    expect(JSON.stringify(list)).not.toContain('归档秘密');
    const search = await executeDiscoveryTool(env, project, 'search_project_information', { offset: 0, query: '归档秘密' });
    expect(JSON.stringify(search)).not.toContain('归档秘密');
    const fixed = await executeDiscoveryTool(env, project, 'read_resource', { offset: 0, resourceType: 'material', versionId: version });
    expect(fixed.text).toBe('归档秘密正文'); expect(fixed.archivedAt).toBe(now);
  });
  it('excludes archived files and superseded task upload versions from automatic file listings', async () => {
    const owner = await seedUser(), project = await seedProject(owner.userId), now = nowIso();
    const archived = newId(), active = newId();
    for (const id of [archived, active]) await env.DB.prepare("INSERT INTO files(id,project_id,uploader_user_id,r2_key,ext,status,original_name,created_at,archived_at) VALUES(?1,?2,?3,?1,'.txt','available',?1,?4,?5)").bind(id,project,owner.userId,now,id === archived ? now : null).run();
    const result = await executeFileTool(env, { projectId: project, userId: owner.userId }, 'list_project_files', { offset: 0 });
    expect(JSON.stringify(result)).toContain(active); expect(JSON.stringify(result)).not.toContain(archived);
    const task = newId(), latest = newId();
    await env.DB.prepare("INSERT INTO tasks(id,project_id,title,status,assignee_id,created_by,created_at,updated_at) VALUES(?1,?2,'任务','doing',?3,?3,?4,?4)").bind(task,project,owner.userId,now).run();
    const entry = await saveTaskFile(env, { projectId: project, taskId: task, actorId: owner.userId, fileId: active });
    await env.DB.prepare("INSERT INTO files(id,project_id,uploader_user_id,r2_key,ext,status,original_name,created_at) VALUES(?1,?2,?3,?1,'.txt','available','新版',?4)").bind(latest,project,owner.userId,now).run();
    await saveTaskFile(env, { projectId: project, taskId: task, actorId: owner.userId, fileId: latest, materialId: entry.materialId, expectedRevision: entry.revision });
    const replaced = await executeFileTool(env, { projectId: project, userId: owner.userId }, 'list_project_files', { offset: 0 });
    expect(JSON.stringify(replaced)).not.toContain(active); expect(JSON.stringify(replaced)).toContain(latest);
  });
});
