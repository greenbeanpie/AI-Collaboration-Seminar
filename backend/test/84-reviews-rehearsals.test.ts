import { saveStandard } from '../src/services/project-simplification';
import { configureGoFixture } from './helpers/provider-config';
import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { mockGatewayFetch } from './helpers/ai-mock';
import { runAiJob } from '../src/services/ai-jobs';
import { markdownToDoc } from '../src/services/tiptap';

afterEach(() => {
  vi.unstubAllGlobals();
});
function compatibleGatewayMock(){
  const fallback=mockGatewayFetch();
  return vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const body=JSON.parse(String(init?.body)) as {messages?:Array<{role:string;content:string}>};
    const system=String(body.messages?.[0]?.content??'');
    if(!system.includes('预审评估助手'))return fallback(input,init);
    const supplied=JSON.parse(body.messages?.[1]?.content??'{}') as {materials:Array<{materialVersionId:string;markdown:string}>};
    const evidence=supplied.materials.map(m=>({materialVersionId:m.materialVersionId,quote:m.markdown}));
    const keys=[...system.matchAll(/- (\w+)（/g)].map(match=>match[1]);
    return Response.json({choices:[{message:{content:JSON.stringify({scores:keys.map(key=>({key,score:80,confidence:.9,evidence,comment:'有固定正文证据',suggestions:[]})),overall:{score:1,summary:'非官方辅助结果'}})}}],usage:{prompt_tokens:30,completion_tokens:20}});
  });
}

await configureGoFixture();

async function ensureAiJobDone(cookie: string, jobId: string): Promise<{ status: string; result: unknown; error: unknown }> {
  for (let i = 0; i < 20; i++) {
    const res = await SELF.fetch(`${BASE}/api/v1/jobs/${jobId}`, { headers: { cookie } });
    if (res.status === 200) {
      const data = (await res.json() as { data: { status: string; result: unknown; error: unknown } }).data;
      if (['succeeded', 'failed', 'waiting_input'].includes(data.status)) return data;
    } else {
      await res.text();
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  await runAiJob(env, jobId);
  const res = await SELF.fetch(`${BASE}/api/v1/jobs/${jobId}`, { headers: { cookie } });
  return (await res.json() as { data: { status: string; result: unknown; error: unknown } }).data;
}

interface Setup {
  owner: { token: string; userId: string };
  pid: string;
  materialVersionId: string;
  rubricVersionId: string;
  requirementSetId: string;
}

/** 准备预审/答辩所需的材料、评分标准、要求集 */
async function setup(): Promise<Setup> {
  const owner = await seedUser();
  const pid = await seedProject(owner.userId);
  const cookie = authCookie(owner.token);

  const create = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/materials`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ title: '作品介绍' }),
  });
  const material = (await create.json() as { data: { materialId: string; revision: number } }).data;
  const save = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/materials/${material.materialId}`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: material.revision, doc: markdownToDoc('# 作品介绍\n\n本作品面向组队作业场景。') }),
  });
  const versionId = ((await save.json()) as { data: { versionId: string } }).data.versionId;

  const rubric = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/rubrics`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'official',
      weights: [
        { key: 'theme', label: '主题契合', weight: 20 },
        { key: 'innovation', label: '创新性', weight: 25 },
      ],
    }),
  });
  const rubricVersionId = ((await rubric.json()) as { data: { rubricId: string } }).data.rubricId;
  const confirmed=await SELF.fetch(`${BASE}/api/v1/projects/${pid}/rubrics/${rubricVersionId}/confirm`,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({})});
  expect(confirmed.status).toBe(200);

  // 通过解析产生要求集（mock AI）
  const src = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/sources`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'paste', text: '通知：作品提交截止 2026-10-08，队伍最多五人，须提交申报书 PDF 与介绍视频 MP4，逾期不受理。' }),
  });
  const { sourceId } = (await src.json() as { data: { sourceId: string } }).data;
  const parse = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/sources/${sourceId}/parse`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const parseJobId = ((await parse.json()) as { data: { jobId: string } }).data.jobId;
  await ensureAiJobDone(cookie, parseJobId);
  const setRow = await env.DB.prepare('SELECT id FROM requirement_sets WHERE project_id = ?1 ORDER BY created_at DESC LIMIT 1')
    .bind(pid)
    .first<{ id: string }>();

  await saveStandard(env,pid,owner.userId,{requirementSetIds:[setRow!.id],rubricVersionId});
  return { owner, pid, materialVersionId: versionId, rubricVersionId, requirementSetId: setRow!.id };
}

describe('预审', () => {
  it('resolves the active standard by default and rejects superseded component selectors', async () => {
    vi.stubGlobal('fetch',compatibleGatewayMock());
    const f=await setup(),cookie=authCookie(f.owner.token);
    await saveStandard(env,f.pid,f.owner.userId,{requirements:[{title:'新要求',detail:'作品须符合新的质量要求'}],weights:[{key:'quality',label:'新质量',weight:100}]});
    const stale=await SELF.fetch(`${BASE}/api/v1/projects/${f.pid}/reviews`,{method:'POST',headers:{cookie,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify({rubricVersionId:f.rubricVersionId,requirementSetId:f.requirementSetId,materialVersionIds:[f.materialVersionId]})});
    expect(stale.status).toBe(409);await stale.text();
    const current=await SELF.fetch(`${BASE}/api/v1/projects/${f.pid}/reviews`,{method:'POST',headers:{cookie,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify({materialVersionIds:[f.materialVersionId]})});
    expect(current.status).toBe(202);await current.text();
  });

  it('发起 → 运行 → 报告覆盖全部评分维度', async () => {
    vi.stubGlobal('fetch', compatibleGatewayMock());
    const { owner, pid, materialVersionId, rubricVersionId, requirementSetId } = await setup();
    const cookie = authCookie(owner.token);

    const create = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/reviews`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ rubricVersionId, requirementSetId, materialVersionIds: [materialVersionId] }),
    });
    expect(create.status).toBe(202);
    const created = (await create.json()) as { data: { reviewId: string; jobId: string } };

    const done = await ensureAiJobDone(cookie, created.data.jobId);
    expect(done.status).toBe('succeeded');

    const detail = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/reviews/${created.data.reviewId}`, { headers: { cookie } });
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { data: { status: string; report: { scores: Array<{ key: string; score: number }>; overall: { score: number }; materialVersionIds: string[] } } };
    expect(body.data.status).toBe('succeeded');
    expect(body.data.report.scores.map((s) => s.key).sort()).toEqual(['innovation', 'theme']);
    expect(body.data.report.overall.score).toBe(80);
    // 报告绑定明确输入版本
    expect(body.data.report.materialVersionIds).toEqual([materialVersionId]);

    // 输入不属于本项目 → 404
    const other = await seedUser();
    const otherSetup = await setup();
    void other;
    const bad = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/reviews`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ rubricVersionId, requirementSetId, materialVersionIds: [otherSetup.materialVersionId] }),
    });
    expect(bad.status).toBe(404);
  });
});

