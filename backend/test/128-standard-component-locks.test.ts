import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { env, BASE } from './helpers/env';
import { seedProject, seedUser, authCookie } from './helpers/seed';
import { newId, nowIso } from '../src/core/db';
import { saveStandard } from '../src/services/project-simplification';
import type { Env } from '../src/env';

async function fixture() {
  const user = await seedUser(), projectId = await seedProject(user.userId), setId = newId(), requirementId = newId(), rubricId = newId(), now = nowIso();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO requirement_sets(id,project_id,status,revision,created_at,updated_at) VALUES(?1,?2,'draft',1,?3,?3)").bind(setId, projectId, now),
    env.DB.prepare("INSERT INTO requirements(id,project_id,requirement_set_id,seq,title,detail,category,field_state,updated_at) VALUES(?1,?2,?3,1,'Original requirement','Original evidence','deliverable','ai_suggestion',?4)").bind(requirementId, projectId, setId, now),
    env.DB.prepare("INSERT INTO rubric_versions(id,project_id,version,source,weights_json,notes,status,created_at) VALUES(?1,?2,1,'custom',?3,'Original rules','draft',?4)").bind(rubricId, projectId, JSON.stringify([{ key: 'q', label: 'Quality', weight: 100 }]), now),
  ]);
  return { user, projectId, setId, requirementId, rubricId, save: () => saveStandard(env, projectId, user.userId, { title: 'Saved active standard', requirementSetIds: [setId], rubricVersionId: rubricId }) };
}

/** Publish a standard after the legacy editor's read, before its write. */
function publishAfterRead(fragment: string, publish: () => Promise<unknown>): Env {
  let injected = false;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(target, key) {
    if (key === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
    if (key === 'first') return async (...args: unknown[]) => {
      const row = await target.first(...args as [string]);
      if (!injected) { injected = true; await publish(); }
      return row;
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const database = new Proxy(env.DB, { get(target, key) {
    if (key === 'prepare') return (sql: string) => sql.includes(fragment) ? wrap(target.prepare(sql)) : target.prepare(sql);
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { ...env, DB: database };
}

describe('saved project standard component locks', () => {
  it('a concurrently saved standard prevents a legacy requirement edit and false change notification', async () => {
    const f = await fixture();
    const response = await createApp().fetch(new Request(`${BASE}/api/v1/projects/${f.projectId}/requirements/${f.requirementId}`, { method: 'PATCH', headers: { cookie: authCookie(f.user.token), 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Stale edit' }) }), publishAfterRead('SELECT r.*, s.status AS set_status', f.save));
    expect(response.status).toBe(409);
    expect(await env.DB.prepare('SELECT title FROM requirements WHERE id=?1').bind(f.requirementId).first()).toEqual({ title: 'Original requirement' });
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM notification_events WHERE resource_id=?1 AND kind='requirement_changed'").bind(f.projectId).first<{ n: number }>())?.n).toBe(0);
  });
  it('a concurrently saved standard prevents a legacy rubric edit', async () => {
    const f = await fixture();
    const response = await createApp().fetch(new Request(`${BASE}/api/v1/projects/${f.projectId}/rubrics/${f.rubricId}`, { method: 'PATCH', headers: { cookie: authCookie(f.user.token), 'content-type': 'application/json' }, body: JSON.stringify({ notes: 'Stale rules' }) }), publishAfterRead('SELECT * FROM rubric_versions WHERE id = ?1 AND project_id = ?2', f.save));
    expect(response.status).toBe(409);
    expect(await env.DB.prepare('SELECT notes FROM rubric_versions WHERE id=?1').bind(f.rubricId).first()).toEqual({ notes: 'Original rules' });
  });
});
