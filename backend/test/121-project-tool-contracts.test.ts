import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { env } from './helpers/env';
import { seedProject, seedUser } from './helpers/seed';
import { configureGoFixture } from './helpers/provider-config';
import { newId, nowIso } from '../src/core/db';
import { loadAiConfig } from '../src/ai/config';
import { executeDiscoveryTool, parseDiscoveryArgs } from '../src/services/project-context';
import { projectToolConversation, projectToolDefinitions } from '../src/services/project-ai-tools';
import { aiJsonCall } from '../src/services/agent';

afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  await configureGoFixture();
  const owner = await seedUser(), projectId = await seedProject(owner.userId), taskId = newId();
  await env.DB.prepare("INSERT INTO tasks(id,project_id,title,detail,status,assignee_id,effort_hours,revision,created_by,created_at,updated_at) VALUES(?1,?2,'真实任务','任务正文','todo',?3,3,1,?3,?4,?4)")
    .bind(taskId, projectId, owner.userId, nowIso()).run();
  return { owner, projectId, taskId, config: (await loadAiConfig(env.DB))! };
}

describe('project tool argument contracts', () => {
  it('does not interpret a legacy project id as a task filter or hide real tasks', async () => {
    const f = await fixture();
    const result = await executeDiscoveryTool(env, f.projectId, 'list_tasks', { offset: 0, id: f.projectId });
    expect(result.items).toEqual([expect.objectContaining({ id: f.taskId, detail: '任务正文' })]);
    await expect(executeDiscoveryTool(env, f.projectId, 'list_tasks', { id: newId() })).rejects.toThrow();
    await expect(executeDiscoveryTool(env, f.projectId, 'read_task', { id: f.projectId })).rejects.toThrow('任务不存在');
    expect(await executeDiscoveryTool(env, f.projectId, 'read_task', { id: f.taskId })).toMatchObject({ items: [expect.objectContaining({ id: f.taskId })] });
  });

  it('keeps discovery arguments valid when revalidated by the conversation executor', async () => {
    const f = await fixture();
    const args = parseDiscoveryArgs('get_project_overview', {}, f.projectId);
    expect(await executeDiscoveryTool(env, f.projectId, 'get_project_overview', args)).toMatchObject({ project: { id: f.projectId } });
    expect(parseDiscoveryArgs('read_admin_feedback', { id: f.projectId }, f.projectId)).toEqual({ offset: 0 });
    expect(parseDiscoveryArgs('read_admin_feedback', { id: f.taskId }, f.projectId)).toEqual({ offset: 0, id: f.taskId });
  });

  it.each(['read_member_workload', 'list_tasks', 'read_project_standards'])('accepts omitted optional placeholders in legacy %s calls', async name => {
    const f = await fixture();
    await expect(executeDiscoveryTool(env, f.projectId, name, {
      offset: 0, id: f.projectId, query: null, resourceType: null, versionId: null,
    })).resolves.toHaveProperty('untrustedData', true);
  });

  it('advertises only relevant fields and declares the executor-required arguments', () => {
    const parameters = (name: string) => projectToolDefinitions.find(tool => tool.name === name)!.parameters;
    expect(Object.keys(parameters('read_member_workload').properties as object)).toEqual(['offset']);
    expect(Object.keys(parameters('list_tasks').properties as object)).toEqual(['offset', 'query']);
    expect(Object.keys(parameters('read_project_standards').properties as object)).toEqual(['offset']);
    for (const name of ['read_task', 'read_submission', 'read_project_plan', 'read_assessment']) {
      expect(parameters(name).required).toContain('id');
    }
    expect(parameters('read_resource').required).toEqual(expect.arrayContaining(['resourceType', 'versionId']));
    expect(parameters('list_resource_versions').required).toEqual(expect.arrayContaining(['id', 'resourceType']));
    expect(parameters('search_project_information').required).toContain('query');
  });

  it('rejects missing read ids, bad offsets, and model-supplied project scope before reading', async () => {
    const f = await fixture();
    for (const args of [{ offset: -1 }, { offset: '0' }, { projectId: newId() }, { query: 'x'.repeat(201) }]) {
      await expect(executeDiscoveryTool(env, f.projectId, 'list_tasks', args)).rejects.toThrow();
    }
    await expect(executeDiscoveryTool(env, f.projectId, 'read_task', { id: null })).rejects.toThrow();
    await expect(executeDiscoveryTool(env, f.projectId, 'read_task', {})).rejects.toThrow();
    await expect(executeDiscoveryTool(env, f.projectId, 'search_project_information', { query: '   ' })).rejects.toThrow();
  });

  it('executes the screenshot discovery batch on the first round without an extra repair request', async () => {
    const f = await fixture();
    const names = ['read_member_workload', 'list_tasks', 'read_project_standards'];
    let results: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (fetch.mock.calls.length === 1) {
        return Response.json({ choices: [{ finish_reason: 'tool_calls', message: {
          tool_calls: names.map((name, index) => ({ id: `call-${index}`, type: 'function', function: {
            name, arguments: JSON.stringify({ offset: 0, id: f.projectId, query: null, resourceType: null, versionId: null }),
          } })),
        } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
      }
      const messages = JSON.parse(String(init?.body)).messages as Array<{ role: string; content: string }>;
      results = messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"title":"已读取真实任务"}' } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
    });
    vi.stubGlobal('fetch', fetch);
    const output = await projectToolConversation(env, {
      context: { projectId: f.projectId, userId: f.owner.userId }, config: f.config.config.textEconomy,
      configVersionId: f.config.id, messages: [{ role: 'user', content: '自动分配成员任务' }], promptVersion: 'tool-contract-regression',
    });
    expect(output.trace).toEqual(names.map(name => ({ name, status: 'ok' })));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(3);
    expect(results.every(result => !result.error)).toBe(true);
    expect(results[1]!.items).toEqual([expect.objectContaining({ id: f.taskId })]);
    expect(results[0]!.items).toEqual([expect.objectContaining({ user_id: f.owner.userId, loadHours: 3 })]);
  });

  it('returns actionable field diagnostics to the model and audit log without retaining invalid values', async () => {
    const f = await fixture(), privateValue = 'private-invalid-uuid';
    let result: Record<string, unknown> = {};
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (fetch.mock.calls.length === 1) {
        return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{
          id: 'bad-id', type: 'function', function: { name: 'read_task', arguments: JSON.stringify({ id: privateValue, offset: 0 }) },
        }] } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
      }
      const messages = JSON.parse(String(init?.body)).messages as Array<{ role: string; content: string }>;
      result = JSON.parse(messages.find(message => message.role === 'tool')!.content);
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"title":"参数失败已说明"}' } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
    });
    vi.stubGlobal('fetch', fetch);
    await projectToolConversation(env, {
      context: { projectId: f.projectId, userId: f.owner.userId }, config: f.config.config.textEconomy,
      configVersionId: f.config.id, messages: [{ role: 'user', content: '读取指定任务' }], promptVersion: 'tool-contract-regression',
    });
    expect(result.error).toContain('id');
    expect(result.error).toContain('uuid');
    expect(result.error).not.toContain(privateValue);
    expect(result.argumentErrors).toEqual([expect.objectContaining({ path: 'id', code: 'invalid_format' })]);
    const row = await env.DB.prepare("SELECT args_json,result_json FROM ai_tool_calls WHERE project_id=?1 AND name='read_task'")
      .bind(f.projectId).first<{ args_json: string; result_json: string }>();
    expect(JSON.parse(row!.result_json).argumentErrors).toEqual([expect.objectContaining({ path: 'id', code: 'invalid_format' })]);
    expect(row!.args_json + row!.result_json).not.toContain(privateValue);
  });
});