describe('答辩演练', () => {
  it('第一问 → 逐题回答 → 追问 → 总结收尾', async () => {
    vi.stubGlobal('fetch', compatibleGatewayMock());
    const { owner, pid, materialVersionId } = await setup();
    const cookie = authCookie(owner.token);

    const create = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/rehearsals`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'all', materialVersionIds: [materialVersionId] }),
    });
    expect(create.status).toBe(202);
    const created = (await create.json()) as { data: { rehearsalId: string; jobId: string } };

    const firstDone = await ensureAiJobDone(cookie, created.data.jobId);
    expect(firstDone.status).toBe('succeeded');

    // 第一问
    let detail = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/rehearsals/${created.data.rehearsalId}`, { headers: { cookie } });
    let body = (await detail.json()) as { data: { status: string; turns: Array<{ sequence: number; kind: string; content: string }> } };
    expect(body.data.turns).toHaveLength(1);
    expect(body.data.turns[0]?.kind).toBe('question');

    // 回答 → 追问
    const answer = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/rehearsals/${created.data.rehearsalId}/answers`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ content: '痛点依据来自三份调研报告。' }),
    });
    expect(answer.status).toBe(202);
    const answerBody = (await answer.json()) as { data: { jobId: string } };
    await ensureAiJobDone(cookie, answerBody.data.jobId);

    // 结束 → 总结
    const finish = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/rehearsals/${created.data.rehearsalId}/finish`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(finish.status).toBe(202);
    const finishBody = (await finish.json()) as { data: { jobId: string } };
    await ensureAiJobDone(cookie, finishBody.data.jobId);

    detail = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/rehearsals/${created.data.rehearsalId}`, { headers: { cookie } });
    const finalBody = (await detail.json()) as { data: { status: string; turns: Array<{ kind: string }> } };
    expect(finalBody.data.status).toBe('finished');
    expect(finalBody.data.turns.map((t) => t.kind)).toEqual(['question', 'answer', 'followup', 'summary']);

    const cancelFinished = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/rehearsals/${created.data.rehearsalId}`, { method: 'DELETE', headers: { cookie } });
    expect(cancelFinished.status).toBe(409);
    await cancelFinished.text();

    // 已结束的演练不能再答题
    const again = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/rehearsals/${created.data.rehearsalId}/answers`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ content: '再答一次' }),
    });
    expect(again.status).toBe(409);
  });

  it('取消未结束答辩会停止作业并删除问答和评分草稿', async () => {
    vi.stubGlobal('fetch', compatibleGatewayMock());
    const { owner, pid, materialVersionId } = await setup();
    const cookie = authCookie(owner.token);
    const create = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/rehearsals`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'all', materialVersionIds: [materialVersionId] }),
    });
    expect(create.status).toBe(202);
    const created = (await create.json() as { data: { rehearsalId: string; jobId: string } }).data;
    const activeJobId = crypto.randomUUID(), createdAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,attempts,created_by,created_at,updated_at) VALUES(?1,?2,'rehearsal_turn','running',?3,1,?4,?5,?5)").bind(activeJobId,pid,JSON.stringify({rehearsalId:created.rehearsalId,projectId:pid,phase:'followup'}),owner.userId,createdAt),
      env.DB.prepare('UPDATE rehearsals SET processing_job_id=?2 WHERE id=?1').bind(created.rehearsalId,activeJobId),
      env.DB.prepare("INSERT INTO job_outbox(id,job_id,status,available_at,attempts,created_at,updated_at) VALUES(?1,?2,'dispatched',?3,1,?3,?3)").bind(crypto.randomUUID(),activeJobId,createdAt),
      env.DB.prepare("INSERT INTO usage_reservations(id,project_id,job_id,purpose,status,max_calls,created_at) VALUES(?1,?2,?3,'rehearsal_turn','reserved',24,?4)").bind(crypto.randomUUID(),pid,activeJobId,createdAt),
    ]);
    const standard = await env.DB.prepare('SELECT id FROM standards_versions WHERE project_id=?1 AND status=\'confirmed\' ORDER BY version DESC LIMIT 1').bind(pid).first<{id:string}>();
    await env.DB.prepare("INSERT INTO assessments(id,project_id,kind,entity_id,goal_revision,standards_version_id,inputs_json,status,job_id,created_by,created_at) VALUES(?1,?2,'rehearsal',?3,?4,?5,'{}','active',?6,?7,?8)")
      .bind(crypto.randomUUID(),pid,created.rehearsalId,1,standard!.id,activeJobId,owner.userId,createdAt).run();

    const cancelled = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/rehearsals/${created.rehearsalId}`, { method: 'DELETE', headers: { cookie } });
    expect(cancelled.status).toBe(200);
    expect((await cancelled.json() as { data: { cancelled: boolean } }).data.cancelled).toBe(true);
    expect(await env.DB.prepare('SELECT id FROM rehearsals WHERE id=?1').bind(created.rehearsalId).first()).toBeNull();
    expect(await env.DB.prepare('SELECT id FROM rehearsal_turns WHERE rehearsal_id=?1').bind(created.rehearsalId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM assessments WHERE entity_id=?1 AND kind='rehearsal'").bind(created.rehearsalId).first()).toBeNull();
    expect((await env.DB.prepare('SELECT status FROM jobs WHERE id=?1').bind(activeJobId).first<{status:string}>())?.status).toBe('cancelled');
    expect((await env.DB.prepare('SELECT status FROM job_outbox WHERE job_id=?1').bind(activeJobId).first<{status:string}>())?.status).toBe('failed');
    expect((await env.DB.prepare('SELECT status FROM usage_reservations WHERE job_id=?1').bind(activeJobId).first<{status:string}>())?.status).toBe('released');

    // A late worker invocation must not revive or persist the deleted rehearsal.
    await runAiJob(env, activeJobId);
    expect(await env.DB.prepare('SELECT id FROM rehearsals WHERE id=?1').bind(created.rehearsalId).first()).toBeNull();
  });
});
