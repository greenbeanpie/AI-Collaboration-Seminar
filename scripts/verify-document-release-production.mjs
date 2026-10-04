import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const mammoth=require('mammoth');
assert(process.argv.includes('--production'),'Explicit --production required');
const saved=JSON.parse(readFileSync(new URL('../.local-secrets/document-production-session.json',import.meta.url),'utf8'));
assert(['https://team.greenbp.dpdns.org','https://greenbp-team-office.hddhp.workers.dev'].includes(saved.origin));
mkdirSync('output/document-release',{recursive:true});
const report={commit:'141d831',checks:[],requests:[],ocr:null,limitations:[],projectId:null};
let project;
async function call(path,method='GET',body,headers={}) {
 const start=Date.now(),r=await fetch(saved.origin+'/api/v1'+path,{method,headers:{cookie:saved.cookie,origin:saved.origin,...(body&&!(body instanceof Uint8Array)?{'content-type':'application/json'}:{}),...headers},body:body?body instanceof Uint8Array?body:JSON.stringify(body):undefined});
 const value=await r.json();report.requests.push({path,method,status:r.status,elapsedMs:Date.now()-start});
 if(!r.ok)throw new Error(`${method} ${path}: ${r.status} ${value.error?.code??'HTTP_ERROR'}`);return value.data;
}
async function upload(name,bytes,multipart=false,derivedFromFileId) {
 const init=await call(`/projects/${project.id}/files`,'POST',{fileName:name,...(derivedFromFileId?{derivedFromFileId}:{})});
 if(multipart){const path=`/projects/${project.id}/files/${init.fileId}/uploads`,u=await call(path,'POST',{sizeBytes:bytes.length});await call(`${path}/${u.sessionId}/parts/1`,'PUT',bytes,{'x-part-size':String(bytes.length)});await call(`${path}/${u.sessionId}/complete`,'POST');}
 else await call(`/projects/${project.id}/files/${init.fileId}/content`,'PUT',bytes);
 return init.fileId;
}
try {
 const health=await call('/health');assert(health);
 const deps=await call('/health/deps');assert(deps);
 const caps=await call('/capabilities');assert.equal(caps.limits.maxFileBytes,null);assert.equal(caps.limits.maxPdfPages,null);report.checks.push('health/dependencies/null-capabilities');
 project=await call('/projects','POST',{name:'文档解析发布验收 · 临时项目',description:'只包含合成验收资料，完成后归档',aiCollaborationEnabled:false,planningMode:'manual',assignmentMode:'manual',evaluationMode:'manual',progressionMode:'manual'});report.projectId=project.id;
 const docBytes=new Uint8Array(readFileSync('frontend/src/pages/__fixtures__/semantic.docx'));
 const file=await upload('语义验收.docx',docBytes,true);
 const range=await fetch(saved.origin+`/api/v1/projects/${project.id}/files/${file}/content`,{headers:{cookie:saved.cookie,range:'bytes=0-3'}});assert.equal(range.status,206);assert.equal(range.headers.get('cache-control'),'no-store');assert.equal(new Uint8Array(await range.arrayBuffer())[0],80);report.checks.push('private-multipart/docx-package/range');
 const source=await call(`/projects/${project.id}/sources`,'POST',{kind:'file',fileId:file,title:'DOCX解析验收'});
 const parsed=await mammoth.extractRawText({buffer:Buffer.from(docBytes)});
 const paragraphs=parsed.value.split(/\n{2,}/).filter(Boolean),blocks=paragraphs.map((text,seq)=>({seq,pageNumber:null,text,headingPath:['Chapter']}));
 const base=`/projects/${project.id}/document-imports`,session=await call(base,'POST',{sourceVersionId:source.sourceVersionId,method:'browser-docx'});
 await call(`${base}/${session.sessionId}/batches`,'POST',{batchNumber:0,blocks});
 const finish=await call(`${base}/${session.sessionId}/complete`,'POST',{totalPages:null,partial:parsed.messages.length>0,warnings:parsed.messages.map(m=>m.message).slice(0,100)});assert.equal(finish.textReady,true);
 const indexPath=`/projects/${project.id}/resource-index/source/${source.sourceVersionId}`,index=await call(indexPath);assert(index.items.length);assert(index.items.every(i=>i.pageNumber===null));
 const search=await call(indexPath+'/search?query=Alice');assert(search.items.length);
 const section=await call(indexPath+'/section?sectionId='+encodeURIComponent(search.items[0].sectionId)+'&neighbors=true');assert(section.fragments.some(f=>f.quote.includes('Alice')));report.checks.push('docx-text/null-pages/headings/search/original-citations');
 const pdf=await upload('扫描验收.pdf',new Uint8Array(readFileSync('output/document-release/scan.pdf')));
 const scan=await call(`/projects/${project.id}/sources`,'POST',{kind:'file',fileId:pdf,title:'扫描OCR验收'});
 const extract=await call(base+'/extract','POST',{sourceVersionId:scan.sourceVersionId});
 async function waitJob(id){for(let i=0;i<15;i++){const job=await call(`/jobs/${id}`);if(['succeeded','failed','waiting_input','cancelled'].includes(job.status))return job;await new Promise(resolve=>setTimeout(resolve,4000));}return {status:'unconfirmed'};}
 const extracted=await waitJob(extract.jobId);assert.equal(extracted.status,'waiting_input');report.checks.push('scan-detection-without-model');
 const images=[];for(let pageNumber=1;pageNumber<=3;pageNumber++)images.push({pageNumber,fileId:await upload(`扫描页${pageNumber}.png`,new Uint8Array(readFileSync(`output/document-release/ocr-${pageNumber}.png`)),false,pdf)});
 const ocr=await call(`/projects/${project.id}/sources/${scan.sourceId}/page-images`,'POST',{sourceVersionId:scan.sourceVersionId,images,analyze:false});
 const result=ocr.jobId?await waitJob(ocr.jobId):{status:'waiting_input'};report.ocr={jobId:ocr.jobId,status:result.status,error:result.error??null};
 if(result.status==='succeeded')report.checks.push('live-ocr');else report.limitations.push('Live OCR did not complete: '+result.status+' '+(result.error?.code??''));
} finally {
 if(project){const current=await call(`/projects/${project.id}`);await call(`/projects/${project.id}`,'PATCH',{expectedRevision:current.revision,status:'archived'});report.checks.push('temporary-project-archived');}
 writeFileSync('output/document-release/production-verification.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify({checks:report.checks,ocr:report.ocr,limitations:report.limitations,requests:report.requests.length}));
}
