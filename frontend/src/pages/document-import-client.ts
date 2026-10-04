import { request,projectPath } from '../api/client';
import type { RequestOptions } from '../api/client';
export async function documentRequest<T>(path:string,options:RequestOptions={}):Promise<T> {
 return await request<'FileInitResponse'>(path,{...options,networkOnly:true}) as unknown as T;
}
export async function uploadMultipartFile(projectId:string,fileId:string,file:File,signal?:AbortSignal,onProgress?:(message:string)=>void) {
 const path=projectPath(projectId,`/files/${fileId}/uploads`);
 const init=await documentRequest<{sessionId:string;partBytes:number}>(path,{method:'POST',body:{sizeBytes:file.size},signal});
 const status=await documentRequest<{status:string;parts:Array<{partNumber:number;sizeBytes:number}>}>(path+'/'+init.sessionId,{signal});
 if(status.status==='complete')return;
 const done=new Set(status.parts.map(p=>p.partNumber));
 for(let offset=0,part=1;offset<file.size;offset+=init.partBytes,part++) {
  if(done.has(part))continue;
  const piece=file.slice(offset,offset+init.partBytes);
  onProgress?.(`上传分片 ${part}/${Math.ceil(file.size/init.partBytes)}，可在失败后重试续传`);
  await documentRequest(path+'/'+init.sessionId+'/parts/'+part,{method:'PUT',rawBody:piece,headers:{'x-part-size':String(piece.size)},signal});
 }
 await documentRequest(path+'/'+init.sessionId+'/complete',{method:'POST',signal});
}
export async function importBrowserFile(projectId:string,sourceVersionId:string,file:File,signal?:AbortSignal,onProgress?:(message:string)=>void) {
 const path=projectPath(projectId,'/document-imports');
 const init=await documentRequest<{sessionId:string}>(path,{method:'POST',body:{sourceVersionId,method:/\.docx$/i.test(file.name)?'browser-docx':'browser-pdf'},signal});
 const state=await documentRequest<{nextBatch:number}>(path+'/'+init.sessionId,{signal});
 const {parseBrowserDocument}=await import('./browser-document');
 let batch=0;
 try {
  const result=await parseBrowserDocument(file,{signal,onBatch:async payload=>{
   // Transport chunks are intentionally bounded independently of document size.
   for(const block of payload.blocks) {
    const chars=Array.from(block.text);const pieces=chars.length?Math.ceil(chars.length/24000):1;
    for(let i=0;i<pieces;i++) {
     if(batch>=state.nextBatch)await documentRequest(path+'/'+init.sessionId+'/batches',{method:'POST',body:{batchNumber:batch,blocks:[{seq:block.seq,pageNumber:block.pageNumber,text:chars.slice(i*24000,(i+1)*24000).join(''),headingPath:block.headingPath?.slice(-10).map(h=>h.slice(0,200)),warnings:block.warnings?.slice(0,20).map(w=>(typeof w==='string'?w:w.message).slice(0,1000))}]},signal});
     batch++;
    }
   }
   onProgress?.(`本机解析已提交 ${batch} 批原文`);
  }});
  return await documentRequest<{textReady:boolean;needsImages:number;warnings:string[];status:string}>(path+'/'+init.sessionId+'/complete',{method:'POST',body:{totalPages:result.pages??null,warnings:summarizeWarnings(result.warnings.map(w=>typeof w==='string'?w:w.message)),partial:result.status==='partial',interrupted:result.warnings.some(w=>w.code==='parse-failed')},signal});
 } catch(error) {
  // Persist accepted text even on cancellation; a fresh explicit import can reread it.
  await documentRequest(path+'/'+init.sessionId+'/complete',{method:'POST',body:{totalPages:null,warnings:[error instanceof Error?error.message:'本机解析失败'],partial:true,interrupted:true}}).catch(()=>undefined);
  throw error;
 }
}

function summarizeWarnings(rows:string[]):string[] {return [...rows.slice(0,99).map(r=>r.slice(0,1000)),...(rows.length>99?[`还有 ${rows.length-99} 条解析警告，未读取范围请核对逐页状态。`]:[])];}
