import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { registerResourceRoutes } from '../src/api/resources';
import { loadResourceVersionText, projectBackgroundStatements } from '../src/services/resources';
import { profileStamp, recommendationDispatch } from '../src/services/personal-profiles';
import { loadAiConfig } from '../src/ai/config';
import { configureGoFixture } from './helpers/provider-config';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { env, BASE } from './helpers/env';

const profilePath = '/api/v1/auth/personal-profile';
const blank = { searchable: false, aiUseAllowed: false, bio: '', major: '', specialties: '', preferredRoles: '', visibility: { bio: false, major: false, specialties: false, preferredRoles: false }, expectedRevision: 0 };
const headers = (token: string) => ({ cookie: authCookie(token), 'content-type': 'application/json', 'X-Account-Settings': '1' });
const saveProfile = (token: string, body: object) => SELF.fetch(BASE + profilePath, { method: 'PUT', headers: headers(token), body: JSON.stringify(body) });

/** Test-only stand-in for the removed repair helper: create/inspect the default background through the production statement builder. */
async function seedBackground(projectId: string, description: string, actorId: string) {
  if (!description.trim()) return null;
  await env.DB.batch(projectBackgroundStatements(env, projectId, description, actorId));
  const row = await env.DB.prepare('SELECT id,current_version_id FROM materials WHERE project_id=?1 AND is_default_background=1').bind(projectId).first<{ id: string; current_version_id: string }>();
  return { materialId: row!.id, versionId: row!.current_version_id };
}

