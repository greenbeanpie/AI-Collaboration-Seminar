import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { requireUser } from '../core/auth';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { notFound, permissionDenied, versionConflict } from '../core/errors';
import { nowIso } from '../core/db';
import { nextCursor, parsePaging } from '../core/pagination';
import { consumePasswordRateLimit } from '../services/accounts';
import { ownProfile, publicProfile, type ProfileRow } from '../services/personal-profiles';

const visibility = z.object({ bio: z.boolean(), major: z.boolean(), specialties: z.boolean(), preferredRoles: z.boolean() }).strict();
const fields = { searchable: z.boolean(), aiUseAllowed: z.boolean(), bio: z.string().max(4000), major: z.string().max(160), specialties: z.string().max(800), preferredRoles: z.string().max(400), visibility };
const hours = z.number().min(0).max(168).nullable();
const importSelection = z.object({ candidateId: z.string().uuid(), fields: z.array(z.enum(['major', 'specialties', 'weeklyAvailableHours'])).min(1).max(3) }).strict();
const own = z.object({ ...fields, weeklyAvailableHours: hours, revision: z.number().int().min(0) });
const visible = z.object({ username: z.string(), displayName: z.string(), bio: z.string().optional(), major: z.string().optional(), specialties: z.string().optional(), preferredRoles: z.string().optional() });
const username = z.string().trim().min(3).max(32).regex(/^[A-Za-z0-9_-]+$/);
const getOwn = createRoute({ method: 'get', path: '/api/v1/auth/personal-profile', tags: ['profiles'], responses: { 200: { description: 'Own private profile', content: { 'application/json': { schema: apiEnvelope(own, 'PersonalProfileResponse') } } } } });
const putOwn = createRoute({ method: 'put', path: '/api/v1/auth/personal-profile', tags: ['profiles'], request: { body: { required: true, content: { 'application/json': { schema: z.object({ ...fields, weeklyAvailableHours: hours.optional(), legacyImports: z.array(importSelection).max(20).optional(), expectedRevision: z.number().int().min(0) }).strict() } } } }, responses: getOwn.responses });
const importCandidates = createRoute({ method: 'get', path: '/api/v1/auth/personal-profile/import-candidates', tags: ['profiles'],
  request: { query: z.object({ cursor: z.string().optional(), limit: z.string().optional() }).strict() },
  responses: { 200: { description: 'Only the account owner can read preserved legacy profile candidates', content: { 'application/json': { schema: apiEnvelope(z.object({
    items: z.array(z.object({ candidateId: z.string().uuid(), sourceProjectId: z.string(), sourceProjectName: z.string(), major: z.string(), skills: z.array(z.string()), weeklyAvailableHours: z.number().nullable(), importedAt: z.string().nullable(), createdAt: z.string() })), nextCursor: z.string().nullable(),
  }), 'PersonalProfileImportCandidatesResponse') } } } },
});
const search = createRoute({ method: 'get', path: '/api/v1/profiles/search', tags: ['profiles'], request: { query: z.object({ username, page: z.coerce.number().int().min(1).max(1).default(1) }).strict() }, responses: { 200: { description: 'Exact match only; zero or one result, no directory enumeration', content: { 'application/json': { schema: apiEnvelope(z.object({ items: z.array(z.object({ username: z.string(), displayName: z.string() })).max(1), nextCursor: z.null() }), 'ProfileSearchResponse') } } } } });
const getPublic = createRoute({ method: 'get', path: '/api/v1/profiles/{username}', tags: ['profiles'], request: { params: z.object({ username }) }, responses: { 200: { description: 'Only explicitly public fields, or null for unavailable profiles', content: { 'application/json': { schema: apiEnvelope(z.object({ profile: visible.nullable() }), 'PublicProfileResponse') } } } } });
export function registerPersonalProfileRoutes(app: OpenAPIHono<AppEnv>) {
  app.use('/api/v1/auth/personal-profile', requireUser);
  app.use('/api/v1/auth/personal-profile/*', requireUser);
  app.use('/api/v1/profiles/*', requireUser);
  const readOwn = (c: { env: AppEnv['Bindings'] }, userId: string) => c.env.DB.prepare('SELECT * FROM personal_profiles WHERE user_id=?1').bind(userId).first<ProfileRow>();
  app.openapi(getOwn, async c => c.json(apiData(c, ownProfile(await readOwn(c, c.get('user')!.id))), 200));
  app.openapi(importCandidates, async c => {
    const paging = parsePaging(c.req.valid('query'));
    const rows = await c.env.DB.prepare(`SELECT * FROM personal_profile_import_candidates WHERE user_id=?1
      AND (?2 IS NULL OR created_at<?2 OR (created_at=?2 AND id<?3)) ORDER BY created_at DESC,id DESC LIMIT ?4`)
      .bind(c.get('user')!.id, paging.cursor?.createdAt ?? null, paging.cursor?.id ?? null, paging.limit + 1)
      .all<{ id: string; source_project_id: string; source_project_name: string; major: string; skills_json: string; hours_per_week: number | null; created_at: string; imported_at: string | null }>();
    const page = rows.results.slice(0, paging.limit), last = page.at(-1);
    return c.json(apiData(c, { items: page.map(row => ({ candidateId: row.id, sourceProjectId: row.source_project_id, sourceProjectName: row.source_project_name,
      major: row.major, skills: JSON.parse(row.skills_json) as string[], weeklyAvailableHours: row.hours_per_week, importedAt: row.imported_at, createdAt: row.created_at })),
      nextCursor: nextCursor(rows.results.length > paging.limit, last ? { createdAt: last.created_at, id: last.id } : undefined) ?? null }), 200);
  });
  app.openapi(putOwn, async c => {
    if (c.req.header('X-Account-Settings') !== '1') throw permissionDenied();
    const id = c.get('user')!.id; const b = c.req.valid('json');
    await consumePasswordRateLimit(c.env, 'personal-profile-save', id, 30, 3600);
    const selections = b.legacyImports ?? [], candidateIds = [...new Set(selections.map(s => s.candidateId))];
    if (candidateIds.length) {
      const candidates = await c.env.DB.prepare('SELECT COUNT(*) n FROM personal_profile_import_candidates WHERE user_id=?1 AND id IN (SELECT value FROM json_each(?2))')
        .bind(id, JSON.stringify(candidateIds)).first<{ n: number }>();
      if (candidates?.n !== candidateIds.length) throw notFound('旧资料候选不存在');
    }
    const importedFields = new Set(selections.flatMap(s => s.fields));
    const importedPersonalText = importedFields.has('major') || importedFields.has('specialties');
    const now = nowIso();
    const statements = [c.env.DB.prepare(`INSERT INTO personal_profiles(user_id,searchable,bio,major,specialties,preferred_roles,bio_public,major_public,specialties_public,preferred_roles_public,revision,updated_at,ai_use_allowed,weekly_available_hours)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,1,?11,?13,?14
      WHERE (?12=0 OR EXISTS(SELECT 1 FROM personal_profiles WHERE user_id=?1))
        AND (SELECT COUNT(*) FROM personal_profile_import_candidates WHERE user_id=?1 AND id IN (SELECT value FROM json_each(?16)))=json_array_length(?16)
      ON CONFLICT(user_id) DO UPDATE SET searchable=excluded.searchable,bio=excluded.bio,major=excluded.major,specialties=excluded.specialties,
        preferred_roles=excluded.preferred_roles,bio_public=excluded.bio_public,major_public=excluded.major_public,specialties_public=excluded.specialties_public,
        preferred_roles_public=excluded.preferred_roles_public,revision=personal_profiles.revision+1,updated_at=excluded.updated_at,ai_use_allowed=excluded.ai_use_allowed,
        weekly_available_hours=CASE WHEN ?15=1 THEN excluded.weekly_available_hours ELSE personal_profiles.weekly_available_hours END
      WHERE personal_profiles.revision=?12`).bind(id,+b.searchable,b.bio,b.major,b.specialties,b.preferredRoles,+b.visibility.bio,
        +(importedFields.has('major') ? false : b.visibility.major), +(importedFields.has('specialties') ? false : b.visibility.specialties),+b.visibility.preferredRoles,
        now,b.expectedRevision,+(importedPersonalText ? false : b.aiUseAllowed),b.weeklyAvailableHours ?? null,+(b.weeklyAvailableHours !== undefined),JSON.stringify(candidateIds))];
    if (candidateIds.length) statements.push(c.env.DB.prepare(`UPDATE personal_profile_import_candidates SET imported_at=?3
      WHERE user_id=?1 AND id IN (SELECT value FROM json_each(?2)) AND changes()>0`).bind(id, JSON.stringify(candidateIds), now));
    const result = await c.env.DB.batch(statements);
    if (!result[0]?.meta.changes) throw versionConflict((await readOwn(c,id))?.revision ?? 0);
    return c.json(apiData(c, ownProfile(await readOwn(c,id))),200);
  });
  async function find(c: { env: AppEnv['Bindings'] }, value: string) {
    return c.env.DB.prepare(`SELECT p.*,a.username,u.display_name FROM auth_accounts a JOIN users u ON u.id=a.user_id JOIN personal_profiles p ON p.user_id=a.user_id WHERE a.username_norm=?1 AND p.searchable=1 AND a.password_hash IS NOT NULL LIMIT 1`).bind(value.toLowerCase()).first<ProfileRow & { username: string; display_name: string }>();
  }
  app.use('/api/v1/profiles/*', async (c,next) => {
    await consumePasswordRateLimit(c.env,'profile-search-user',c.get('user')!.id,30,60);
    await consumePasswordRateLimit(c.env,'profile-search-ip',c.req.header('cf-connecting-ip') ?? 'unknown',120,60);
    await next();
  });
  app.openapi(search, async c => { const row = await find(c,c.req.valid('query').username); return c.json(apiData(c,{items:row ? [{username:row.username,displayName:row.display_name}] : [], nextCursor:null}),200); });
  app.openapi(getPublic, async c => { const row = await find(c,c.req.valid('param').username); return c.json(apiData(c,{profile:row ? publicProfile(row) : null}),200); });
}
