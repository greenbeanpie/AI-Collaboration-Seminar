import { OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { notFound } from '../core/errors';
import { parsePaging, nextCursor } from '../core/pagination';
import { readTaskPage, readSubmissionPage } from '../services/collaboration-read-models';
import { toCollaborationTask, toProposal, type CollaborationTask, type Submission, type Proposal } from '../services/collaboration';
import { profileStamp } from '../services/personal-profiles';

type RouteRegistrar = (app: OpenAPIHono<AppEnv>,method:'get'|'post'|'patch',path:string,body:z.ZodType|undefined,handler:(c:Context<AppEnv>)=>Promise<Response>,status?:200|201|202)=>void;
const ids=(c:Context<AppEnv>)=>({projectId:c.req.param('projectId')!});
async function task(c:Context<AppEnv>) {
  const row=await c.env.DB.prepare('SELECT id FROM tasks WHERE id=?1 AND project_id=?2 AND archived_at IS NULL').bind(c.req.param('taskId'),ids(c).projectId).first();
  if(!row)throw notFound('协作任务不存在或已归档');
}

/** Read routes stay independent of mutations and AI orchestration. */
export function registerCollaborationReadRoutes(app:OpenAPIHono<AppEnv>,route:RouteRegistrar):void {
    route(app, 'get', '/tasks', undefined, async (c) => {
        const paging = parsePaging(c.req.query());
        const cursor = paging.cursor;
        const rows = await c.env.DB.prepare(`SELECT * FROM tasks WHERE project_id=?1 AND archived_at IS NULL
            AND (?2 IS NULL OR created_at < ?2 OR (created_at = ?2 AND id < ?3))
            AND (?5='' OR instr(lower(title),lower(?5))>0 OR instr(lower(detail),lower(?5))>0)
            AND (?6 IS NULL OR lifecycle_state=?6)
            AND (?7 IS NULL OR (EXISTS(SELECT 1 FROM task_submissions s WHERE s.id=tasks.current_submission_id AND s.task_id=tasks.id AND s.project_id=tasks.project_id AND tasks.status='done' AND tasks.lifecycle_state='accepted' AND s.status='accept' AND json_extract(s.ai_report_json,'$.humanReview.status')='pending'))=?7)
            ORDER BY created_at DESC,id DESC LIMIT ?4`)
            .bind(ids(c).projectId, cursor?.createdAt ?? null, cursor?.id ?? null, paging.limit + 1,c.req.query('q')?.trim()??'',c.req.query('lifecycleState')??null,c.req.query('pendingReview')===undefined?null:c.req.query('pendingReview')==='true'?1:0).all<CollaborationTask>();
        const page = rows.results.slice(0, paging.limit);
        const last = page.at(-1);
        const hydrated = await readTaskPage(c.env,page);
        return c.json(apiData(c, { items: page.map(row=>({...toCollaborationTask(row),...hydrated.get(row.id)})), nextCursor: nextCursor(rows.results.length > paging.limit, last ? { createdAt: last.created_at, id: last.id } : undefined) ?? null }));
    });
    route(app, 'get', '/tasks/{taskId}/submissions', undefined, async (c) => {
        await task(c);
        const paging=parsePaging(c.req.query()),cursor=paging.cursor;
        const rows=await c.env.DB.prepare(`SELECT * FROM task_submissions WHERE task_id=?1 AND project_id=?2 AND (?3 IS NULL OR round<?3 OR (round=?3 AND id<?4)) ORDER BY round DESC,id DESC LIMIT ?5`)
          .bind(c.req.param('taskId'),ids(c).projectId,cursor?Number(cursor.createdAt):null,cursor?.id??null,paging.limit+1).all<Submission>();
        const page=rows.results.slice(0,paging.limit),last=page.at(-1);
        return c.json(apiData(c,{items:await readSubmissionPage(c.env,ids(c).projectId,page),nextCursor:nextCursor(rows.results.length>paging.limit,last?{createdAt:String(last.round),id:last.id}:undefined)??null}));
    });
    route(app, 'get', '/proposals', undefined, async (c) => {
        const paging = parsePaging(c.req.query());
        const cursor = paging.cursor;
        const rows = await c.env.DB.prepare(`SELECT p.*,json_extract(j.input_json,'$.profileStamp') profile_stamp,EXISTS(SELECT 1 FROM collaboration_proposal_revisions correction WHERE correction.proposal_id=p.id) human_revised FROM collaboration_proposals p JOIN jobs j ON j.id=p.job_id WHERE p.project_id=?1
            AND (?2 IS NULL OR p.created_at < ?2 OR (p.created_at = ?2 AND p.id < ?3))
            ORDER BY p.created_at DESC,p.id DESC LIMIT ?4`)
            .bind(ids(c).projectId, cursor?.createdAt ?? null, cursor?.id ?? null, paging.limit + 1).all<Proposal & {profile_stamp:string|null;human_revised:number}>();
        const page = rows.results.slice(0, paging.limit);
        const last = page.at(-1);
        const currentStamp = await profileStamp(c.env, ids(c).projectId);
        return c.json(apiData(c, { items: page.map(p => p.kind === 'assign' && !p.human_revised && p.profile_stamp !== currentStamp ? {...toProposal(p),status:'stale',payload:{}} : toProposal(p)), nextCursor: nextCursor(rows.results.length > paging.limit, last ? { createdAt: last.created_at, id: last.id } : undefined) ?? null }));
    });
}