async function candidate(userId: string, projectId: string, major: string, hours: number | null = 0) {
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO personal_profile_import_candidates(id,user_id,source_project_id,source_project_name,major,skills_json,hours_per_week,created_at)
    VALUES(?1,?2,?3,'旧项目',?4,'["写作","研究"]',?5,'2026-10-02T00:00:00.000Z')`).bind(id,userId,projectId,major,hours).run();
  return id;
}

describe('global profile availability and private legacy candidates', () => {
  it('defaults hours to null, preserves an omitted value, accepts zero and explicit clearing, and rejects limits', async () => {
    const owner = await seedUser();
    const initial = await SELF.fetch(BASE + profilePath, { headers: headers(owner.token) });
    expect((await initial.json() as any).data.weeklyAvailableHours).toBeNull();
    const first = await saveProfile(owner.token, { ...blank, weeklyAvailableHours: 0 });
    expect(first.status).toBe(200); expect((await first.json() as any).data.weeklyAvailableHours).toBe(0);
    const retained = await saveProfile(owner.token, { ...blank, expectedRevision: 1 });
    expect((await retained.json() as any).data.weeklyAvailableHours).toBe(0);
    const cleared = await saveProfile(owner.token, { ...blank, expectedRevision: 2, weeklyAvailableHours: null });
    expect((await cleared.json() as any).data.weeklyAvailableHours).toBeNull();
    for (const hours of [-1, 169]) expect((await saveProfile(owner.token, { ...blank, expectedRevision: 3, weeklyAvailableHours: hours })).status).toBe(400);
    expect((await saveProfile(owner.token, { ...blank, expectedRevision: 2, weeklyAvailableHours: 6 })).status).toBe(409);
  });

  it('keeps candidates owned after leaving a project, paginates without loss, and rejects cross-account imports', async () => {
    const owner = await seedUser(), other = await seedUser();
    const project = await seedProject(owner.userId);
    const ids = await Promise.all([candidate(owner.userId,project,'计算机'),candidate(owner.userId,project,'设计'),candidate(owner.userId,project,'历史')]);
    const foreign = await candidate(other.userId,project,'OTHER-PRIVATE');
    await env.DB.prepare('DELETE FROM project_members WHERE project_id=?1 AND user_id=?2').bind(project,owner.userId).run();
    let cursor: string | null = null; const found: string[] = [];
    do {
      const response = await SELF.fetch(`${BASE}${profilePath}/import-candidates?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { headers: headers(owner.token) });
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
      const body = await response.json() as any; found.push(...body.data.items.map((c: any) => c.candidateId)); cursor = body.data.nextCursor;
      expect(JSON.stringify(body)).not.toContain('OTHER-PRIVATE');
    } while (cursor);
    expect(found.sort()).toEqual(ids.sort());
    expect((await SELF.fetch(`${BASE}${profilePath}/import-candidates`)).status).toBe(401);
    expect((await saveProfile(owner.token, { ...blank, major: 'attempt', legacyImports: [{ candidateId: foreign, fields: ['major'] }] })).status).toBe(404);
    expect((await SELF.fetch(BASE+profilePath,{headers:headers(owner.token)}).then(r=>r.json()) as any).data.revision).toBe(0);
  });

  it('atomically saves edited merged values and resets only imported publication and AI scope; conflicts do not mark candidates', async () => {
    const owner = await seedUser(); const project = await seedProject(owner.userId);
    const first = await candidate(owner.userId,project,'数学'), second = await candidate(owner.userId,project,'计算机');
    const published = { ...blank, searchable: true, aiUseAllowed: true, major: '已有资料', specialties: '已有特长', bio: '保持公开', visibility: { bio: true, major: true, specialties: true, preferredRoles: true }, weeklyAvailableHours: 9 };
    expect((await saveProfile(owner.token,published)).status).toBe(200);
    const body = { ...published, expectedRevision: 1, major: '数学与计算机，已人工整理', specialties: '写作、研究、已有特长', legacyImports: [{ candidateId:first,fields:['major','specialties'] },{candidateId:second,fields:['major']}] };
    const imported = await saveProfile(owner.token,body); expect(imported.status).toBe(200);
    expect((await imported.json() as any).data).toMatchObject({ revision:2,major:body.major,specialties:body.specialties,weeklyAvailableHours:9,searchable:true,aiUseAllowed:false,visibility:{bio:true,major:false,specialties:false,preferredRoles:true} });
    const third = await candidate(owner.userId,project,'新候选');
    expect((await saveProfile(owner.token,{...body,legacyImports:[{candidateId:third,fields:['major']}]})).status).toBe(409);
    expect((await env.DB.prepare('SELECT imported_at FROM personal_profile_import_candidates WHERE id=?1').bind(third).first())?.imported_at).toBeNull();
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM personal_profile_import_candidates WHERE id IN (?1,?2) AND imported_at IS NOT NULL').bind(first,second).first())?.n).toBe(2);
  });

  it('keeps global weekly hours out of public JSON, member APIs, export and AI dispatch even after consent', async () => {
    const owner = await seedUser(), viewer = await seedUser(); const project = await seedProject(owner.userId);
    await env.DB.prepare('UPDATE auth_accounts SET username=?2,username_norm=?2 WHERE user_id=?1').bind(owner.userId, `hour-${owner.userId.slice(0,8)}`).run();
    await saveProfile(owner.token,{...blank,searchable:true,aiUseAllowed:true,weeklyAvailableHours:17.5,major:'允许推荐的专业',visibility:{...blank.visibility,major:true}});
    for (const path of [`/api/v1/profiles/hour-${owner.userId.slice(0,8)}`,`/api/v1/projects/${project}/members`,`/api/v1/projects/${project}/export-bundle`]) {
      const response = await SELF.fetch(BASE+path,{headers:headers(path.includes('/profiles/') ? viewer.token : owner.token)});
      expect(response.status).toBe(200); expect(JSON.stringify(await response.json())).not.toContain('weeklyAvailableHours');
    }
    await configureGoFixture(); const config = (await loadAiConfig(env.DB))!;
    const context = await recommendationDispatch(env,project,owner.userId,await profileStamp(env,project),config.id);
    expect(context.preferences).toHaveLength(1); expect(context.preferences[0]?.major).toBe('允许推荐的专业');
    expect(JSON.stringify(context)).not.toContain('weekly'); expect(JSON.stringify(context)).not.toContain('17.5');
    const id = await candidate(owner.userId,project,'不用导入的专业',0);
    const own = (await SELF.fetch(BASE+profilePath,{headers:headers(owner.token)}).then(r=>r.json()) as any).data;
    const { revision, ...values } = own;
    const imported = await saveProfile(owner.token,{...values,expectedRevision:revision,weeklyAvailableHours:0,legacyImports:[{candidateId:id,fields:['weeklyAvailableHours']}]});
    expect((await imported.json() as any).data).toMatchObject({aiUseAllowed:true,weeklyAvailableHours:0});
  });
});

