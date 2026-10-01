import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { newId, nowIso } from '../src/core/db';

const init = (token: string, projectId: string, key: string, fileName = 'project.txt') => SELF.fetch(`${BASE}/api/v1/projects/${projectId}/files`, { method: 'POST', headers: { cookie: authCookie(token), 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ fileName, contentType: 'text/plain' }) });
describe('recoverable project file initialization', () => {
  it('replays the same intent without duplicate pending files and binds payload/project scope', async () => {
    const owner = await seedUser();
    const projectId = await seedProject(owner.userId);
    const another = await seedProject(owner.userId);
    const key = newId();
    const first = await init(owner.token, projectId, key);
    const file = (await first.json() as { data: { fileId: string; upload: { url: string } } }).data;
    expect(first.status).toBe(201);
    const replay = await init(owner.token, projectId, key);
    expect(replay.status).toBe(201);
    expect((await replay.json() as { data: unknown }).data).toEqual(file);
    expect(file.upload.url).toBe(`/api/v1/projects/${projectId}/files/${file.fileId}/content`);
    expect((await init(owner.token, projectId, key, 'different.txt')).status).toBe(409);
    expect((await init(owner.token, another, key)).status).toBe(409);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM files WHERE project_id IN (?1,?2)').bind(projectId, another).first<{ n: number }>())?.n).toBe(1);
  });
  it('rechecks current membership before replay and isolates actor keys', async () => {
    const owner = await seedUser();
    const member = await seedUser();
    const outsider = await seedUser();
    const projectId = await seedProject(owner.userId);
    await env.DB.prepare("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES(?1,?2,?3,'member',?4)").bind(newId(), projectId, member.userId, nowIso()).run();
    const key = newId();
    const own = await init(owner.token, projectId, key);
    const ownId = (await own.json() as { data: { fileId: string } }).data.fileId;
    const peer = await init(member.token, projectId, key);
    const peerId = (await peer.json() as { data: { fileId: string } }).data.fileId;
    expect(ownId).not.toBe(peerId);
    expect((await init(outsider.token, projectId, key)).status).toBe(403);
    await env.DB.prepare('DELETE FROM project_members WHERE project_id=?1 AND user_id=?2').bind(projectId, member.userId).run();
    expect((await init(member.token, projectId, key)).status).toBe(403);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM files WHERE project_id=?1').bind(projectId).first<{ n: number }>())?.n).toBe(2);
  });
  it('simultaneous repeated intent creates at most one pending file', async () => {
    const owner = await seedUser();
    const projectId = await seedProject(owner.userId);
    const key = newId();
    const results = await Promise.all([init(owner.token, projectId, key), init(owner.token, projectId, key)]);
    expect(results.every(response => response.status === 201 || response.status === 409)).toBe(true);
    expect(results.some(response => response.status === 201)).toBe(true);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM files WHERE project_id=?1').bind(projectId).first<{ n: number }>())?.n).toBe(1);
    expect((await init(owner.token, projectId, key)).status).toBe(201);
  });
});
