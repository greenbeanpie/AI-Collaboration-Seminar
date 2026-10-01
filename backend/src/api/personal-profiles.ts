import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { requireUser } from '../core/auth';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { permissionDenied, versionConflict } from '../core/errors';
import { nowIso } from '../core/db';
import { consumePasswordRateLimit } from '../services/accounts';
import { ownProfile, publicProfile, type ProfileRow } from '../services/personal-profiles';

const visibility = z.object({ bio: z.boolean(), major: z.boolean(), specialties: z.boolean(), preferredRoles: z.boolean() }).strict();
const fields = { searchable: z.boolean(), bio: z.string().max(4000), major: z.string().max(160), specialties: z.string().max(800), preferredRoles: z.string().max(400), visibility };
const own = z.object({ ...fields, revision: z.number().int().min(0) });
const visible = z.object({ username: z.string(), displayName: z.string(), bio: z.string().optional(), major: z.string().optional(), specialties: z.string().optional(), preferredRoles: z.string().optional() });
const username = z.string().trim().min(3).max(32).regex(/^[A-Za-z0-9_-]+$/);
const getOwn = createRoute({ method: 'get', path: '/api/v1/auth/personal-profile', tags: ['profiles'], responses: { 200: { description: 'Own private profile', content: { 'application/json': { schema: apiEnvelope(own, 'PersonalProfileResponse') } } } } });
const putOwn = createRoute({ method: 'put', path: '/api/v1/auth/personal-profile', tags: ['profiles'], request: { body: { required: true, content: { 'application/json': { schema: z.object({ ...fields, expectedRevision: z.number().int().min(0) }).strict() } } } }, responses: getOwn.responses });
const search = createRoute({ method: 'get', path: '/api/v1/profiles/search', tags: ['profiles'], request: { query: z.object({ username, page: z.coerce.number().int().min(1).max(1).default(1) }).strict() }, responses: { 200: { description: 'Exact match only; zero or one result, no directory enumeration', content: { 'application/json': { schema: apiEnvelope(z.object({ items: z.array(z.object({ username: z.string(), displayName: z.string() })).max(1), nextCursor: z.null() }), 'ProfileSearchResponse') } } } } });
const getPublic = createRoute({ method: 'get', path: '/api/v1/profiles/{username}', tags: ['profiles'], request: { params: z.object({ username }) }, responses: { 200: { description: 'Only explicitly public fields, or null for unavailable profiles', content: { 'application/json': { schema: apiEnvelope(z.object({ profile: visible.nullable() }), 'PublicProfileResponse') } } } } });
export function registerPersonalProfileRoutes(app: OpenAPIHono<AppEnv>) {
  app.use('/api/v1/auth/personal-profile', requireUser);
  app.use('/api/v1/profiles/*', requireUser);
  const readOwn = (c: { env: AppEnv['Bindings'] }, userId: string) => c.env.DB.prepare('SELECT * FROM personal_profiles WHERE user_id=?1').bind(userId).first<ProfileRow>();
  app.openapi(getOwn, async c => c.json(apiData(c, ownProfile(await readOwn(c, c.get('user')!.id))), 200));
  app.openapi(putOwn, async c => {
    if (c.req.header('X-Account-Settings') !== '1') throw permissionDenied();
    const id = c.get('user')!.id; const b = c.req.valid('json');
    await consumePasswordRateLimit(c.env, 'personal-profile-save', id, 30, 3600);
    const result = await c.env.DB.prepare(`INSERT INTO personal_profiles(user_id,searchable,bio,major,specialties,preferred_roles,bio_public,major_public,specialties_public,preferred_roles_public,revision,updated_at)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,1,?11 WHERE ?12=0
      ON CONFLICT(user_id) DO NOTHING`).bind(id,+b.searchable,b.bio,b.major,b.specialties,b.preferredRoles,+b.visibility.bio,+b.visibility.major,+b.visibility.specialties,+b.visibility.preferredRoles,nowIso(),b.expectedRevision).run();
    if (!result.meta.changes) {
      const updated = await c.env.DB.prepare(`UPDATE personal_profiles SET searchable=?2,bio=?3,major=?4,specialties=?5,preferred_roles=?6,bio_public=?7,major_public=?8,specialties_public=?9,preferred_roles_public=?10,revision=revision+1,updated_at=?11 WHERE user_id=?1 AND revision=?12`)
        .bind(id,+b.searchable,b.bio,b.major,b.specialties,b.preferredRoles,+b.visibility.bio,+b.visibility.major,+b.visibility.specialties,+b.visibility.preferredRoles,nowIso(),b.expectedRevision).run();
      if (!updated.meta.changes) throw versionConflict((await readOwn(c,id))?.revision ?? 0);
    }
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