const app = createApp(); registerResourceRoutes(app);
function resourceRequest(path: string, token?: string, method = 'GET', body?: object) {
  return app.fetch(new Request(BASE+path,{method,headers:token?headers(token):{},...(body?{body:JSON.stringify(body)}:{})}),env);
}
async function readySource(projectId: string, userId: string, text: string, id = crypto.randomUUID()) {
  const version = crypto.randomUUID(), fragment = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sources(id,project_id,kind,title,current_version_id,created_by,created_at,updated_at) VALUES(?1,?2,'paste','原始参考',?3,?4,'2026-10-02T00:00:00.000Z','2026-10-02T00:00:00.000Z')").bind(id,projectId,version,userId),
    env.DB.prepare("INSERT INTO source_versions(id,source_id,project_id,revision,origin,char_count,status,created_at) VALUES(?1,?2,?3,1,'paste',?4,'ready','2026-10-02T00:00:00.000Z')").bind(version,id,projectId,text.length),
    env.DB.prepare("INSERT INTO source_fragments(id,source_version_id,project_id,page_number,seq,kind,content,created_at) VALUES(?1,?2,?3,1,1,'text',?4,'2026-10-02T00:00:00.000Z')").bind(fragment,version,projectId,text),
    env.DB.prepare("INSERT INTO source_processing(source_version_id,project_id,text_status,updated_at) VALUES(?1,?2,'ready','2026-10-02T00:00:00.000Z')").bind(version,projectId),
  ]);
  return { id,version,fragment };
}

