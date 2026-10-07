import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { env, BASE } from './helpers/env';
import { seedUser, seedProject, authCookie } from './helpers/seed';

async function fixture() {
  const owner = await seedUser(), member = await seedUser(), outsider = await seedUser();
  const projectId = await seedProject(owner.userId), now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES(?1,?2,?3,'member',?4)").bind(crypto.randomUUID(),projectId,member.userId,now).run();
  const request = (path: string, method = 'GET', body?: unknown, actor = owner) => SELF.fetch(`${BASE}/api/v1/projects/${projectId}/${path}`, { method, headers: { cookie: authCookie(actor.token), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const init = await request('files','POST',{fileName:'报告.txt'});
  const fileId = (await init.json() as {data:{fileId:string}}).data.fileId;
  const upload = await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/files/${fileId}/content`, { method:'PUT', headers:{cookie:authCookie(owner.token)}, body:'可核对的成果原文，包含采访与调查记录。' });
  expect(upload.status).toBe(201);
  return {owner,member,outsider,projectId,fileId,request};
}

describe('文件处理公共接口', () => {
  it('keeps disabled-AI upload intact and exposes a manual text action to its uploader', async () => {
    const f = await fixture();
    const response = await f.request(`files/${f.fileId}/processing`);
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toContain('no-store');
    const state = (await response.json() as {data:Record<string,unknown>}).data;
    expect(state).toMatchObject({fileId:f.fileId,lifecycleVersion:1,canProcess:true,textAvailable:false,jobId:null});
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM jobs WHERE project_id=?1').bind(f.projectId).first<{n:number}>()).toMatchObject({n:0});
    const original = await f.request(`files/${f.fileId}/content`);
    expect(await original.text()).toBe('可核对的成果原文，包含采访与调查记录。');
  });

  it('rejects stale file lifecycles and users who can read but cannot manage the file', async () => {
    const f = await fixture();
    expect((await f.request(`files/${f.fileId}/processing`,'POST',{expectedLifecycleVersion:2})).status).toBe(409);
    const read = await f.request(`files/${f.fileId}/processing`,'GET',undefined,f.member);
    expect(read.status).toBe(200);
    expect((await read.json() as {data:{canProcess:boolean}}).data.canProcess).toBe(false);
    expect((await f.request(`files/${f.fileId}/processing`,'POST',{expectedLifecycleVersion:1},f.member)).status).toBe(403);
    expect((await f.request(`files/${f.fileId}/processing`,'GET',undefined,f.outsider)).status).toBe(403);
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM jobs WHERE project_id=?1').bind(f.projectId).first<{n:number}>()).toMatchObject({n:0});
  });

  it('rejects invalid start payloads before creating a task', async () => {
    const f = await fixture();
    expect((await f.request(`files/${f.fileId}/processing`,'POST',{})).status).toBe(400);
    expect((await f.request(`files/${f.fileId}/processing`,'POST',{expectedLifecycleVersion:1,ignorePermissions:true})).status).toBe(400);
  });
});
