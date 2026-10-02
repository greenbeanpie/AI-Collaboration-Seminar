import { describe, expect, it } from 'vitest';
import { env } from './helpers/env';
import { seedProject, seedUser } from './helpers/seed';
import { discoveryDefinitions, executeDiscoveryTool } from '../src/services/project-context';
import { validateReadReferences, type ProjectReference } from '../src/services/project-evidence';
import { projectReferenceGuard } from '../src/services/project-reference-guard';

describe('retired ledger AI context', () => {
  it('searches and reads project context after all manual ledger tables are removed', async () => {
    const owner = await seedUser();
    const projectId = await seedProject(owner.userId, 'retired ledger search');
    expect(discoveryDefinitions.map(([name]) => name)).not.toContain('list_project_decisions');
    expect(await executeDiscoveryTool(env, projectId, 'search_project_information', { query: 'retired' })).toMatchObject({ items: [] });
    expect(await executeDiscoveryTool(env, projectId, 'get_project_overview', {})).toMatchObject({ project: { id: projectId } });
    await expect(executeDiscoveryTool(env, projectId, 'list_project_decisions', {})).rejects.toThrow('未授权工具名称');
  });
  it('rejects retired decision references without preparing a query and preserves other evidence guards', async () => {
    const reference: ProjectReference = { id: 'old-decision', resourceType: 'decision', resourceId: crypto.randomUUID(), quote: '{"title":"historic"}', usage: 'decision' };
    const noQueryEnv = { ...env, DB: new Proxy(env.DB, { get(target, key) { if (key === 'prepare') return () => { throw new Error('unexpected database query'); }; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } }) };
    await expect(validateReadReferences(noQueryEnv, crypto.randomUUID(), [reference])).rejects.toThrow('来源已移除');
    const guard = projectReferenceGuard('?1', '?2');
    expect(guard).not.toContain('FROM decisions');
    expect(guard).toContain('FROM task_submissions');
    const owner = await seedUser(), projectId = await seedProject(owner.userId);
    const result = await env.DB.prepare(`SELECT ${guard} valid`).bind(JSON.stringify([reference]), projectId).first<{ valid: number }>();
    expect(result?.valid).toBe(0);
  });
});
