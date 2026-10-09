import { expect, it } from 'vitest';
import { createApp } from '../src/app';
import { newId, nowIso } from '../src/core/db';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';

async function fixture() {
  const owner = await seedUser();
  const projectId = await seedProject(owner.userId);
  const jobId = newId();
  await insertJob(jobId, projectId, owner.userId);
  return { owner, projectId, jobId };
}

async function insertJob(jobId: string, projectId: string, userId: string) {
  await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_by,created_at,updated_at) VALUES(?1,?2,'agent_run','succeeded','{}',?3,?4,?4)")
    .bind(jobId, projectId, userId, nowIso()).run();
}

function measuredEnv() {
  const queries: string[] = [];
  const DB = new Proxy(env.DB, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => {
        queries.push(sql);
        return target.prepare(sql);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { local: { ...env, DB }, queries };
}

it.each(['', '/activity-events'])('reads and authorizes an unchanged job once for %s', async suffix => {
  const state = await fixture();
  const measured = measuredEnv();
  const response = await createApp().request(`${BASE}/api/v1/jobs/${state.jobId}${suffix}`, {
    headers: { cookie: authCookie(state.owner.token) },
  }, measured.local);
  expect(response.status).toBe(200);
  await response.text();
  expect(measured.queries.filter(sql => sql.includes('finished_at, created_by FROM jobs WHERE id = ?1'))).toHaveLength(1);
  expect(measured.queries.filter(sql => sql === 'SELECT 1 FROM project_members WHERE project_id=?1 AND user_id=?2')).toHaveLength(1);
});

it.each(['', '/activity-events'])('still authorizes a different successor for %s', async suffix => {
  const state = await fixture();
  const other = await seedUser();
  const foreignProject = await seedProject(other.userId);
  const successor = newId();
  await insertJob(successor, foreignProject, other.userId);
  await env.DB.prepare('INSERT INTO admin_ai_retry_links VALUES(?1,?2,?3)').bind(state.jobId, successor, nowIso()).run();
  const measured = measuredEnv();
  const response = await createApp().request(`${BASE}/api/v1/jobs/${state.jobId}${suffix}`, {
    headers: { cookie: authCookie(state.owner.token) },
  }, measured.local);
  expect(response.status).toBe(403);
  await response.text();
  expect(measured.queries.filter(sql => sql.includes('finished_at, created_by FROM jobs WHERE id = ?1'))).toHaveLength(2);
});

it('rechecks membership on the next request after revocation', async () => {
  const state = await fixture();
  const request = () => createApp().request(`${BASE}/api/v1/jobs/${state.jobId}`, {
    headers: { cookie: authCookie(state.owner.token) },
  }, env);
  const first = await request();
  expect(first.status).toBe(200);
  await first.text();
  await env.DB.prepare('DELETE FROM project_members WHERE project_id=?1 AND user_id=?2').bind(state.projectId, state.owner.userId).run();
  const revoked = await request();
  expect(revoked.status).toBe(403);
  await revoked.text();
});
