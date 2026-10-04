import { expect, it } from 'vitest';
import { createApp } from '../src/app';
import { env, BASE } from './helpers/env';
import { seedUser, seedProject, authCookie } from './helpers/seed';
import { configureGoFixture } from './helpers/provider-config';
import { newId, nowIso } from '../src/core/db';
import { failJob } from '../src/services/jobs';
import { settleReservation } from '../src/services/budget';
import { retryFailedAiJob } from '../src/services/admin-ai-retries';
import { recoverAutomaticAiRetries } from '../src/services/ai-automatic-retries';
import { AppError } from '../src/core/errors';

it('follows replacement requests and stops the whole chain after three failed recovery rounds', async () => {
  await configureGoFixture();
  const owner = await seedUser(), projectId = await seedProject(owner.userId), originalId = newId();
  const config = await env.DB.prepare('SELECT id FROM ai_config_versions ORDER BY version DESC LIMIT 1').first<{id:string}>();
  await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_by,created_at,updated_at) VALUES(?1,?2,'agent_run','running',?3,?4,?5,?5)")
    .bind(originalId, projectId, JSON.stringify({ projectId, requestedBy: owner.userId, configVersionId: config!.id }), owner.userId, nowIso()).run();
  await failJob(env, originalId, { code: 'AI_UNAVAILABLE', message: 'network timeout' });
  const read = async () => {
    const response = await createApp().fetch(new Request(`${BASE}/api/v1/jobs/${originalId}`, { headers: { cookie: authCookie(owner.token) } }), env);
    expect(response.status).toBe(200);
    return (await response.json() as {data:{jobId:string;status:string;retry:{attempts:number;status:string;nextAttemptAt:string}}}).data;
  };
  const first = await read();
  expect(first.status).toBe('queued');
  expect(Date.parse(first.retry.nextAttemptAt) - Date.now()).toBeGreaterThan(55_000);
  expect(await recoverAutomaticAiRetries(env, (e, id, root) => retryFailedAiJob(e, id, undefined, root))).toBe(0);
  let currentId = originalId;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await env.DB.prepare("UPDATE ai_automatic_retries SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE id=?1").bind(`job:${originalId}`).run();
    expect(await recoverAutomaticAiRetries(env, (e, id, root) => retryFailedAiJob(e, id, undefined, root))).toBe(1);
    const queued = await read();
    expect(queued.jobId).not.toBe(currentId);
    currentId = queued.jobId;
    await settleReservation(env, currentId, 'released');
    await failJob(env, currentId, { code: 'AI_UNAVAILABLE', message: 'provider fallback exhausted' });
    const failed = await read();
    expect(failed.retry.attempts).toBe(attempt);
    expect(failed.status).toBe(attempt === 3 ? 'failed' : 'queued');
  }
  expect((await read()).retry.status).toBe('exhausted');
  expect(await recoverAutomaticAiRetries(env, (e, id, root) => retryFailedAiJob(e, id, undefined, root))).toBe(0);
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM admin_ai_retry_links').first<{n:number}>())!.n).toBe(3);
});

it('does not spend a recovery round while waiting for project concurrency', async () => {
  const id=newId(),now=nowIso();
  await env.DB.prepare("INSERT INTO ai_automatic_retries(id,target_kind,target_id,status,next_attempt_at,created_at,updated_at) VALUES(?1,'job',?2,'pending','2000-01-01',?3,?3)").bind(`job:${id}`,id,now).run();
  expect(await recoverAutomaticAiRetries(env, async () => { throw new AppError('QUOTA_EXCEEDED','busy',429,false,{limit:2}); })).toBe(0);
  const row=await env.DB.prepare('SELECT status,attempts FROM ai_automatic_retries WHERE id=?1').bind(`job:${id}`).first<{status:string;attempts:number}>();
  expect(row).toMatchObject({status:'pending',attempts:0});
});

it('retries failed source analysis while an independent summary of the same source is running', async () => {
  await configureGoFixture();
  const owner=await seedUser(), projectId=await seedProject(owner.userId), sourceId=newId(), versionId=newId(), id=newId(), now=nowIso();
  const config=await env.DB.prepare('SELECT id FROM ai_config_versions ORDER BY version DESC LIMIT 1').first<{id:string}>();
  await env.DB.prepare("INSERT INTO sources(id,project_id,kind,title,created_by,created_at,updated_at) VALUES(?1,?2,'paste','source',?3,?4,?4)").bind(sourceId,projectId,owner.userId,now).run();
  await env.DB.prepare("INSERT INTO source_versions(id,source_id,project_id,revision,origin,status,created_at) VALUES(?1,?2,?3,1,'paste','failed',?4)").bind(versionId,sourceId,projectId,now).run();
  await env.DB.prepare('UPDATE sources SET current_version_id=?2 WHERE id=?1').bind(sourceId,versionId).run();
  const input={projectId,sourceId,sourceVersionId:versionId,sourceLifecycleVersion:1,phase:'extract',configVersionId:config!.id};
  for(const [jobId,status,operation] of [[id,'failed','source.analyze'],[newId(),'running','source.summary']]){
    await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_by,created_at,updated_at) VALUES(?1,?2,'parse_source',?3,?4,?5,?6,?6)").bind(jobId,projectId,status,JSON.stringify({...input,operation}),owner.userId,now).run();
  }
  expect((await retryFailedAiJob(env,id)).status).toBe('queued');
});
