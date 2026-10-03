import { afterEach, describe, it, expect, vi } from 'vitest';
import { env } from './helpers/env';
import { seedProject, seedUser } from './helpers/seed';
import { configureGoFixture, assertGoRequest } from './helpers/provider-config';
import { newId, nowIso } from '../src/core/db';
import { loadAiConfig } from '../src/ai/config';
import { reserveAiSlot } from '../src/services/budget';
import { executeFileTool, projectToolConversation } from '../src/services/project-ai-tools';
import { applyToolMode, nativeSearchCapability, normalizeToolResponse, toolResponseShape } from '../src/ai/tool-transport';
import { projectToolDefinitions } from '../src/services/project-ai-tools';
import { presetEndpoint, protocolForConfig } from '../../shared/ai-providers';
import { changeFileLifecycle } from '../src/services/file-lifecycle';
import { sourceInputsGuard } from '../src/services/source-inputs';
import { projectSourceContextGuard } from '../src/services/collaboration-context';
afterEach(() => vi.unstubAllGlobals());
it('accepts a complete discovery batch above the former four-tool cap and diagnoses shape without exposing content',()=>{
 const names=['get_project_overview','list_project_resources','list_tasks','read_project_standards','read_member_workload'];
 const data={choices:[{finish_reason:'tool_calls',message:{content:null,reasoning_content:'private reasoning',tool_calls:names.map((name,i)=>({id:`c${i}`,type:'function',function:{name,arguments:'{}'}}))}}]};
 expect(normalizeToolResponse('chat-completions',data).toolCalls).toHaveLength(5);
 expect(toolResponseShape(data)).toMatchObject({choices:1,finishReason:'tool_calls',toolCalls:5,answerChars:0});
 expect(JSON.stringify(toolResponseShape(data))).not.toContain('private reasoning');
});
async function fixture() {
  await configureGoFixture();
  const owner = await seedUser(), p = await seedProject(owner.userId), f = newId(), s = newId(), v = newId(), now = nowIso();
  await env.DB.batch([env.DB.prepare("INSERT INTO files(id,project_id,uploader_user_id,r2_key,ext,status,created_at,original_name) VALUES(?1,?2,?3,'private/key.txt','.txt','available',?4,'项目数据.txt')").bind(f, p, owner.userId, now), env.DB.prepare("INSERT INTO sources(id,project_id,kind,title,current_version_id,created_by,created_at,updated_at) VALUES(?1,?2,'file','资料',?3,?4,?5,?5)").bind(s, p, v, owner.userId, now), env.DB.prepare("INSERT INTO source_versions(id,source_id,project_id,revision,origin,file_id,status,created_at) VALUES(?1,?2,?3,1,'file',?4,'ready',?5)").bind(v, s, p, f, now), env.DB.prepare("INSERT INTO source_fragments(id,source_version_id,project_id,seq,kind,content,created_at) VALUES(?1,?2,?3,1,'text',?4,?5)").bind(newId(), v, p, '正文依据。'.repeat(3000), now)]);
  return {
    owner, p, f, v
  };
}
describe('server-authorized project tools', () => {
  it('bounds listing/reads, never exposes R2 keys, and refuses cross-project/user access', async () => {
    const a = await fixture(), b = await fixture();
    const context = {
      projectId: a.p, userId: a.owner.userId
    };
    const listing = await executeFileTool(env, context, 'list_project_files', {
      offset: 0
    });
    expect(JSON.stringify(listing)).not.toContain('private/key');
    expect(JSON.stringify(listing)).toContain(a.f);
    expect(JSON.stringify(listing)).not.toContain(b.f);
    const read = await executeFileTool(env, context, 'read_project_file', {
      fileId: a.f, mode: 'text', offset: 0
    }) as {
      fragments: Array<{
        quote: string;
      }>;
      nextOffset: number;
    };
    expect(read.fragments.reduce((n, f) => n + f.quote.length, 0)).toBe(6000);
    expect(read.nextOffset).toBe(6000);
    await expect(executeFileTool(env, context, 'read_project_file', {
      fileId: b.f, mode: 'text', offset: 0
    })).rejects.toThrow('文件不存在');
    await expect(executeFileTool(env, {
      ...context, userId: b.owner.userId
    }, 'list_project_files', {
      offset: 0
    })).rejects.toThrow('权限已变化');
    await expect(executeFileTool(env, context, 'read_project_file', {
      fileId: a.f, mode: 'text', offset: 0, url: 'http://localhost'
    })).rejects.toThrow();
  });
  it('executes provider-requested tools, returns results in protocol, logs provenance, and enforces current permissions before every request', async () => {
    const f = await fixture(), cfg = (await loadAiConfig(env.DB))!, jobId = newId();
    await reserveAiSlot(env, {
      projectId: f.p, jobId, purpose: 'agent_run', maxCalls: 5
    });
    await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_at,updated_at) VALUES(?1,?2,'agent_run','running','{}',?3,?3)").bind(jobId, f.p, nowIso()).run();
    let round = 0;
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      assertGoRequest(url, init);
      const body = JSON.parse(String(init?.body));
      if (round++ === 0) {
        return Response.json({
          choices: [{
              finish_reason: 'tool_calls', message: {
                tool_calls: [{
                    id: 'call-list', type: 'function', function: {
                      name: 'list_project_files', arguments: '{"offset":0}'
                    }
                  }]
              }
            }], usage: {
            prompt_tokens: 10, completion_tokens: 5
          }
        });
      }
      expect(body.messages.some((m: {
        role: string;
        content: string;
      }) => m.role === 'tool' && m.content.includes(f.f))).toBe(true);
      return Response.json({
        choices: [{
            finish_reason: 'stop', message: {
              content: '{"title":"计划"}'
            }
          }], usage: {
          prompt_tokens: 25, completion_tokens: 10
        }
      });
    });
    vi.stubGlobal('fetch', fetch);
    const out = await projectToolConversation(env, {
      context: {
        projectId: f.p, userId: f.owner.userId, jobId
      }, config: cfg.config.textEconomy, configVersionId: cfg.id, messages: [{
          role: 'user', content: '列出项目文件'
        }], promptVersion: 'fixture'
    });
    expect(out.trace).toEqual([{
        name: 'list_project_files', status: 'ok'
      }]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM ai_tool_calls WHERE job_id=?1').bind(jobId).first<{
      n: number;
    }>())?.n).toBe(1);
    await env.DB.prepare('DELETE FROM project_members WHERE project_id=?1').bind(f.p).run();
    await expect(projectToolConversation(env, {
      context: {
        projectId: f.p, userId: f.owner.userId, jobId
      }, config: cfg.config.textEconomy, configVersionId: cfg.id, messages: [{
          role: 'user', content: '读取'
        }], promptVersion: 'fixture'
    })).rejects.toThrow('权限已变化');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