describe('complete final output repair context', () => {
  it.each([false, true])('preserves text after 8000 characters during repair (projectTools=%s)', async useTools => {
    const f = await fixture(), markdown = '正文'.repeat(4500) + 'TAIL-MUST-BE-PRESERVED';
    let previousContent = '';
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (fetch.mock.calls.length === 1) {
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ title: 123, markdown }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
      }
      const messages = JSON.parse(String(init?.body)).messages as Array<{ role: string; content: string }>;
      previousContent = messages.find(message => message.role === 'assistant')!.content;
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ title: '已修复标题', markdown }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
    });
    vi.stubGlobal('fetch', fetch);
    const modelConfig = { ...f.config.config.textEconomy, maxInputChars: 24000 };
    const result = await aiJsonCall(env, {
      projectId: f.projectId, projectTools: useTools ? { projectId: f.projectId, userId: f.owner.userId } : undefined,
      purpose: 'textEconomy', configVersionId: f.config.id, model: modelConfig.model, modelConfig,
      promptVersion: 'long-repair-regression', messages: [{ role: 'user', content: '生成完整长文' }],
      schema: z.object({ title: z.string(), markdown: z.string().max(60000) }).strict(),
    });
    expect(result.repaired).toBe(true);
    expect(result.data.markdown).toBe(markdown);
    expect(JSON.parse(previousContent)).toEqual({ title: 123, markdown });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('does not dispatch a truncated repair when the complete output exceeds the input budget (projectTools=%s)', async useTools => {
    const f = await fixture();
    const fetch = vi.fn(async () => Response.json({ choices: [{ finish_reason: 'stop', message: {
      content: JSON.stringify({ title: 123, markdown: '正文'.repeat(4500) }),
    } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    vi.stubGlobal('fetch', fetch);
    const modelConfig = { ...f.config.config.textEconomy, maxInputChars: 8000 };
    await expect(aiJsonCall(env, {
      projectId: f.projectId, projectTools: useTools ? { projectId: f.projectId, userId: f.owner.userId } : undefined,
      purpose: 'textEconomy', configVersionId: f.config.id, model: modelConfig.model, modelConfig,
      promptVersion: 'oversized-repair-regression', messages: [{ role: 'user', content: '生成完整长文' }],
      schema: z.object({ title: z.string(), markdown: z.string().max(60000) }).strict(),
    })).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
