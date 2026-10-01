import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { newId, nowIso } from '../src/core/db';

describe('collaboration list pagination', () => {
    it('returns every task and proposal past the former caps, including timestamp ties, without duplicates', async () => {
        const user = await seedUser();
        const projectId = await seedProject(user.userId);
        const timestamp = nowIso();
        const taskIds: string[] = [];
        const proposalIds: string[] = [];
        const statements: D1PreparedStatement[] = [];
        for (let index = 0; index < 205; index++) {
            const id = newId();
            taskIds.push(id);
            statements.push(env.DB.prepare(`INSERT INTO tasks(id,project_id,title,detail,status,revision,created_by,created_at,updated_at,lifecycle_state,criteria,effort_hours)
                VALUES(?1,?2,?3,'','todo',1,?4,?5,?5,'open','test',1)`)
                .bind(id, projectId, `Task ${index}`, user.userId, timestamp));
        }
        for (let index = 0; index < 107; index++) {
            const jobId = newId();
            const id = newId();
            proposalIds.push(id);
            statements.push(env.DB.prepare(`INSERT INTO jobs(id,project_id,kind,status,input_json,attempts,created_at,updated_at)
                VALUES(?1,?2,'agent_run','succeeded','{}',0,?3,?3)`).bind(jobId, projectId, timestamp));
            statements.push(env.DB.prepare(`INSERT INTO collaboration_proposals(id,project_id,kind,job_id,payload_json,settings_revision,created_at,updated_at)
                VALUES(?1,?2,'decompose',?3,'{"tasks":[]}',1,?4,?4)`).bind(id, projectId, jobId, timestamp));
        }
        for (let index = 0; index < statements.length; index += 50) {
            await env.DB.batch(statements.slice(index, index + 50));
        }
        for (const [resource, idField, expected] of [
            ['tasks', 'taskId', taskIds],
            ['proposals', 'proposalId', proposalIds],
        ] as const) {
            const seen: string[] = [];
            let cursor: string | null = null;
            let pages = 0;
            do {
                const url = new URL(`${BASE}/api/v1/projects/${projectId}/collaboration/${resource}`);
                url.searchParams.set('limit', '37');
                if (cursor) url.searchParams.set('cursor', cursor);
                const response = await SELF.fetch(url, { headers: { cookie: authCookie(user.token) } });
                expect(response.status).toBe(200);
                const { data } = await response.json() as { data: { items: Record<string, unknown>[]; nextCursor: string | null } };
                expect(data.items.length).toBeLessThanOrEqual(37);
                seen.push(...data.items.map(item => String(item[idField])));
                cursor = data.nextCursor;
                expect(++pages).toBeLessThan(10);
            } while (cursor);
            expect(seen).toEqual([...expected].sort().reverse());
            expect(new Set(seen).size).toBe(expected.length);
        }
    });
    it('returns an explicit null cursor on empty lists', async () => {
        const user = await seedUser();
        const projectId = await seedProject(user.userId);
        for (const resource of ['tasks', 'proposals']) {
            const response = await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/collaboration/${resource}?limit=2`, { headers: { cookie: authCookie(user.token) } });
            expect((await response.json() as { data: unknown }).data).toEqual({ items: [], nextCursor: null });
        }
    });
});
