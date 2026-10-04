import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { env, BASE } from './helpers/env';
import { seedProject, seedUser, authCookie } from './helpers/seed';
import { projectGoal, updateGoal } from '../src/services/project-simplification';
import { newId, nowIso } from '../src/core/db';
import { executeDiscoveryTool } from '../src/services/project-context';

describe('system background synchronization', () => {
  const background = (projectId: string) => env.DB.prepare('SELECT m.*,v.markdown FROM materials m JOIN material_versions v ON v.id=m.current_version_id WHERE m.project_id=?1 AND system_managed=1').bind(projectId).first<{ id: string; current_version_id: string; revision: number; markdown: string }>();
  it('preserves manual background and versions while backfilling exactly one current system copy', async () => {
    const owner = await seedUser(), id = await seedProject(owner.userId, '旧项目'), manual = newId(), version = newId(), now = nowIso();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO materials(id,project_id,title,kind,purpose,is_default_background,current_version_id,created_by,created_at,updated_at) VALUES(?1,?2,'人工背景','background','background',1,?3,?4,?5,?5)").bind(manual,id,version,owner.userId,now),
      env.DB.prepare("INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at) VALUES(?1,?2,?3,1,'{\"type\":\"doc\",\"content\":[]}','旧人工内容','manual',?4,?5)").bind(version,manual,id,owner.userId,now),
    ]);
    await projectGoal(env,id);
    const first = (await background(id))!;
    expect(first.markdown).toContain('项目名称：旧项目');
    expect(first.markdown).toContain('项目说明：尚未填写');
    expect(first.markdown).toContain('主目标：旧项目');
    await env.DB.prepare('UPDATE project_goals SET title=title WHERE project_id=?1').bind(id).run();
    expect(await background(id)).toEqual(first);
    expect(await env.DB.prepare('SELECT current_version_id,revision,system_managed FROM materials WHERE id=?1').bind(manual).first()).toEqual({current_version_id:version,revision:1,system_managed:0});
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM materials WHERE project_id=?1 AND system_managed=1').bind(id).first<{n:number}>())!.n).toBe(1);
  });
  it('synchronizes project/goal changes atomically, preserves old version and exposes latest background to AI', async () => {
    const owner = await seedUser(), id = await seedProject(owner.userId);
    const goal = await projectGoal(env,id), first = (await background(id))!;
    await updateGoal(env,id,owner.userId,{expectedRevision:goal.revision,title:'新主目标',detail:'新目标说明'});
    await env.DB.prepare('UPDATE projects SET name=?2,description=?3 WHERE id=?1').bind(id,'新项目名','新项目说明').run();
    const current = (await background(id))!;
    expect(current.id).toBe(first.id);
    expect(current.revision).toBe(3);
    expect(current.markdown).toContain('新项目说明');
    expect(current.markdown).toContain('新目标说明');
    expect((await env.DB.prepare('SELECT markdown FROM material_versions WHERE id=?1').bind(first.current_version_id).first<{markdown:string}>())!.markdown).toBe(first.markdown);
    expect(await executeDiscoveryTool(env,id,'get_project_overview',{})).toMatchObject({systemBackground:{resourceId:first.id,versionId:current.current_version_id,text:current.markdown}});
    await expect(updateGoal(env,id,owner.userId,{expectedRevision:goal.revision,title:'覆盖'})).rejects.toMatchObject({code:'VERSION_CONFLICT'});
    expect(await background(id)).toEqual(current);
  });
  it('prevents both ordinary saves and purpose edits even for owner; retains read/history access', async () => {
    const owner = await seedUser(), id = await seedProject(owner.userId);
    await projectGoal(env,id);
    const current = (await background(id))!;
    const request = (tail: string, body?: unknown, method = 'GET') => SELF.fetch(`${BASE}/api/v1/projects/${id}${tail}`, {method,headers:{cookie:authCookie(owner.token),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    const detail = await request(`/materials/${current.id}`);
    expect(detail.status).toBe(200);
    expect((await detail.json() as {data:unknown}).data).toMatchObject({systemManaged:true,canEdit:false});
    expect((await request(`/materials/${current.id}`,{expectedRevision:current.revision,doc:{type:'doc',content:[]}},'PUT')).status).toBe(403);
    expect((await request(`/resource-library/material/${current.id}`,{expectedRevision:current.revision,purpose:'output'},'PATCH')).status).toBe(403);
    expect((await request(`/materials/${current.id}/versions`)).status).toBe(200);
    expect(await background(id)).toEqual(current);
  });
});
