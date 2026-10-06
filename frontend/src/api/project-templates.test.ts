import { afterEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { projectTemplateApi } from './project-templates';
import { creationFileHash } from '../pages/project-creation-workflow';
vi.mock('../pages/browser-document',()=>({parseBrowserDocument:vi.fn(async(_file:File,options:{onBatch:(batch:{blocks:Array<{seq:number;pageNumber:null;text:string;headingPath?:string[]}>})=>Promise<void>})=>{
 await options.onBatch({blocks:[{seq:0,pageNumber:null,text:'正文甲'.repeat(4000),headingPath:Array.from({length:7},()=> '章'.repeat(250))},{seq:1,pageNumber:null,text:'正文乙'.repeat(4000)},{seq:2,pageNumber:null,text:'末段'}]});
 return {status:'partial',blocks:3,warnings:Array.from({length:201},(_,i)=>({code:String(i),message:String(i)+'警告'.repeat(600)}))};
})}));
afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); });
it('reuses the same private file ID after a lost upload and reconciliation response, including a reselected File', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const file = new File(['original bytes'], 'original.txt', { type: 'text/plain' }); const sha256 = await creationFileHash(file);
  const paths: string[] = []; let first = true;
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'PUT') { const parsed = new URL(String(url), 'http://localhost'); paths.push(parsed.pathname); if (first) { first = false; throw new Error('uploaded but response lost'); } return Response.json({ requestId: 'replay', data: { revision: 2, files: [{ id: parsed.pathname.split('/').at(-1), name: file.name, sizeBytes: file.size, sha256 }] } }); }
    throw new Error('reconciliation unavailable');
  }));
  await expect(projectTemplateApi.upload('owner', 'draft', 1, file)).rejects.toThrow();
  const reselected = new File(['original bytes'], 'original.txt', { type: 'text/plain' });
  const response = await projectTemplateApi.upload('owner', 'draft', 1, reselected);
  expect(paths).toHaveLength(2); expect(new Set(paths).size).toBe(1); expect(response.files).toHaveLength(1); expect(response.revision).toBe(2);
});
it.each(['docx','xlsx','pptx'])('uploads %s as streamed parts and splits client text batches without hashing the whole original',async(extension)=>{
 vi.stubGlobal('crypto',webcrypto);
 const file=new File(['fake fixture bytes'],`资料.${extension}`,{lastModified:1}),calls:Array<{path:string;body:unknown}>=[];
 vi.stubGlobal('fetch',vi.fn(async(url:unknown,init?:RequestInit)=>{
  const path=String(url);calls.push({path,body:init?.body});
  if(path.endsWith('/multipart')&&init?.method==='POST')return Response.json({requestId:'x',data:{partBytes:8*1024*1024,status:'uploading'}});
  if(path.endsWith('/multipart/1'))return Response.json({requestId:'x',data:{status:'uploading'}});
  if(path.endsWith('/multipart/complete'))return Response.json({requestId:'x',data:{revision:2,files:[]}});
  if(path.endsWith('/imports/complete'))return Response.json({requestId:'x',data:{revision:3,files:[]}});
  if(path.endsWith('/imports'))return Response.json({requestId:'x',data:{accepted:1}});
  throw new Error(path);
 }));
 expect((await projectTemplateApi.upload('owner','draft',1,file)).revision).toBe(3);
 expect(calls.find(c=>c.path.endsWith('/multipart/1'))?.body).toBeInstanceOf(Blob);
 const batches=calls.filter(c=>c.path.endsWith('/imports')).map(c=>JSON.parse(String(c.body)) as {blocks:Array<{seq:number;text:string}>});
 expect(batches).toHaveLength(2);expect(batches.flatMap(b=>b.blocks).map(b=>b.seq)).toEqual([0,1,2]);
 expect(batches.every(b=>b.blocks.reduce((n,c)=>n+c.text.length,0)<=24000)).toBe(true);
 const complete=JSON.parse(String(calls.find(c=>c.path.endsWith('/imports/complete'))?.body)) as {warnings:string[]};expect(complete.warnings).toHaveLength(100);expect(complete.warnings.every(w=>w.length<=1000)).toBe(true);
});