describe('unified resource library and editable background', () => {
  it('initializes a background once and retains edited immutable versions when called again', async () => {
    const owner = await seedUser(), project = await seedProject(owner.userId);
    const background = (await seedBackground(project,'原始背景\n第二行',owner.userId))!;
    expect(await seedBackground(project,'不应覆盖',owner.userId)).toEqual(background);
    const note = await SELF.fetch(`${BASE}/api/v1/projects/${project}/materials/${background.materialId}`,{method:'PUT',headers:headers(owner.token),body:JSON.stringify({expectedRevision:1,doc:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'修改后的背景'}]}]}})});
    expect(note.status).toBe(201); const version = (await note.json() as any).data.versionId;
    expect(await seedBackground(project,'再次创建不可覆盖',owner.userId)).toEqual({materialId:background.materialId,versionId:version});
    expect((await loadResourceVersionText(env,project,'material',background.versionId)).text).toContain('原始背景');
    expect((await loadResourceVersionText(env,project,'material',version)).text).toBe('修改后的背景');
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM materials WHERE project_id=?1 AND is_default_background=1').bind(project).first())?.n).toBe(1);
    expect(await seedBackground(project,'  ',owner.userId)).toBeNull();
  });

  it('paginates mixed resources with same IDs and timestamps, filters purposes, and preserves source version identity', async () => {
    const owner = await seedUser(), project = await seedProject(owner.userId);
    const source = await readySource(project,owner.userId,'全文证据，不截断');
    await env.DB.prepare("INSERT INTO materials(id,project_id,title,kind,created_by,created_at,updated_at) VALUES(?1,?2,'输出资料','document',?3,'2026-10-02T00:00:00.000Z','2026-10-02T00:00:00.000Z')").bind(source.id,project,owner.userId).run();
    await seedBackground(project,'背景',owner.userId);
    let cursor: string | null = null; const found: string[] = [];
    do {
      const response = await resourceRequest(`/api/v1/projects/${project}/resource-library?limit=1${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,owner.token);
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
      const json = await response.json() as any; found.push(...json.data.items.map((r:any)=>`${r.resourceType}:${r.resourceId}`)); cursor=json.data.nextCursor;
    } while(cursor);
    expect(found).toHaveLength(3); expect(new Set(found).size).toBe(3);
    const only = await resourceRequest(`/api/v1/projects/${project}/resource-library?purpose=background`,owner.token);
    expect((await only.json() as any).data.items).toHaveLength(1);
    const path = `/api/v1/projects/${project}/resource-library/source/${source.id}`;
    const updated = await resourceRequest(path,owner.token,'PATCH',{purpose:'background',expectedRevision:1});
    expect(updated.status).toBe(200); expect((await updated.json() as any).data).toMatchObject({revision:2,currentVersionId:source.version,lifecycleVersion:1,purpose:'background'});
    expect((await resourceRequest(path,owner.token,'PATCH',{purpose:'output',expectedRevision:1})).status).toBe(409);
    const text = await loadResourceVersionText(env,project,'source',source.version);
    expect(text).toMatchObject({resourceId:source.id,text:'全文证据，不截断',sourceLifecycleVersion:1,fragments:[{fragmentId:source.fragment,content:'全文证据，不截断'}]});
  });

  it('purpose changes share the editor CAS while retaining the existing immutable material version', async () => {
    const owner=await seedUser(), project=await seedProject(owner.userId);
    const note=(await seedBackground(project,'固定旧版本',owner.userId))!;
    const path=`/api/v1/projects/${project}/resource-library/material/${note.materialId}`;
    const changed=await resourceRequest(path,owner.token,'PATCH',{purpose:'reference',expectedRevision:1});
    expect(changed.status).toBe(200); expect((await changed.json() as any).data).toMatchObject({revision:2,currentVersionId:note.versionId,purpose:'reference'});
    const doc={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'新的正文'}]}]};
    const save=(expectedRevision:number)=>SELF.fetch(`${BASE}/api/v1/projects/${project}/materials/${note.materialId}`,{method:'PUT',headers:headers(owner.token),body:JSON.stringify({expectedRevision,doc})});
    expect((await save(1)).status).toBe(409); expect((await save(2)).status).toBe(201);
    expect((await loadResourceVersionText(env,project,'material',note.versionId)).text).toBe('固定旧版本');
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM material_versions WHERE material_id=?1').bind(note.materialId).first())?.n).toBe(2);
    const fresh=await resourceRequest(path,owner.token); expect((await fresh.json() as any).data).toMatchObject({revision:3,purpose:'reference'});
  });

  it('enforces membership, source metadata permissions, recycle visibility and complete-text readiness', async () => {
    const owner = await seedUser(), member = await seedUser(), outside = await seedUser();
    const project = await seedProject(owner.userId), foreignProject = await seedProject(outside.userId);
    await env.DB.prepare("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES(?1,?2,?3,'member','2026-10-02')").bind(crypto.randomUUID(),project,member.userId).run();
    const source=await readySource(project,owner.userId,'完整正文'), foreign=await readySource(foreignProject,outside.userId,'别人的正文');
    const path=`/api/v1/projects/${project}/resource-library/source/${source.id}`;
    expect((await resourceRequest(path,member.token,'PATCH',{purpose:'background',expectedRevision:1})).status).toBe(403);
    expect((await resourceRequest(path,outside.token)).status).toBe(403); expect((await resourceRequest(path)).status).toBe(401);
    await expect(loadResourceVersionText(env,project,'source',foreign.version)).rejects.toThrow();
    await env.DB.prepare("UPDATE source_processing SET text_status='processing' WHERE source_version_id=?1").bind(source.version).run();
    await expect(loadResourceVersionText(env,project,'source',source.version)).rejects.toThrow('正文尚未完整就绪');
    const deleted=await SELF.fetch(`${BASE}/api/v1/projects/${project}/sources/${source.id}`,{method:'DELETE',headers:headers(owner.token),body:JSON.stringify({expectedLifecycleVersion:1})});
    expect(deleted.status).toBe(200);
    const active=await resourceRequest(`/api/v1/projects/${project}/resource-library`,owner.token); expect((await active.json() as any).data.items).toHaveLength(0);
    const recycled=await resourceRequest(`/api/v1/projects/${project}/resource-library?deleted=true`,owner.token); expect((await recycled.json() as any).data.items).toHaveLength(1);
    expect((await resourceRequest(path,owner.token,'PATCH',{purpose:'output',expectedRevision:1})).status).toBe(404);
    await expect(loadResourceVersionText(env,project,'source',source.version)).rejects.toThrow();
    const restored=await SELF.fetch(`${BASE}/api/v1/projects/${project}/sources/${source.id}/restore`,{method:'POST',headers:headers(owner.token),body:JSON.stringify({expectedLifecycleVersion:2})});
    expect(restored.status).toBe(200);
    expect((await resourceRequest(path,owner.token,'PATCH',{purpose:'output',expectedRevision:1})).status).toBe(409);
    const fresh=await resourceRequest(path,owner.token); expect((await fresh.json() as any).data).toMatchObject({revision:3,lifecycleVersion:3,purpose:'reference'});
  });
});
