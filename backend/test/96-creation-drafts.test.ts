import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { seedUser, authCookie } from './helpers/seed';
import { newId } from '../src/core/db';
import { configureGoFixture, assertGoRequest } from './helpers/provider-config';
const req = (token: string, path: string, body?: unknown, method = body ? 'POST' : 'GET', key = newId()) => SELF.fetch(BASE + '/api/v1/creation-drafts' + path, {
  method, headers: {
    cookie: authCookie(token), 'content-type': 'application/json', 'idempotency-key': key
  }, ...(body ? {
    body: JSON.stringify(body)
  } : {})
});
const data = async (r: Response) => (await r.json() as {
  data: any;
}).data;
const payload = {
  name: '分步项目', teamSize: 3, inviteLabels: ['组员甲', '组员乙'], aiCollaborationEnabled: true, description: '', brief: '生成可验收的计划'
};
const task = {
  title: '验证交付', detail: '依据资料执行', criteria: '交付报告', effortHours: 2, citations: []
};
afterEach(() => vi.unstubAllGlobals());
describe('private creation drafts', () => {
  it('stages bytes privately, cancels/restores, imports all entities once, and only then activates invitations', async () => {
    const owner = await seedUser(), stranger = await seedUser(), key = newId();
    const first = await req(owner.token, '', payload, 'POST', key), draft = await data(first);
    expect(first.status).toBe(201);
    expect((await data(await req(owner.token, '', payload, 'POST', key))).id).toBe(draft.id);
    expect((await req(stranger.token, '/' + draft.id)).status).toBe(404);
    const fileId = newId(), bytes = new TextEncoder().encode('必须交付研究报告。');
    const put = () => SELF.fetch(BASE + `/api/v1/creation-drafts/${draft.id}/files/${fileId}?expectedRevision=1&name=brief.txt`, {
      method: 'PUT', headers: {
        cookie: authCookie(owner.token)
      }, body: bytes
    });
    const uploaded = await data(await put());
    expect(uploaded.revision).toBe(2);
    expect(uploaded.files[0].textReady).toBe(true);
    expect((await put()).status).toBe(200);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM projects').first<{
      n: number;
    }>())?.n).toBe(0);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM invitations').first<{
      n: number;
    }>())?.n).toBe(0);
    expect((await req(owner.token, `/${draft.id}/commit`, {
      expectedRevision: 2, confirmed: true
    })).status).toBe(409);
    const cancelled = await data(await req(owner.token, `/${draft.id}/state`, {
      expectedRevision: 2, status: 'cancelled'
    }));
    expect(cancelled.status).toBe('cancelled');
    expect(await env.FILES.get(`creation-drafts/${draft.id}/${fileId}.txt`)).not.toBeNull();
    const restored = await data(await req(owner.token, `/${draft.id}/state`, {
      expectedRevision: 3, status: 'active'
    }));
    expect(restored.files).toHaveLength(1);
    expect((await req(owner.token, `/${draft.id}/preview`, {
      expectedRevision: 4, mode: 'manual', tasks: [task]
    })).status).toBe(200);
    const created = await data(await req(owner.token, `/${draft.id}/commit`, {
      expectedRevision: 4, confirmed: true
    }));
    expect(created.invitations).toHaveLength(2);
    expect(await env.DB.prepare('SELECT lifecycle_version,deleted_at FROM files WHERE id=?1').bind(fileId).first()).toEqual({lifecycle_version:1,deleted_at:null});
    expect(await env.DB.prepare('SELECT lifecycle_version,deleted_at FROM sources WHERE project_id=?1').bind(created.projectId).first()).toEqual({lifecycle_version:1,deleted_at:null});
    const replay = await data(await req(owner.token, `/${draft.id}/commit`, {
      expectedRevision: 4, confirmed: true
    }));
    expect(replay).toEqual(created);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM projects').first<{
      n: number;
    }>())?.n).toBe(1);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM tasks').first<{
      n: number;
    }>())?.n).toBe(1);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM source_fragments').first<{
      n: number;
    }>())?.n).toBe(1);
    expect((await req(stranger.token, `/${draft.id}/commit`, {
      expectedRevision: 4, confirmed: true
    })).status).toBe(404);
  });
  it('configuration versions invalidate preview, and invitation counts are checked', async () => {
    const owner = await seedUser();
    expect((await req(owner.token, '', {
      ...payload, teamSize: 1
    })).status).toBe(400);
    const draft = await data(await req(owner.token, '', payload));
    await req(owner.token, `/${draft.id}/preview`, {
      expectedRevision: 1, mode: 'manual', tasks: [task]
    });
    const update = await req(owner.token, `/${draft.id}`, {
      expectedRevision: 1, payload: {
        ...payload, name: '新版本'
      }
    }, 'PATCH');
    expect(update.status).toBe(200);
    expect((await req(owner.token, `/${draft.id}/commit`, {
      expectedRevision: 2, confirmed: true
    })).status).toBe(409);
  });
  it('AI preview uses draft inputs, records usage without a project, and confirmation does not call the model again', async () => {
    await configureGoFixture();
    const owner = await seedUser(), draft = await data(await req(owner.token, '', payload));
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      assertGoRequest(url, init);
      return Response.json({
        choices: [{
            message: {
              content: JSON.stringify({
                tasks: [task]
              })
            }
          }], usage: {
          prompt_tokens: 30, completion_tokens: 25
        }
      });
    });
    vi.stubGlobal('fetch', fetch);
    const preview = await req(owner.token, `/${draft.id}/preview`, {
      expectedRevision: 1, mode: 'ai'
    });
    expect(preview.status).toBe(200);
    expect((await env.DB.prepare('SELECT project_id,draft_id FROM ai_calls').first())).toEqual({
      project_id: null, draft_id: draft.id
    });
    await req(owner.token, `/${draft.id}/preview`, {
      expectedRevision: 1, mode: 'ai'
    });
    const created = await data(await req(owner.token, `/${draft.id}/commit`, {
      expectedRevision: 1, confirmed: true
    }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await env.DB.prepare('SELECT project_id FROM ai_calls').first<{
      project_id: string;
    }>())?.project_id).toBe(created.projectId);
  });
  it('can restore removed staged files and rejects made-up citations before final creation', async () => {
    const owner = await seedUser(), draft = await data(await req(owner.token, '', payload)), fileId = newId();
    await SELF.fetch(BASE + `/api/v1/creation-drafts/${draft.id}/files/${fileId}?expectedRevision=1&name=notes.txt`, {
      method: 'PUT', headers: {
        cookie: authCookie(owner.token)
      }, body: '实际原文'
    });
    const removed = await data(await req(owner.token, `/${draft.id}/files/${fileId}/state`, {
      expectedRevision: 2, removed: true
    }));
    expect(removed.files).toHaveLength(0);
    expect(removed.removedFiles[0].id).toBe(fileId);
    const restored = await data(await req(owner.token, `/${draft.id}/files/${fileId}/state`, {
      expectedRevision: 3, removed: false
    }));
    expect(restored.files[0].id).toBe(fileId);
    expect((await req(owner.token, `/${draft.id}/preview`, {
      expectedRevision: 4, mode: 'manual', tasks: [{
          ...task, citations: [{
              fileId, pageNumber: 1, quote: '不存在的引用'
            }]
        }]
    })).status).toBe(409);
    expect((await req(owner.token, `/${draft.id}/preview`, {
      expectedRevision: 4, mode: 'manual', regenerate: true, tasks: [{
          ...task, citations: [{
              fileId, pageNumber: 1, quote: '实际原文'
            }]
        }]
    })).status).toBe(200);
  });
  it('atomic commit rollback preserves a recoverable draft when a task insert fails', async () => {
    const owner = await seedUser(), draft = await data(await req(owner.token, '', payload));
    await req(owner.token, `/${draft.id}/preview`, {
      expectedRevision: 1, mode: 'manual', tasks: [task]
    });
    await env.DB.exec("CREATE TRIGGER fail_task BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
    expect((await req(owner.token, `/${draft.id}/commit`, {
      expectedRevision: 1, confirmed: true
    })).status).toBe(500);
    expect((await data(await req(owner.token, '/' + draft.id))).status).toBe('active');
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM projects WHERE created_by=?1').bind(owner.userId).first<{
      n: number;
    }>())?.n).toBe(0);
  });
});
