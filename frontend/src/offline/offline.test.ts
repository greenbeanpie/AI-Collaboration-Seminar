import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingOperation } from './store';
const state = vi.hoisted(() => ({ account: { id: 'account-a', displayName: '成员' }, rows: [] as PendingOperation[], cached: new Map<string, unknown>() }));
vi.mock('./store', async (original) => ({ ...await original<typeof import('./store')>(),
  offlineAccount: () => state.account,
  operations: async () => state.rows.filter(row => row.accountId === state.account.id),
  snapshots: async () => [...state.cached].map(([url, data]) => ({ url, data })),
  readSnapshot: async (url: string) => state.cached.has(url) ? { data: state.cached.get(url) } : undefined,
  writeSnapshot: vi.fn(),
  putOperation: async (row: PendingOperation) => { state.rows = [...state.rows.filter(item => item.key !== row.key), row]; },
  removeOperation: async (key: string) => { state.rows = state.rows.filter(row => row.key !== key); },
}));
import { cacheable, offlineView, offlineWritable, queueOffline } from './queue';
import { mergeUnchangedFields } from './sync';

beforeEach(() => { state.rows = []; state.cached.clear(); state.account.id = 'account-a'; state.cached.set('/api/v1/projects/project-a', { id: 'project-a' }); });
describe('offline intents and conflict handling', () => {
  it('persists intent, overlays the correct project and isolates accounts', async () => {
    const created = await queueOffline('/api/v1/projects/project-a/tasks', 'POST', { title: '本机任务' }, 'one-intent') as { taskId: string };
    expect(state.rows).toHaveLength(1);
    expect(await queueOffline('/api/v1/projects/project-a/tasks', 'POST', { title: '本机任务' }, 'one-intent')).toMatchObject({ taskId: created.taskId });
    expect(await offlineView('/api/v1/projects/project-a/tasks', { items: [] })).toMatchObject({ items: [{ title: '本机任务' }] });
    expect(await offlineView('/api/v1/projects/project-b/tasks', { items: [] })).toEqual({ items: [] });
    state.account.id = 'account-b'; expect(await offlineView('/api/v1/projects/project-a/tasks', { items: [] })).toEqual({ items: [] });
  });
  it('only merges fields that were unchanged on the server', () => {
    expect(mergeUnchangedFields({ title: 'old', detail: 'base', revision: 1 }, { title: 'old', detail: 'teammate', revision: 2 }, { title: 'mine', expectedRevision: 1 })).toEqual({ title: 'mine', expectedRevision: 2 });
    expect(mergeUnchangedFields({ title: 'old', revision: 1 }, { title: 'teammate', revision: 2 }, { title: 'mine', expectedRevision: 1 })).toBeNull();
  });
  it('never queues AI execution, approval or administrator writes', async () => {
    for (const tail of ['collaboration/decompose', 'collaboration/proposals/x/apply', 'invitations', 'assessments/manual']) {
      expect(offlineWritable(`/api/v1/projects/project-a/${tail}`, 'POST')).toBe(false);
      await expect(queueOffline(`/api/v1/projects/project-a/${tail}`, 'POST', {})).rejects.toThrow('联网');
    }
    expect(cacheable('/api/v1/admin/ai-config')).toBe(false);
    expect(cacheable('/api/v1/auth/session')).toBe(true);
  });
  it('supports the actual public claim and submission aliases and remaps material versions', async () => {
    expect(offlineWritable('/api/v1/projects/project-a/tasks/task-a/claim', 'POST')).toBe(true);
    expect(offlineWritable('/api/v1/projects/project-a/tasks/task-a/submissions', 'POST')).toBe(true);
    state.cached.set('/api/v1/projects/project-a/materials/material-a', { materialId: 'material-a', revision: 1, currentVersion: { attachments: [] } });
    const saved = await queueOffline('/api/v1/projects/project-a/materials/material-a', 'PUT', { expectedRevision: 1, doc: { type: 'doc', content: [] }, markdown: 'local' }) as { versionId: string };
    expect(saved.versionId).toBeTruthy();
    await queueOffline('/api/v1/projects/project-a/tasks/task-a/submissions', 'POST', { expectedRevision: 1, body: 'draft', materialVersionIds: [saved.versionId] });
    const { replaceLocalIds } = await import('./queue');
    await replaceLocalIds('account-a', saved.versionId, 'server-version');
    expect(state.rows.find(row => row.url.endsWith('/submissions'))?.body.materialVersionIds).toEqual(['server-version']);
  });
  it('replaces local IDs structurally in URLs and reference fields without corrupting user text payloads', async () => {
    const taskA = await queueOffline('/api/v1/projects/project-a/tasks', 'POST', { title: '前置任务 A' }) as { taskId: string };
    const localId = taskA.taskId;
    await queueOffline(`/api/v1/projects/project-a/tasks/${localId}`, 'PATCH', {
      expectedRevision: 1,
      title: `标题提到 ${localId} 不应被改写`,
      detail: `详情包含本地ID ${localId} 原样保留`,
      criteria: `验收标准 ${localId}`,
    });
    await queueOffline('/api/v1/projects/project-a/tasks', 'POST', {
      title: `下游任务引用 ${localId}`,
      detail: `正文含 ${localId}`,
      dependsOnTaskIds: [localId, 'other-task-id'],
    });
    await queueOffline('/api/v1/projects/project-a/comments', 'POST', {
      targetType: 'task',
      targetId: localId,
      body: `评论内容提到 ${localId} 保持不变`,
    });
    await queueOffline(`/api/v1/projects/project-a/tasks/${localId}/submissions`, 'POST', {
      expectedRevision: 1,
      body: `提交说明包含 ${localId}`,
      materialVersionIds: [localId],
    });
    const { replaceLocalIds } = await import('./queue');
    await replaceLocalIds('account-a', localId, 'server-task-uuid');
    const patchOp = state.rows.find(row => row.method === 'PATCH');
    expect(patchOp?.url).toBe('/api/v1/projects/project-a/tasks/server-task-uuid');
    expect(patchOp?.body).toMatchObject({
      title: `标题提到 ${localId} 不应被改写`,
      detail: `详情包含本地ID ${localId} 原样保留`,
      criteria: `验收标准 ${localId}`,
    });
    const downstreamOp = state.rows.find(row => row.method === 'POST' && row.url.endsWith('/tasks') && row.key !== state.rows[0]!.key);
    expect(downstreamOp?.body.dependsOnTaskIds).toEqual(['server-task-uuid', 'other-task-id']);
    expect(downstreamOp?.body.title).toBe(`下游任务引用 ${localId}`);
    expect(downstreamOp?.body.detail).toBe(`正文含 ${localId}`);
    const commentOp = state.rows.find(row => row.url.endsWith('/comments'));
    expect(commentOp?.body.targetId).toBe('server-task-uuid');
    expect(commentOp?.body.body).toBe(`评论内容提到 ${localId} 保持不变`);
    const submissionOp = state.rows.find(row => row.url.endsWith('/submissions'));
    expect(submissionOp?.url).toBe('/api/v1/projects/project-a/tasks/server-task-uuid/submissions');
    expect(submissionOp?.body.materialVersionIds).toEqual(['server-task-uuid']);
    expect(submissionOp?.body.body).toBe(`提交说明包含 ${localId}`);
  });
});