describe('recycle lifecycle integration for dynamic file tools', () => {
  async function running(f: Awaited<ReturnType<typeof fixture>>) {
    const jobId = newId();
    await reserveAiSlot(env, {
      projectId: f.p, jobId, purpose: 'agent_run', maxCalls: 5
    });
    await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_at,updated_at) VALUES(?1,?2,'agent_run','running','{}',?3,?3)").bind(jobId, f.p, nowIso()).run();
    return jobId;
  }
  it('omits recycled files from lists and blocks text/saved summary; restoration exposes the same file with a new lifecycle', async () => {
    const f = await fixture(), context = {
      projectId: f.p, userId: f.owner.userId
    };
    await env.DB.prepare("INSERT INTO source_processing(source_version_id,project_id,text_status,summary_status,summary_json,updated_at) VALUES(?1,?2,'ready','ready','{\"overview\":\"保存的总结\"}',?3)").bind(f.v, f.p, nowIso()).run();
    expect(JSON.stringify(await executeFileTool(env, context, 'read_project_file', {
      fileId: f.f, mode: 'summary', offset: 0
    }))).toContain('保存的总结');
    await changeFileLifecycle(env, {
      projectId: f.p, fileId: f.f, actorId: f.owner.userId, expectedLifecycleVersion: 1, restore: false
    });
    expect(JSON.stringify(await executeFileTool(env, context, 'list_project_files', {
      offset: 0
    }))).not.toContain(f.f);
    for (const mode of ['text', 'summary'])
      await expect(executeFileTool(env, context, 'read_project_file', {
        fileId: f.f, mode, offset: 0
      })).rejects.toThrow('文件不存在或不可用');
    await changeFileLifecycle(env, {
      projectId: f.p, fileId: f.f, actorId: f.owner.userId, expectedLifecycleVersion: 2, restore: true
    });
    const read = await executeFileTool(env, context, 'read_project_file', {
      fileId: f.f, mode: 'text', offset: 0
    });
    expect(read).toMatchObject({
      fileId: f.f, fileLifecycleVersion: 3, sourceLifecycleVersion: 3, status: 'ready'
    });
    await env.DB.prepare("UPDATE sources SET deleted_at=?2,lifecycle_version=lifecycle_version+1 WHERE current_version_id=?1").bind(f.v, nowIso()).run();
    const unavailable = await executeFileTool(env, context, 'read_project_file', {
      fileId: f.f, mode: 'text', offset: 0
    });
    expect(unavailable).toMatchObject({
      status: 'unavailable'
    });
    expect(unavailable).not.toHaveProperty('fragments');
  });
  it('freezes dynamic reads in the job, cancels an in-flight result after delete/restore, and rejects both assistant writes and proposal adoption', async () => {
    const f = await fixture(), cfg = (await loadAiConfig(env.DB))!, jobId = await running(f);
    let round = 0;
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      assertGoRequest(url, init);
      if (round++ === 0) {
        return Response.json({
          choices: [{
              finish_reason: 'tool_calls', message: {
                tool_calls: [{
                    id: 'read', type: 'function', function: {
                      name: 'read_project_file', arguments: JSON.stringify({
                        fileId: f.f, mode: 'text', offset: 0
                      })
                    }
                  }]
              }
            }], usage: {
            prompt_tokens: 10, completion_tokens: 5
          }
        });
      }
      const body = JSON.parse(String(init?.body));
      expect(JSON.stringify(body.messages)).toContain('正文依据');
      const stored = await env.DB.prepare('SELECT input_json FROM jobs WHERE id=?1').bind(jobId).first<{
        input_json: string;
      }>();
      expect(JSON.parse(stored!.input_json).toolFileSnapshots).toEqual([{
          fileId: f.f, fileLifecycleVersion: 1, sourceId: expect.any(String), sourceVersionId: f.v, sourceLifecycleVersion: 1
        }]);
      await changeFileLifecycle(env, {
        projectId: f.p, fileId: f.f, actorId: f.owner.userId, expectedLifecycleVersion: 1, restore: false
      });
      await changeFileLifecycle(env, {
        projectId: f.p, fileId: f.f, actorId: f.owner.userId, expectedLifecycleVersion: 2, restore: true
      });
      return Response.json({
        choices: [{
            finish_reason: 'stop', message: {
              content: '{\"title\":\"过期结果\"}'
            }
          }], usage: {
          prompt_tokens: 20, completion_tokens: 10
        }
      });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(projectToolConversation(env, {
      context: {
        projectId: f.p, userId: f.owner.userId, jobId
      }, config: cfg.config.textEconomy, configVersionId: cfg.id, messages: [{
          role: 'user', content: '读取资料'
        }], promptVersion: 'fixture'
    })).rejects.toThrow('生命周期已变化');
    expect(fetch).toHaveBeenCalledTimes(2);
    const job = await env.DB.prepare('SELECT status,input_json FROM jobs WHERE id=?1').bind(jobId).first<{
      status: string;
      input_json: string;
    }>();
    expect(job!.status).toBe('cancelled');
    for (const guard of [sourceInputsGuard, projectSourceContextGuard])
      expect(await env.DB.prepare(`SELECT 1 WHERE ${guard('?1', '?2')}`).bind(job!.input_json, f.p).first()).toBeNull();
    expect((await env.DB.prepare('SELECT status FROM usage_reservations WHERE job_id=?1').bind(jobId).first<{
      status: string;
    }>())?.status).toBe('pending_reconcile');
  });
  it('cancels jobs that listed a file with no source, preserving original bytes and metadata', async () => {
    const f = await fixture(), jobId = await running(f);
    await env.DB.prepare('UPDATE source_versions SET file_id=NULL WHERE id=?1').bind(f.v).run();
    await env.DB.prepare('UPDATE jobs SET input_json=?2 WHERE id=?1').bind(jobId, JSON.stringify({
      toolFileSnapshots: [{
          fileId: f.f, fileLifecycleVersion: 1
        }]
    })).run();
    const changed = await changeFileLifecycle(env, {
      projectId: f.p, fileId: f.f, actorId: f.owner.userId, expectedLifecycleVersion: 1, restore: false
    });
    expect(changed.affectedSourceIds).toEqual([]);
    expect((await env.DB.prepare('SELECT status FROM jobs WHERE id=?1').bind(jobId).first<{
      status: string;
    }>())?.status).toBe('cancelled');
    expect((await env.DB.prepare('SELECT status FROM files WHERE id=?1').bind(f.f).first<{
      status: string;
    }>())?.status).toBe('available');
  });
});
describe('authorized native search (fixtures only)', () => {
  async function setup() {
    const f = await fixture(), cfg = (await loadAiConfig(env.DB))!;
    cfg.config.searchEnabled=true;
    Object.assign(cfg.config.textEconomy, {
      providerPreset: 'deepseek-anthropic', apiProtocol: 'messages', apiUrl: presetEndpoint('deepseek-anthropic', 'deepseek-v4-pro'), model: 'deepseek-v4-pro', supportsJson: false, reasoningEffort: undefined, temperature: undefined, topP: undefined
    });
    await env.DB.prepare('UPDATE ai_config_versions SET config_json=?2 WHERE id=?1').bind(cfg.id, JSON.stringify(cfg.config)).run();
    return {
      f, cfg
    };
  }
  it('sends only the explicitly approved public query, uses provider-native tools, and records returned citations/unknown fees', async () => {
    const { f, cfg } = await setup();
    let round = 0;
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.deepseek.com/anthropic/v1/messages');
      const body = JSON.parse(String(init?.body));
      if (round++ === 0) {
        return Response.json({
          stop_reason: 'tool_use', content: [{
              type: 'tool_use', id: 'search', name: 'web_search', input: {
                query: '公开查询'
              }
            }], usage: {
            input_tokens: 10, output_tokens: 5
          }
        });
      }
      if (round === 2) {
        expect(body.tools).toEqual([{
            type: 'web_search_20250305', name: 'web_search', max_uses: 1
          }]);
        expect(body.messages).toEqual([{
            role: 'user', content: '公开查询'
          }]);
        expect(JSON.stringify(body)).not.toContain(f.f);
        return Response.json({
          stop_reason: 'end_turn', content: [{
              type: 'server_tool_use', id: 'native', name: 'web_search', input: {
                query: '公开查询'
              }
            }, {
              type: 'web_search_tool_result', content: [{
                  type: 'web_search_result', url: 'https://example.com/source', title: '来源'
                }]
            }, {
              type: 'text', text: '检索事实'
            }], usage: {
            input_tokens: 20, output_tokens: 15, server_tool_use: {
              web_search_requests: 1
            }
          }
        });
      }
      expect(JSON.stringify(body.messages)).toContain('https://example.com/source');
      return Response.json({
        stop_reason: 'end_turn', content: [{
            type: 'text', text: '{"title":"有来源计划"}'
          }], usage: {
          input_tokens: 30, output_tokens: 10
        }
      });
    });
    vi.stubGlobal('fetch', fetch);
    const out = await projectToolConversation(env, {
      context: {
        projectId: f.p, userId: f.owner.userId, allowSearch: true, searchQuery: '公开查询'
      }, config: cfg.config.textEconomy, configVersionId: cfg.id, messages: [{
          role: 'user', content: '结合公开查询与项目资料'
        }], promptVersion: 'fixture'
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(out.citations).toEqual([{
        url: 'https://example.com/source', title: '来源'
      }]);
    expect(out.trace).toEqual([{
        name: 'web_search', status: 'ok'
      }]);
    const usage = await env.DB.prepare('SELECT search_usage_json FROM ai_calls WHERE project_id=?1 AND search_usage_json IS NOT NULL').bind(f.p).first<{
      search_usage_json: string;
    }>();
    expect(JSON.parse(usage!.search_usage_json)).toMatchObject({
      performed: true, costStatus: 'unknown'
    });
  });
  it('refuses a model-selected private query even when search is enabled, without dispatching native search', async () => {
    const { f, cfg } = await setup();
    let round = 0;
    const fetch = vi.fn(async () => round++ === 0 ? Response.json({
      stop_reason: 'tool_use', content: [{
          type: 'tool_use', id: 'search', name: 'web_search', input: {
            query: '正文依据与成员个人资料'
          }
        }], usage: {
        input_tokens: 10, output_tokens: 5
      }
    }) : Response.json({
      stop_reason: 'end_turn', content: [{
          type: 'text', text: '{"title":"未联网"}'
        }], usage: {
        input_tokens: 10, output_tokens: 5
      }
    }));
    vi.stubGlobal('fetch', fetch);
    const out = await projectToolConversation(env, {
      context: {
        projectId: f.p, userId: f.owner.userId, allowSearch: true, searchQuery: '公开查询'
      }, config: cfg.config.textEconomy, configVersionId: cfg.id, messages: [{
          role: 'user', content: '查公开资料'
        }], promptVersion: 'fixture'
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(out.trace).toEqual([{
        name: 'web_search', status: 'failed'
      }]);
    expect(out.citations).toEqual([]);
  });
});
describe('provider-native tool contracts (fixtures, no live billing)', () => {
  it.each(['chat-completions', 'responses', 'messages', 'gemini'] as const)('serializes local file tools and results for %s', protocol => {
    const cfg = {
      provider: 'openai-compatible', providerPreset: 'custom' as const, apiProtocol: protocol, model: 'fixture', maxInputChars: 10000, maxOutputTokens: 2000, timeoutMs: 1000, apiUrl: 'https://example.com', supportsJson: false, supportsVision: false, enabledOutputLimit: true, pricePerMTokens: null
    };
    const body: Record<string, unknown> = {
      input: [], messages: [], contents: []
    };
    applyToolMode(cfg, protocol, body, {
      definitions: projectToolDefinitions
    });
    expect(Array.isArray(body.tools)).toBe(true);
  });
  it('adds DeepSeek Anthropic preset with exact Messages URL and leaves standard DeepSeek Chat/Responses search unavailable', async () => {
    const cfg = (await loadAiConfig(env.DB))!.config.textEconomy;
    const deep = {
      ...cfg, providerPreset: 'deepseek-anthropic' as const, apiProtocol: 'messages' as const, apiUrl: presetEndpoint('deepseek-anthropic', 'deepseek-v4-pro'), model: 'deepseek-v4-pro', supportsJson: false
    };
    expect(deep.apiUrl).toBe('https://api.deepseek.com/anthropic/v1/messages');
    expect(protocolForConfig(deep)).toBe('messages');
    expect(nativeSearchCapability(deep).supported).toBe(true);
    expect(nativeSearchCapability({
      ...deep, providerPreset: 'deepseek', apiProtocol: 'chat-completions', apiUrl: 'https://api.deepseek.com/chat/completions'
    }).supported).toBe(false);
    const body: Record<string, unknown> = {
      messages: []
    };
    applyToolMode(deep, 'messages', body, {
      definitions: [], nativeSearch: true
    });
    expect(body.tools).toEqual([{
        type: 'web_search_20250305', name: 'web_search', max_uses: 1
      }]);
  });
  it('requires provider search evidence, extracts actual URLs and usage, and treats native errors as failures', () => {
    const searched = normalizeToolResponse('messages', {
      stop_reason: 'end_turn', content: [{
          type: 'server_tool_use', id: 's1', name: 'web_search', input: {
            query: '公开查询'
          }
        }, {
          type: 'web_search_tool_result', tool_use_id: 's1', content: [{
              type: 'web_search_result', url: 'https://example.com/evidence', title: '官方来源'
            }]
        }, {
          type: 'text', text: '联网结果'
        }], usage: {
        input_tokens: 20, output_tokens: 10, server_tool_use: {
          web_search_requests: 1
        }
      }
    }, true);
    expect(searched.citations).toEqual([{
        url: 'https://example.com/evidence', title: '官方来源'
      }]);
    expect(searched.searchUsage).toMatchObject({
      performed: true, queries: 1, costStatus: 'unknown'
    });
    expect(normalizeToolResponse('messages', {
      stop_reason: 'end_turn', content: [{
          type: 'text', text: '我已搜索互联网'
        }], usage: {}
    }, true).searchUsage?.performed).toBe(false);
    expect(() => normalizeToolResponse('messages', {
      stop_reason: 'end_turn', content: [{
          type: 'web_search_tool_result', content: {
            type: 'web_search_tool_result_error', error_code: 'unavailable'
          }
        }]
    }, true)).toThrow('原生搜索失败');
  });
  it('forces OpenRouter native mode instead of default Exa fallback', async () => {
    const cfg = (await loadAiConfig(env.DB))!.config.textEconomy;
    const body: Record<string, unknown> = {
      messages: []
    };
    applyToolMode({
      ...cfg, providerPreset: 'openrouter'
    }, 'chat-completions', body, {
      definitions: [], nativeSearch: true
    });
    expect(body.plugins).toEqual([{
        id: 'web', engine: 'native', max_results: 3
      }]);
  });
});
