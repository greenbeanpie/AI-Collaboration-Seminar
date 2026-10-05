import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { readMediaGrant } from '../services/media-fetch';

export function registerMediaFetchRoutes(app:OpenAPIHono<AppEnv>):void {
  const path='/api/v1/media-fetch/{jobId}';
  // Cache prohibition also covers malformed parameters rejected by OpenAPI validation.
  app.use('/api/v1/media-fetch/*',async(c,next)=>{c.header('Cache-Control','no-store');await next();});
  for(const method of ['get','head'] as const){
    app.openapi(createRoute({method,path,tags:['media'],summary:'活动 MiMo 任务的短期签名媒体读取',request:{params:z.object({jobId:z.string().uuid()})},responses:{200:{description:'媒体流或元数据'},206:{description:'媒体字节范围'},404:{description:'授权失效'},416:{description:'字节范围不可满足'}}}),async c=>readMediaGrant(c.env,c.req.raw,c.req.valid('param').jobId));
  }
}
