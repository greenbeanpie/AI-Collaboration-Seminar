import { offlineAccount, operations, putOperation, readSnapshot, snapshots, writeSnapshot, type PendingOperation } from './store';

export function offlineWritable(url: string, method: string): boolean {
  const tail = new URL(url, window.location.origin).pathname.match(/^\/api\/v1\/projects\/[^/]+\/(.+)$/)?.[1];
  if (!tail) return false;
  return (method === 'PUT' && /^materials\/[^/]+$/.test(tail))
    || (method === 'PATCH' && /^(?:collaboration\/)?tasks\/[^/]+$/.test(tail))
    || (method === 'POST' && /^(?:tasks|comments|collaboration\/tasks|(?:collaboration\/)?tasks\/[^/]+\/(?:claim|submissions))$/.test(tail));
}
export function cacheable(url: string): boolean {
  const path = new URL(url, window.location.origin).pathname;
  return path === '/api/v1/auth/session' || path === '/api/v1/capabilities' || path === '/api/v1/projects'
    || /^\/api\/v1\/projects\/[^/]+(?:$|\/(?:tasks|materials|members|comments|goal|standards|sources|resource-library|requirement-sets|collaboration\/(?:settings|feedback|tasks))(?:\/|$))/.test(path);
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}
export function optimisticResult(operation: PendingOperation, base: unknown): Record<string, unknown> {
  const row = record(base), body = operation.body;
  const now = operation.createdAt;
  if (operation.url.includes('/comments')) return { ...body, commentId: operation.localId, authorId: operation.accountId, authorName: offlineAccount()?.displayName ?? '我', createdAt: now, offlinePending: true };
  if (operation.url.includes('/materials/')) return { versionId: operation.localId, materialId: row.materialId, revision: Number(body.expectedRevision) + 1, doc: body.doc, markdown: body.markdown, attachments: record(row.currentVersion).attachments ?? [], authorId: operation.accountId, origin: 'manual', createdAt: now, offlinePending: true };
  if (operation.url.endsWith('/submissions')) return { submissionId: operation.localId, taskId: row.taskId, round: 1, criteria: row.criteria, submittedBy: operation.accountId, decision: null, aiDecision: null, status: 'pending', revision: 1, ...body, createdAt: now, updatedAt: now, offlinePending: true };
  const created = operation.method === 'POST' && /\/tasks$/.test(operation.url);
  return { ...row, ...(created ? { taskId: operation.localId, projectId: operation.projectId, assigneeId: null, status: 'todo', lifecycleState: 'open', currentSubmissionId: null, dueDate: null, duePrecision: 'unknown', createdAt: now, dependsOnTaskIds: [], unfinishedDependencyIds: [] } : {}), ...body,
    ...(operation.url.endsWith('/claim') ? { assigneeId: operation.accountId, status: 'doing', lifecycleState: 'in_progress' } : {}),
    revision: created ? 1 : Number(body.expectedRevision ?? row.revision ?? 0) + 1, updatedAt: now, offlinePending: true };
}
export async function operationBase(url: string, projectId: string): Promise<unknown> {
  const match = url.match(/\/(?:collaboration\/)?tasks\/([^/]+)/);
  if (match) {
    const local = (await operations()).find(operation => operation.localId === match[1]);
    if (local) return optimisticResult(local, local.base);
    const detail = await readSnapshot(`/api/v1/projects/${projectId}/tasks/${match[1]}`);
    if (detail) return detail.data;
    for (const snapshot of await snapshots()) {
      if (!snapshot.url.startsWith(`/api/v1/projects/${projectId}/tasks`)) continue;
      const found = (record(snapshot.data).items as unknown[] | undefined)?.find(item => record(item).taskId === match[1]);
      if (found) return found;
    }
  }
  return (await readSnapshot(url))?.data ?? null;
}
export async function queueOffline(url: string, method: string, body: unknown, idempotencyKey?: string): Promise<unknown> {
  const account = offlineAccount();
  if (!account || !offlineWritable(url, method)) throw new Error('此操作需要联网完成');
  const projectId = url.match(/\/projects\/([^/]+)/)![1]!;
  const project = await readSnapshot(`/api/v1/projects/${projectId}`);
  if (!project) throw new Error('此项目尚未缓存，请先联网打开项目');
  const existing = (await operations()).find(row => row.key === idempotencyKey);
  if (existing) return optimisticResult(existing, existing.base);
  const operation: PendingOperation = { key: idempotencyKey ?? crypto.randomUUID(), accountId: account.id, projectId, url, method, body: record(body), localId: crypto.randomUUID(), base: await operationBase(url, projectId), createdAt: new Date().toISOString(), state: 'pending' };
  // Persist intent before changing snapshots. A storage failure never masquerades as a save.
  await putOperation(operation);
  return optimisticResult(operation, operation.base);
}
export async function offlineView(url: string, cached: unknown): Promise<unknown> {
  let view = structuredClone(cached);
  for (const operation of await operations()) {
    if (operation.accountId !== offlineAccount()?.id) continue;
    if (!url.startsWith(`/api/v1/projects/${operation.projectId}/`)) continue;
    const result = optimisticResult(operation, operation.base);
    const path = new URL(url, window.location.origin).pathname;
    const taskId = record(operation.base).taskId ?? result.taskId;
    if (/\/tasks(?:\/[^/]+)?$/.test(path) && operation.url.includes('/tasks')) {
      if (path.endsWith('/tasks')) {
        const data = record(view), items = (data.items as Record<string, unknown>[] | undefined) ?? [];
        const index = items.findIndex(row => row.taskId === taskId);
        if (operation.url.endsWith('/submissions')) {
          if (index >= 0) items[index] = { ...items[index], lifecycleState: 'submitted', currentSubmissionId: operation.localId, revision: Number(operation.body.expectedRevision) + 1, offlinePending: true };
          view = { ...data, items }; continue;
        }
        if (index >= 0) items[index] = { ...items[index], ...result };
        else if (operation.method === 'POST' && /\/tasks$/.test(operation.url) && !new URL(url, window.location.origin).searchParams.has('cursor')) items.unshift(result);
        view = { ...data, items };
      } else if (path.endsWith(`/${String(taskId)}`)) view = { ...record(view), ...result };
    }
    if (path === operation.url && path.endsWith('/submissions')) view = { ...record(view), items: [result, ...((record(view).items as unknown[]) ?? [])] };
    if (path === operation.url && operation.method === 'PUT' && path.includes('/materials/')) view = { ...record(view), revision: result.revision, currentVersion: result };
    if (path.endsWith('/comments') && operation.url.endsWith('/comments')) {
      const params = new URL(url, window.location.origin).searchParams;
      if (!params.has('cursor') && params.get('targetId') === operation.body.targetId && params.get('targetType') === operation.body.targetType) view = { ...record(view), items: [result, ...((record(view).items as unknown[]) ?? [])] };
    }
    if (path.endsWith('/goal') && operation.method === 'POST' && /\/tasks$/.test(operation.url)) view = { ...record(view), graphRevision: Number(record(view).graphRevision ?? 0) + 1 };
  }
  return view;
}
export async function seedLocalEntity(url: string): Promise<unknown | undefined> {
  const rows = await operations();
  const row = rows.find(operation => url.endsWith(`/${operation.localId}`));
  return row ? offlineView(url, optimisticResult(row, row.base)) : undefined;
}
export async function replaceLocalIds(accountId: string, from: string, to: string): Promise<void> {
  for (const row of await operations(accountId)) {
    row.url = row.url.replaceAll(from, to);
    row.body = JSON.parse(JSON.stringify(row.body).replaceAll(from, to)) as Record<string, unknown>;
    await putOperation(row);
  }
  // List/detail snapshots will be refreshed after sync; local references in queued intents are durable.
}
export { writeSnapshot };
