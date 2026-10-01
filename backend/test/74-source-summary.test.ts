import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { configureGoFixture } from './helpers/provider-config';
import { mockGatewayFetch } from './helpers/ai-mock';
import { extractSourceVersionText, runParseJob } from '../src/services/parse';
import { enqueueSourceSummary, runSourceSummary, setSourceStage } from '../src/services/source-summary';
import { loadAiConfig } from '../src/ai/config';
import type { Env } from '../src/env';

await configureGoFixture();
afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  const owner = await seedUser(); const projectId = await seedProject(owner.userId); const cookie = authCookie(owner.token);
  const created = await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/sources`, { method:'POST', headers:{cookie,'content-type':'application/json'},body:JSON.stringify({kind:'paste',text:'本文说明软件安装步骤与接口配置事项，仅供学习。请核实官方文档，不包含比赛参赛要求。'}) });
  const ids = (await created.json() as {data:{sourceId:string;sourceVersionId:string}}).data;
  await extractSourceVersionText(env,ids.sourceVersionId); await setSourceStage(env,ids.sourceVersionId,'text','ready');
  return {...ids,owner,projectId,cookie,path:`${BASE}/api/v1/projects/${projectId}/sources/${ids.sourceId}/versions/${ids.sourceVersionId}/processing`};
}

async function summaryJob(f: Awaited<ReturnType<typeof fixture>>) {
  const jobId = crypto.randomUUID(); const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,attempts,created_by,created_at,updated_at) VALUES (?1,?2,'requirement_extract','queued',?3,0,?4,?5,?5)").bind(jobId,f.projectId,JSON.stringify({operation:'source.summary',sourceVersionId:f.sourceVersionId,summaryRevision:1}),f.owner.userId,now),
    env.DB.prepare("UPDATE source_processing SET summary_status='queued',summary_job_id=?2,summary_revision=1 WHERE source_version_id=?1").bind(f.sourceVersionId,jobId),
  ]);
  return jobId;
}

describe('independent source summaries', () => {
  it('freezes the current config for a new summary without parsing text or requirements again', async () => {
    const f = await fixture(); const old = (await loadAiConfig(env.DB))!;
    await env.DB.prepare('UPDATE source_versions SET ai_config_version_id = ?2 WHERE id = ?1').bind(f.sourceVersionId, old.id).run();
    const currentId = crypto.randomUUID(); const config = structuredClone(old.config);
    config.textEconomy.enabledOutputLimit = false;
    await env.DB.prepare('INSERT INTO ai_config_versions(id,version,config_json,enabled,created_at) VALUES (?1,?2,?3,1,?4)').bind(currentId,old.version+1,JSON.stringify(config),new Date().toISOString()).run();
    const dispatch = vi.fn(async () => ({ id: crypto.randomUUID() }));
    const fetch = vi.fn(); vi.stubGlobal('fetch',fetch);
    const result = await enqueueSourceSummary({ ...env, PARSE_WORKFLOW: { create:dispatch } } as unknown as Env,f.sourceVersionId,f.owner.userId,0);
    const job = await env.DB.prepare('SELECT input_json FROM jobs WHERE id = ?1').bind(result.jobId).first<{input_json:string}>();
    expect(JSON.parse(job!.input_json)).toMatchObject({ operation:'source.summary', configVersionId:currentId, phase:'summary' });
    expect((await loadAiConfig(env.DB,old.id))!.config.textEconomy.enabledOutputLimit).toBe(true);
    expect(fetch).not.toHaveBeenCalled(); expect(dispatch).toHaveBeenCalledOnce();
    expect(await env.DB.prepare('SELECT ai_config_version_id FROM source_versions WHERE id = ?1').bind(f.sourceVersionId).first()).toEqual({ ai_config_version_id: old.id });
    // A later save cannot replace an already-created summary's frozen config.
    await env.DB.prepare('INSERT INTO ai_config_versions(id,version,config_json,enabled,created_at) VALUES (?1,?2,?3,1,?4)').bind(crypto.randomUUID(),old.version+2,JSON.stringify(old.config),new Date().toISOString()).run();
    const summaryFetch = mockGatewayFetch({ outputLimitEnabled: false }); vi.stubGlobal('fetch',summaryFetch);
    expect((await runSourceSummary(env,result.jobId)).status).toBe('succeeded');
    expect(JSON.parse(String(summaryFetch.mock.calls[0]?.[1]?.body))).not.toHaveProperty('max_tokens');
    expect(await env.DB.prepare('SELECT config_version_id FROM ai_calls WHERE job_id = ?1').bind(result.jobId).first()).toEqual({ config_version_id: currentId });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE project_id = ?1 AND kind = 'parse_source'").bind(f.projectId).first()).toEqual({n:0});
  });
  it('keeps text and a failed requirements stage, while summary succeeds with validated citations and accounting', async () => {
    const f = await fixture(); const jobId = await summaryJob(f); await setSourceStage(env,f.sourceVersionId,'requirements','failed','要求提取暂时失败');
    const fetch = mockGatewayFetch(); vi.stubGlobal('fetch',fetch);
    expect((await runSourceSummary(env,jobId)).status).toBe('succeeded'); expect(fetch).toHaveBeenCalledOnce();
    const response = await SELF.fetch(f.path,{headers:{cookie:f.cookie}}); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    const state = (await response.json() as {data:{textStatus:string;requirementsStatus:string;summaryStatus:string;summary:{citations:unknown[]};coveredChars:number;totalChars:number}}).data;
    expect(state.textStatus).toBe('ready'); expect(state.requirementsStatus).toBe('failed'); expect(state.summaryStatus).toBe('ready'); expect(state.summary.citations).toHaveLength(1); expect(state.coveredChars).toBe(state.totalChars);
    expect(await (await env.FILES.get(`sources/${f.sourceVersionId}/paste.txt`))!.text()).toContain('软件安装');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM ai_calls WHERE job_id=?1').bind(jobId).first<{n:number}>())?.n).toBe(1);
    expect((await env.DB.prepare('SELECT status FROM usage_reservations WHERE job_id=?1').bind(jobId).first<{status:string}>())?.status).not.toBe('reserved');
  });

  it('reports failed summary without erasing original text or successful requirements', async () => {
    const f = await fixture(); const jobId = await summaryJob(f); await setSourceStage(env,f.sourceVersionId,'requirements','ready');
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('provider down',{status:503})));
    expect((await runSourceSummary(env,jobId)).status).toBe('failed');
    const state = (await (await SELF.fetch(f.path,{headers:{cookie:f.cookie}})).json() as {data:{textStatus:string;requirementsStatus:string;summaryStatus:string;summary:null;summaryError:string}}).data;
    expect(state.textStatus).toBe('ready'); expect(state.requirementsStatus).toBe('ready'); expect(state.summaryStatus).toBe('failed'); expect(state.summary).toBeNull(); expect(state.summaryError).toBeTruthy();
    expect(await env.FILES.get(`sources/${f.sourceVersionId}/paste.txt`)).not.toBeNull();
  });

  it('prevents duplicate workers from issuing a second paid request', async () => {
    const f = await fixture(); const jobId = await summaryJob(f); let resolve!: (r: Response) => void;
    const mock = mockGatewayFetch(); const fetch = vi.fn((url:RequestInfo|URL,init?:RequestInit) => new Promise<Response>(r => { resolve = async response => r(response); void mock(url,init).then(response => { resolve = () => r(response); }); }));
    vi.stubGlobal('fetch',fetch); const running = runSourceSummary(env,jobId);
    for(let i=0;i<50 && !fetch.mock.calls.length;i++) await new Promise(r=>setTimeout(r,5));
    expect((await runSourceSummary(env,jobId)).status).toBe('running'); expect(fetch).toHaveBeenCalledOnce();
    resolve(new Response()); expect((await running).status).toBe('succeeded');
  });

  it('validates project access and rejects stale revisions and incomplete text without model calls', async () => {
    const f = await fixture(); const outsider = await seedUser();
    expect((await SELF.fetch(f.path,{headers:{cookie:authCookie(outsider.token)}})).status).toBe(403);
    const fetch = vi.fn(); vi.stubGlobal('fetch',fetch);
    const stale = await SELF.fetch(`${f.path}/summary`,{method:'POST',headers:{cookie:f.cookie,'content-type':'application/json'},body:JSON.stringify({expectedSummaryRevision:9})});
    expect(stale.status).toBe(409); expect(fetch).not.toHaveBeenCalled();
    await env.DB.prepare("UPDATE source_pages SET text_status='none' WHERE source_version_id=?1 AND page_number=1").bind(f.sourceVersionId).run();
    expect((await SELF.fetch(`${f.path}/summary`,{method:'POST',headers:{cookie:f.cookie,'content-type':'application/json'},body:JSON.stringify({expectedSummaryRevision:0})})).status).toBe(409); expect(fetch).not.toHaveBeenCalled();
  });

  it('does not save fabricated summary citations', async () => {
    const f = await fixture(); const jobId = await summaryJob(f);
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({title:'错误总结',summary:'虚假内容',keyPoints:['虚假'],citations:[{fragmentId:crypto.randomUUID(),pageNumber:null,quote:'不存在'}],caveats:[]})}}],usage:{prompt_tokens:20,completion_tokens:20}}),{status:200,headers:{'content-type':'application/json'}})));
    expect((await runSourceSummary(env,jobId)).status).toBe('failed');
    expect((await env.DB.prepare('SELECT summary_json FROM source_processing WHERE source_version_id=?1').bind(f.sourceVersionId).first<{summary_json:string|null}>())?.summary_json).toBeNull();
  });

  it('bounds total prompt size including instructions and records partial document coverage', async () => {
    const f = await fixture(); const jobId = await summaryJob(f);
    const row = await env.DB.prepare('SELECT id,config_json FROM ai_config_versions ORDER BY version DESC LIMIT 1').first<{id:string;config_json:string}>();
    const config = JSON.parse(row!.config_json) as {textEconomy:{maxInputChars:number}}; config.textEconomy.maxInputChars = 1200;
    await env.DB.prepare('UPDATE ai_config_versions SET config_json=?2 WHERE id=?1').bind(row!.id,JSON.stringify(config)).run();
    for(let seq=2;seq<=8;seq++) await env.DB.prepare("INSERT INTO source_fragments(id,source_version_id,project_id,page_number,seq,kind,content,created_at) VALUES (?1,?2,?3,NULL,?4,'paste',?5,?6)").bind(crypto.randomUUID(),f.sourceVersionId,f.projectId,seq,'测试资料内容。'.repeat(45),new Date().toISOString()).run();
    const fetch = mockGatewayFetch();vi.stubGlobal('fetch',fetch);
    expect((await runSourceSummary(env,jobId)).status).toBe('succeeded');
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as {messages:Array<{content:string}>};
    expect(body.messages.reduce((n,m)=>n+m.content.length,0)).toBeLessThanOrEqual(1200);
    const coverage = await env.DB.prepare('SELECT covered_chars,total_chars FROM source_processing WHERE source_version_id=?1').bind(f.sourceVersionId).first<{covered_chars:number;total_chars:number}>();
    expect(coverage!.covered_chars).toBeLessThan(coverage!.total_chars);
  });

  it('accepts a document with no competition requirements without inventing requirement records', async () => {
    const f = await fixture(); const jobId = crypto.randomUUID();const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,attempts,created_by,created_at,updated_at) VALUES (?1,?2,'parse_source','queued',?3,0,?4,?5,?5)").bind(jobId,f.projectId,JSON.stringify({sourceId:f.sourceId,sourceVersionId:f.sourceVersionId,phase:'extract'}),f.owner.userId,now).run();
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({choices:[{message:{content:'{"requirements":[]}'}}],usage:{prompt_tokens:20,completion_tokens:10}}),{status:200,headers:{'content-type':'application/json'}})));
    expect((await runParseJob(env,jobId)).status).toBe('succeeded');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM requirements WHERE project_id=?1').bind(f.projectId).first<{n:number}>())?.n).toBe(0);
    expect((await env.DB.prepare('SELECT result_json FROM jobs WHERE id=?1').bind(jobId).first<{result_json:string}>())?.result_json).toContain('"count":0');
  });
});
