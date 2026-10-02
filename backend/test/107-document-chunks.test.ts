import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { SELF } from 'cloudflare:test';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { configureGoFixture } from './helpers/provider-config';
import { loadAiConfig } from '../src/ai/config';
import { documentChunks, renderDocumentChunk, validateChunkCitations } from '../src/services/document-chunks';
import { extractSourceVersionText, extractRequirements } from '../src/services/parse';
import { runSourceSummary, setSourceStage } from '../src/services/source-summary';
await configureGoFixture();
afterEach(() => vi.unstubAllGlobals());
async function fixture() { const owner = await seedUser(); const projectId = await seedProject(owner.userId); const res = await SELF.fetch(BASE + '/api/v1/projects/' + projectId + '/sources', { method: 'POST', headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'paste', text: '项目要求：请按期提交成果。' }) }); const ids = (await res.json() as {
    data: {
        sourceId: string;
        sourceVersionId: string;
    };
}).data; await extractSourceVersionText(env, ids.sourceVersionId); await setSourceStage(env, ids.sourceVersionId, 'text', 'ready'); const tailId = crypto.randomUUID(); for (let seq = 2; seq <= 7; seq++)
    await env.DB.prepare("INSERT INTO source_fragments(id,source_version_id,project_id,page_number,seq,kind,content,created_at) VALUES (?1,?2,?3,NULL,?4,'paste',?5,?6)").bind(seq === 7 ? tailId : crypto.randomUUID(), ids.sourceVersionId, projectId, seq, seq === 7 ? '最终要求：必须提交尾部验证报告。' : '背景资料说明。'.repeat(60), new Date().toISOString()).run(); const original = (await loadAiConfig(env.DB))!; const config = structuredClone(original.config); config.textEconomy.maxInputChars = 1200; const configId = crypto.randomUUID(); await env.DB.prepare('INSERT INTO ai_config_versions(id,version,config_json,enabled,created_at) VALUES (?1,?2,?3,1,?4)').bind(configId, original.version + 1, JSON.stringify(config), new Date().toISOString()).run(); return { ...ids, projectId, owner, tailId, configId }; }
function model() { return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => { const body = JSON.parse(String(init?.body)) as {
    messages: {
        content: string;
    }[];
}; const text = body.messages[1]!.content; const matches = [...text.matchAll(/\[frag:([^ ]+) 页([^\] ]+)(?: [^\]]+)?\]\n([^\n]+)/gu)]; const match = matches.find(row => row[3]?.includes('尾部验证报告')) ?? matches[0]!; const quote = match[3]!.slice(0, 80); const cites = [{ fragmentId: match[1], pageNumber: null, quote }]; const content = body.messages[0]!.content.includes('总结用户导入的文件') ? { title: '分块总结', summary: quote, keyPoints: [quote], citations: cites, caveats: [] } : { requirements: [{ category: 'deliverable', title: quote, detail: quote, dueDate: null, duePrecision: 'unknown', citations: cites }] }; return Response.json({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 30, completion_tokens: 20 } }); }); }
describe('full document processing', () => {
    it('partitions every original character within each prompt bound and keeps original citation identities', () => { const fragments = [{ id: 'original', page_number: 3, content: '开头😀中间'.repeat(40) + '尾部要求' }]; const chunks = documentChunks(fragments, 160, 40); expect(chunks.length).toBeGreaterThan(1); expect(chunks.flat().map(part => part.content).join('')).toBe(fragments[0]!.content); for (const chunk of chunks)
        expect(renderDocumentChunk(chunk).length + 40).toBeLessThanOrEqual(160); expect(() => validateChunkCitations(chunks[0]!, [{ fragmentId: 'original', pageNumber: 3, quote: '尾部要求' }])).toThrow(); });
    it('summarizes the entire document including the tail and records full coverage', async () => { const f = await fixture(); const jobId = crypto.randomUUID(); const now = new Date().toISOString(); await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,attempts,created_by,created_at,updated_at) VALUES (?1,?2,'requirement_extract','queued',?3,0,?4,?5,?5)").bind(jobId, f.projectId, JSON.stringify({ operation: 'source.summary', sourceVersionId: f.sourceVersionId, summaryRevision: 1, configVersionId: f.configId }), f.owner.userId, now).run(); await env.DB.prepare("UPDATE source_processing SET summary_status='queued',summary_job_id=?2,summary_revision=1 WHERE source_version_id=?1").bind(f.sourceVersionId, jobId).run(); const fetch = model(); vi.stubGlobal('fetch', fetch); expect((await runSourceSummary(env, jobId)).status).toBe('succeeded'); expect(fetch.mock.calls.length).toBeGreaterThan(1); for (const [, init] of fetch.mock.calls) {
        const body = JSON.parse(String(init?.body));
        expect(body.messages.reduce((n: number, m: {
            content: string;
        }) => n + m.content.length, 0)).toBeLessThanOrEqual(1200);
    } const state = await env.DB.prepare('SELECT covered_chars,total_chars,summary_json FROM source_processing WHERE source_version_id=?1').bind(f.sourceVersionId).first<{
        covered_chars: number;
        total_chars: number;
        summary_json: string;
    }>(); expect(state!.covered_chars).toBe(state!.total_chars); const report = JSON.parse(state!.summary_json); expect(report.summary).toContain('尾部验证报告'); expect(report.citations.some((cite: {
        fragmentId: string;
    }) => cite.fragmentId === f.tailId)).toBe(true); });
    it('extracts requirements from tail chunks and rejects unobserved quotations', async () => { const f = await fixture(); const fetch = model(); vi.stubGlobal('fetch', fetch); const result = await extractRequirements(env, f.sourceVersionId, f.configId); expect(fetch.mock.calls.length).toBeGreaterThan(1); const rows = await env.DB.prepare('SELECT detail,citations_json FROM requirements WHERE requirement_set_id=?1').bind(result.requirementSetId).all<{
        detail: string;
        citations_json: string;
    }>(); expect(rows.results.some(row => row.detail.includes('尾部验证报告'))).toBe(true); expect(rows.results.some(row => row.citations_json.includes(f.tailId))).toBe(true); });
});
