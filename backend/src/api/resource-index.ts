import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { requireUser, requireProjectMember } from '../core/auth';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { assertToolAccess } from '../services/project-ai-tools';
import { getResourceIndex, searchResource, readResourceSection } from '../services/resource-index';

const params=z.object({projectId:z.string().uuid(),resourceType:z.enum(['source','material']),versionId:z.string().uuid()});
const paging=z.object({offset:z.coerce.number().int().min(0).max(1000000).default(0)});
const indexEntry=z.object({sectionId:z.string(),seq:z.number(),heading:z.string(),pageNumber:z.number().nullable(),startOffset:z.number(),endOffset:z.number()});
const base=z.object({untrustedData:z.literal(true),resourceType:z.enum(['source','material']),versionId:z.string(),resourceId:z.string(),title:z.string(),revision:z.number(),coverage:z.string()});
const indexResponse=apiEnvelope(base.extend({directoryOnly:z.literal(true),indexStatus:z.string(),items:z.array(indexEntry),nextOffset:z.number().nullable()}),'ResourceIndexResponse');
const searchResponse=apiEnvelope(base.extend({directoryOnly:z.literal(true),indexStatus:z.string(),items:z.array(indexEntry.omit({seq:true,endOffset:true}).extend({excerpt:z.string()})),nextOffset:z.number().nullable()}),'ResourceIndexSearchResponse');
const readResponse=apiEnvelope(base.extend({sectionId:z.string(),offset:z.number(),nextOffset:z.number().nullable(),text:z.string().optional(),fragments:z.array(z.object({fragmentId:z.string(),pageNumber:z.number().nullable(),quote:z.string()})).optional()}),'ResourceSectionResponse');
export const resourceIndexApi=new OpenAPIHono<AppEnv>();
resourceIndexApi.use('*',requireUser,requireProjectMember());
const path='/projects/{projectId}/resource-index/{resourceType}/{versionId}';
resourceIndexApi.openapi(createRoute({method:'get',path,request:{params,query:paging},responses:{200:{description:'固定版本内部目录及覆盖状态',content:{'application/json':{schema:indexResponse}}}}}),async c=>{
 const p=c.req.valid('param'),q=c.req.valid('query'),context={projectId:p.projectId,userId:c.get('user')!.id};await assertToolAccess(c.env,context);
 const result=await getResourceIndex(c.env,p.projectId,p,q.offset);await assertToolAccess(c.env,context);return c.json(apiData(c,indexResponse.shape.data.parse(result)),200);
});
resourceIndexApi.openapi(createRoute({method:'get',path:path+'/search',request:{params,query:paging.extend({query:z.string().trim().min(1).max(200)})},responses:{200:{description:'资料内部检索，摘录不算读取原文',content:{'application/json':{schema:searchResponse}}}}}),async c=>{
 const p=c.req.valid('param'),q=c.req.valid('query'),context={projectId:p.projectId,userId:c.get('user')!.id};await assertToolAccess(c.env,context);
 const result=await searchResource(c.env,p.projectId,p,q.query,q.offset);await assertToolAccess(c.env,context);return c.json(apiData(c,searchResponse.shape.data.parse(result)),200);
});
resourceIndexApi.openapi(createRoute({method:'get',path:path+'/section',request:{params,query:paging.extend({sectionId:z.string().min(1).max(200),neighbors:z.enum(['true','false']).default('false')})},responses:{200:{description:'读取实际原文供引用',content:{'application/json':{schema:readResponse}}}}}),async c=>{
 const p=c.req.valid('param'),q=c.req.valid('query'),context={projectId:p.projectId,userId:c.get('user')!.id};await assertToolAccess(c.env,context);
 const result=await readResourceSection(c.env,p.projectId,p,q.sectionId,q.offset,q.neighbors==='true');await assertToolAccess(c.env,context);return c.json(apiData(c,readResponse.shape.data.parse(result)),200);
});
