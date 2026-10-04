import { mkdir, readFile, writeFile, rename, realpath, lstat, open, unlink } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, basename, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const terminal = new Set(['ready_for_review','cancelled','failed','blocked']);
export function safeId(id) { if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new Error('Invalid handoff identity'); return id; }
export function safePath(root, path) {
  if (typeof path !== 'string' || !path || /[\x00-\x1f]/.test(path) || path.includes(':') || path.includes('\\') || isAbsolute(path) || path.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Unsafe input path');
  const result = resolve(root, path); const rel = relative(root, result);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Path escapes run directory');
  return result;
}
export async function readArtifact(root, path, maxBytes = 50 * 1024 * 1024) {
  const target = safePath(root, path);
  if (path.split('/').some(p => /^\.(env|git|credentials)(\.|$)/i.test(p) || /^(credentials|secrets?)\.(json|ya?ml)$/i.test(p))) throw new Error('Sensitive file cannot be uploaded');
  const canonicalRoot = await realpath(root); if(canonicalRoot.toLowerCase()!==resolve(root).toLowerCase())throw new Error('Output directory is redirected'); let cursor = root;
  for (const p of path.split('/')) { cursor = join(cursor, p); if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Symbolic links cannot be uploaded'); }
  const canonical = await realpath(target); const rel = relative(canonicalRoot, canonical);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Artifact escapes output directory');
  const file = await open(target, 'r');
  try { const stat = await file.stat(); if (!stat.isFile() || stat.size > maxBytes) throw new Error('Artifact is not a regular file within upload limit'); const bytes = await file.readFile(); if (bytes.length > maxBytes) throw new Error('Artifact grew beyond upload limit'); return { bytes, name: basename(path), sizeBytes: bytes.length, sha256: hash(bytes) }; }
  finally { await file.close(); }
}
export async function inputTarget(root,path){const target=safePath(root,path);if((await realpath(root)).toLowerCase()!==resolve(root).toLowerCase())throw new Error('Input root is redirected');let cursor=root;for(const segment of path.split('/').slice(0,-1)){cursor=join(cursor,segment);await mkdir(cursor,{recursive:true});if((await lstat(cursor)).isSymbolicLink()||(await realpath(cursor)).toLowerCase()!==resolve(cursor).toLowerCase())throw new Error('Input directory is redirected');}try{const existing=await lstat(target);if(existing.isSymbolicLink()||!existing.isFile())throw new Error('Input file is redirected');}catch(e){if(e.code!=='ENOENT')throw e;}return target;}
export async function digestFile(path){const file=await open(path,'r');const sha=createHash('sha256'),buffer=Buffer.allocUnsafe(65536);let size=0;try{if(!(await file.stat()).isFile())throw new Error('Input is not a regular file');for(;;){const {bytesRead}=await file.read(buffer,0,buffer.length,null);if(!bytesRead)break;size+=bytesRead;sha.update(buffer.subarray(0,bytesRead));}return{sizeBytes:size,sha256:sha.digest('hex')};}finally{await file.close();}}
export async function writeInput(root,path,bytes){const target=await inputTarget(root,path);try{const current=await digestFile(target);if(current.sizeBytes!==bytes.length||current.sha256!==hash(bytes))throw new Error('Existing input does not match snapshot');}catch(e){if(e.code!=='ENOENT')throw e;await writeFile(target,bytes,{flag:'wx',mode:0o600});}}
export class Journal {
  constructor(dir) { this.dir = dir; this.state = { version: 1, bindings: {}, runs: {} }; this.writes = Promise.resolve(); }
  async load() { await mkdir(this.dir, {recursive:true}); try { this.state = JSON.parse(await readFile(join(this.dir,'state.json'),'utf8')); if (this.state.version !== 1 || !this.state.bindings || !this.state.runs) throw new Error('Invalid bridge journal'); } catch(e) { if(e.code !== 'ENOENT') throw e; } return this; }
  async acquire() { const file=join(this.dir,'owner.lock');try{this.lock=await open(file,'wx',0o600);await this.lock.writeFile(JSON.stringify({pid:process.pid}));}catch(e){if(e.code!=='EEXIST')throw e;const previous=JSON.parse(await readFile(file,'utf8'));try{process.kill(previous.pid,0);throw new Error('Bridge is already active in another DSH process');}catch(check){if(check.code!=='ESRCH')throw check;}await unlink(file);this.lock=await open(file,'wx',0o600);await this.lock.writeFile(JSON.stringify({pid:process.pid}));} }
  async release(){if(this.lock){await this.lock.close();this.lock=null;await unlink(join(this.dir,'owner.lock'));}}
  save() { const data = JSON.stringify(this.state); this.writes = this.writes.then(async () => { const temp=join(this.dir, 'state.tmp'); const file=await open(temp,'w',0o600);try{await file.writeFile(data);await file.sync();}finally{await file.close();} await rename(temp,join(this.dir,'state.json')); }); return this.writes; }
}
export async function boundedBytes(res,limit=52428800){if(!Number.isSafeInteger(limit)||limit<0||limit>52428800)throw new Error('Download exceeds bridge input limit');const declared=res.headers.get('content-length');if(declared&&Number(declared)>limit){await res.body?.cancel();throw new Error('Download exceeds declared input size');}if(!res.body)return Buffer.alloc(0);const reader=res.body.getReader(),chunks=[];let size=0;try{for(;;){const{done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new Error('Download exceeds declared input size');}chunks.push(Buffer.from(value));}return Buffer.concat(chunks,size);}finally{reader.releaseLock();}}
export class CloudClient {
  constructor(base, secret, fetcher=fetch) { const url=new URL(base); if(url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Bridge requires a clean HTTPS endpoint'); this.base=url.href.replace(/\/$/,''); this.secret=secret; this.fetcher=fetcher; }
  trusted(path) { const url=new URL(path, this.base+'/'); const base=new URL(this.base); if(url.origin !== base.origin || !url.pathname.startsWith(base.pathname+'/')) throw new Error('Untrusted bridge content URL'); return url.href; }
  async downloadToFile(contentPath,root,path,{expectedSize,sha256}){if(!Number.isSafeInteger(expectedSize)||expectedSize<0)throw new Error('Invalid declared input size');if(sha256&&!/^[a-f0-9]{64}$/i.test(sha256))throw new Error('Invalid input checksum');const url=this.trusted(contentPath),target=await inputTarget(root,path),temporary=join(resolve(target,'..'),'.download-'+randomUUID()+'.part'),controller=new AbortController();let timer=setTimeout(()=>controller.abort(new DOMException('Download headers timed out','TimeoutError')),30000),file,reader;try{
 const res=await this.fetcher(url,{method:'GET',redirect:'error',signal:controller.signal,headers:{Authorization:'Bearer '+this.secret}});clearTimeout(timer);if(!res.ok){const e=new Error('Bridge HTTP '+res.status);e.status=res.status;throw e;}const length=res.headers.get('content-length');if(length&&Number(length)>expectedSize){await res.body?.cancel();throw new Error('Input exceeds declared size');}file=await open(temporary,'wx',0o600);const sha=createHash('sha256');let size=0;reader=res.body?.getReader();if(reader)for(;;){timer=setTimeout(()=>controller.abort(new DOMException('Download became idle','TimeoutError')),60000);const {done,value}=await reader.read();clearTimeout(timer);if(done)break;size+=value.byteLength;if(size>expectedSize){await reader.cancel();throw new Error('Input exceeds declared size');}sha.update(value);await file.writeFile(value);}const actual=sha.digest('hex');if(size!==expectedSize||(sha256&&actual!==sha256.toLowerCase()))throw new Error('Input file integrity mismatch');await file.sync();await file.close();file=null;await inputTarget(root,path);let exists=false;try{const existing=await digestFile(target);exists=true;if(existing.sizeBytes!==size||existing.sha256!==actual)throw new Error('Existing input does not match snapshot');}catch(e){if(e.code!=='ENOENT')throw e;}if(exists)await unlink(temporary);else await rename(temporary,target);return{sizeBytes:size,sha256:actual};
 }finally{clearTimeout(timer);controller.abort();await reader?.cancel().catch(()=>{});reader?.releaseLock();await file?.close();await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
  async request(path, method='GET', body, binary=false, maxBytes=52428800) {
    const url=this.trusted(path);
    const res=await this.fetcher(url,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:`Bearer ${this.secret}`, ...(binary?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:binary?body:JSON.stringify(body)})});
    if(!res.ok) { const e=new Error(`Bridge HTTP ${res.status}`); e.status=res.status; throw e; }
    if(binary&&method==='GET')return boundedBytes(res,maxBytes);if(res.status===204)return{};const value=await res.json();return value&&typeof value==='object'&&Object.hasOwn(value,'data')?value.data:value;
  }
}
export function artifactPolicy(value){if(!value||!Number.isSafeInteger(value.maxFileBytes)||value.maxFileBytes<1||value.maxFileBytes>52428800||!Number.isSafeInteger(value.maxArtifacts)||value.maxArtifacts<1||value.maxArtifacts>20||!Array.isArray(value.extensions)||!value.extensions.length||value.extensions.some(e=>typeof e!=='string'||!/^\.?[a-z0-9]{1,16}$/i.test(e)))throw new Error('Invalid website artifact policy');return{maxFileBytes:value.maxFileBytes,maxArtifacts:value.maxArtifacts,extensions:value.extensions.map(e=>e.replace(/^\./,'').toLowerCase())};}
export class BridgeRunner {
  constructor({journal,client,dsh,root,maxBytes}) { Object.assign(this,{journal,client,dsh,root,maxBytes}); this.busy=false;this.paused=false;this.idleWaiters=[]; this.device=null; this.lastError=null; }
  async event(run,type,message) {
    if(!run.pendingEvent) { run.pendingEvent={sequence:(run.sequence||0)+1,type,sessionId:run.sessionId,...(message?{message}: {})}; await this.journal.save(); }
    await this.client.request(`handoffs/${run.id}/events`,'POST',run.pendingEvent); run.sequence=run.pendingEvent.sequence; delete run.pendingEvent; await this.journal.save();
  }
  async pause(){this.paused=true;if(this.busy)await new Promise(resolve=>this.idleWaiters.push(resolve));}
  resume(){this.paused=false;}
  async tick() {
    if(this.busy||this.paused) return; this.busy=true;
    try {
      this.device=await this.client.request('device');
      if(this.device.revoked) { await this.stopRuns(); return; }
      if(!this.device.paired) return;
      if(this.device.protocolVersion!==1) throw new Error('Bridge protocol version is incompatible');
      await this.client.request('device/heartbeat','POST',{});
      for(const project of this.device.projects){const binding=this.journal.state.bindings[project.projectId];if(binding&&project.workspaceLabel!==binding.label)await this.client.request('device/workspaces','POST',{projectId:project.projectId,workspaceLabel:binding.label});}
      let run=Object.values(this.journal.state.runs).find(r=>!terminal.has(r.state));
      if(!run) {
        const allowed=this.device.projects.filter(p=>this.journal.state.bindings[p.projectId]);
        if(!allowed.length) return;
        const {handoff}=await this.client.request('device/claim','POST',{}); if(!handoff) return;
        safeId(handoff.handoffId); run=this.journal.state.runs[handoff.handoffId];
        if(!run) { run={id:handoff.handoffId,projectId:handoff.projectId,sessionId:`bridge-${handoff.handoffId}`,state:'claimed',sequence:0,artifacts:{},snapshotHash:handoff.snapshotHash}; this.journal.state.runs[run.id]=run; await this.journal.save(); }
      }
      const beat=await this.client.request(`handoffs/${run.id}/heartbeat`,'POST',{});
      if(beat.cancelRequested||run.state==='cancel_requested') { await this.cancelRun(run);return; }
      if(run.pendingEvent)await this.event(run);
      if(!this.device.projects.some(p=>p.projectId===run.projectId)) {await this.cancelRun(run);return;}
      await this.advance(run); this.lastError=null;
    } catch(e) {
      this.lastError=e.status===401||e.status===403?'连接授权已失效，请重新连接。':e.message;
      if(e.status===401||e.status===403) await this.stopRuns();
      throw e;
    } finally { this.busy=false;for(const resolve of this.idleWaiters.splice(0))resolve(); }
  }
  async cancelRun(run){run.state='cancel_requested';await this.journal.save();if(!run.cancelVerified){await this.dsh.cancel(run.sessionId);run.cancelVerified=true;await this.journal.save();}if(run.pendingEvent?.type!=='cancelled'){run.pendingEvent={sequence:Math.max(run.sequence||0,run.pendingEvent?.sequence||0)+1,type:'cancelled',sessionId:run.sessionId};await this.journal.save();}await this.event(run);run.state='cancelled';await this.journal.save();}
  async stopRuns(){for(const run of Object.values(this.journal.state.runs).filter(r=>!terminal.has(r.state)))await this.cancelRun(run);}
  async prepare(run) {
    const binding=this.journal.state.bindings[run.projectId]; if(!binding) throw new Error('请先为项目选择本地目录');
    const projectCwd=await realpath(binding.cwd);const cwd=join(projectCwd,'.team-office-bridge',safeId(run.id)); await mkdir(cwd,{recursive:true});
    // Refuse redirected workspace/run roots, including existing Windows junctions.
    if((await realpath(cwd)).toLowerCase() !== resolve(cwd).toLowerCase()) throw new Error('Run directory must not be a symbolic link or junction');
    const snapshot=await this.client.request(`handoffs/${run.id}/snapshot`);
    if(snapshot.snapshotHash!==run.snapshotHash) throw new Error('Task snapshot mismatch');
    run.artifactPolicy=artifactPolicy(snapshot.artifactPolicy);
    const input=join(cwd,'inputs'); const output=join(cwd,'outputs'); await mkdir(input,{recursive:true}); await mkdir(output,{recursive:true}); if((await realpath(input)).toLowerCase()!==resolve(input).toLowerCase() || (await realpath(output)).toLowerCase()!==resolve(output).toLowerCase())throw new Error('Input or output directory is redirected');
    for(const item of snapshot.inputs||[]) { await writeInput(input,item.path,Buffer.from(item.text,'utf8')); }
    for(const file of snapshot.files||[]){const path=`${safeId(file.fileId)}/${file.name}`;safePath(input,path);const downloaded=await this.client.downloadToFile(file.contentPath,input,path,{expectedSize:file.sizeBytes,sha256:file.sha256});run.inputDownloads??={};run.inputDownloads[file.fileId]=downloaded;await this.journal.save();}
    run.inputFiles=(snapshot.files||[]).map(file=>({fileId:file.fileId,name:file.name,path:join(input,file.fileId,file.name)}));
    run.runDir=cwd;run.cwd=projectCwd;run.output=output; run.prompt=`${snapshot.prompt}\n\n实际项目工作目录是 ${projectCwd}，可以检查或修改该项目已有文件（遵守 DSH 原生权限）。完整输入位于 ${input}。下载材料对应关系：${JSON.stringify(run.inputFiles)}。网站成果限制：${JSON.stringify(run.artifactPolicy)}。所有可回传成果必须保存在 ${output} 中。完成后调用 team_office_complete，提供中文成果说明和相对于 outputs 的文件路径列表；不要上传密钥、工作区其他文件或原始聊天记录。不得擅自提交网站验收。`;
    run.state='prepared'; await this.journal.save();
  }
  async registerCompletion(run,{summary,paths}) {
    if(!run.artifactPolicy){const snapshot=await this.client.request(`handoffs/${run.id}/snapshot`);if(snapshot.snapshotHash!==run.snapshotHash)throw new Error('Task snapshot mismatch');run.artifactPolicy=artifactPolicy(snapshot.artifactPolicy);await this.journal.save();}
    const policy=artifactPolicy(run.artifactPolicy);
    if(!summary?.trim() || summary.length>10000 || !Array.isArray(paths) || paths.length>policy.maxArtifacts) throw new Error('Invalid completion declaration');
    if(!['dispatching','running','waiting_input'].includes(run.state)) throw new Error('This run cannot register results');
    for(const path of paths){if(!policy.extensions.includes(extname(path).slice(1).toLowerCase()))throw new Error('Artifact extension is not accepted by website');await readArtifact(run.output,path,policy.maxFileBytes);}
    run.completion={summary:summary.trim(),paths:[...new Set(paths)]}; await this.journal.save(); return {registered:true};
  }
  transientPreparation(error){return error.status===429||error.status>=500||error.name==='TimeoutError'||error.name==='AbortError'||(error instanceof TypeError&&/fetch|network/i.test(error.message))||['ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','ETIMEDOUT'].includes(error.cause?.code||error.code);}
  async failBeforeDispatch(run,error){run.state='failing';run.localPreparationError=error?.message||run.localPreparationError;await this.journal.save();await this.event(run,'failed','任务输入准备失败，请检查资料和本地目录');run.state='failed';this.dsh.release?.(run.sessionId);await this.journal.save();}
  async advance(run) {
    if(run.state==='failing'){await this.failBeforeDispatch(run);return;}
    if(run.state==='claimed'){try{await this.prepare(run);}catch(e){if(e.status===401||e.status===403||this.transientPreparation(e))throw e;await this.failBeforeDispatch(run,e);return;}}
    if(run.state==='prepared') {
      try{await this.dsh.create(run,args=>this.registerCompletion(run,args));}catch(e){await this.failBeforeDispatch(run,e);return;}await this.event(run,'session_created');
      run.state='dispatching'; await this.journal.save();
      // Write-ahead marker is deliberately never cleared by a failed/uncertain prompt response.
      try { await this.dsh.prompt(run); run.state='running'; await this.event(run,'prompt_accepted'); }
      catch { return; }
    }
    if(['dispatching','running','waiting_input'].includes(run.state)) {
      const inspection=await this.dsh.inspect(run.sessionId);
      const events=inspection.events||[];
      const accepted=events.find(e=>e.type==='user/message'&&e.data?.source?.rpcId===run.id) || events.find(e=>e.type==='agent/inbox/spliced'&&e.data?.inserted?.some(m=>m.source?.rpcId===run.id));
      if(!accepted && run.state!=='dispatching') return;
      if(!accepted) { run.state='dispatch_uncertain'; await this.event(run,'dispatch_uncertain','Cannot prove prompt acceptance; no automatic replay'); return; }
      const end=events.findLast(e=>e.seq>accepted.seq&&e.type==='turn/end');
      if(!end&&this.dsh.isLive?.(run.sessionId)===false){run.state='dispatch_uncertain';await this.event(run,'dispatch_uncertain','DSH restarted with unfinished work; inspect the existing session before resuming');return;}
      if(!end)await this.dsh.attach(run,args=>this.registerCompletion(run,args));
      if(!end) { const pending=events.some(e=>e.type==='approval/asked'&&!events.some(d=>d.type==='approval/decided'&&d.data?.id===e.data?.id)); const next=pending?'waiting_input':'running'; if(run.state!==next)await this.event(run,next,pending?'请在 DSH 中处理审批':undefined);run.state=next;await this.journal.save();return; }
      const kind=end.data?.reason?.kind;
      if(kind==='completed') {
        if(!run.completion) { run.state='failed'; await this.event(run,'failed','Agent ended without registering deliverables'); return; }
        run.state='uploading'; await this.event(run,'uploading');
      } else if(kind==='blocked') { if(run.state!=='waiting_input') await this.event(run,'waiting_input','请在 DSH 中处理审批或补充信息'); run.state='waiting_input'; await this.journal.save(); return; }
      else { run.state='failed'; await this.event(run,'failed','DSH turn did not complete normally'); return; }
    }
    if(run.state==='uploading') await this.upload(run);
  }
  async upload(run) {
    if(!run.artifactPolicy){const snapshot=await this.client.request(`handoffs/${run.id}/snapshot`);if(snapshot.snapshotHash!==run.snapshotHash)throw new Error('Task snapshot mismatch');run.artifactPolicy=artifactPolicy(snapshot.artifactPolicy);await this.journal.save();}
    if(run.completion.paths.length>run.artifactPolicy.maxArtifacts)throw new Error('Registered artifact count exceeds website policy');
    // Reconcile a lost completion response before uploading or finalizing again.
    const current=await this.client.request(`handoffs/${run.id}`);
    if(current.state==='ready_for_review') { run.state='ready_for_review';this.dsh.release?.(run.sessionId);await this.journal.save();return; }
    for(const path of run.completion.paths) {
      const policy=artifactPolicy(run.artifactPolicy);if(!policy.extensions.includes(extname(path).slice(1).toLowerCase()))throw new Error('Artifact extension is not accepted by website');const artifact=await readArtifact(run.output,path,policy.maxFileBytes);
      let entry=run.artifacts[path];
      if(!entry) { entry=run.artifacts[path]={artifactId:randomUUID(),sha256:artifact.sha256}; await this.journal.save(); }
      if(entry.sha256!==artifact.sha256) throw new Error('Registered result changed during upload');
      const ticket=await this.client.request(`handoffs/${run.id}/artifacts`,'POST',{artifactId:entry.artifactId,name:artifact.name,sizeBytes:artifact.sizeBytes,sha256:artifact.sha256});
      if(!ticket.stored) await this.client.request(ticket.uploadPath,'PUT',artifact.bytes,true);
    }
    await this.client.request(`handoffs/${run.id}/complete`,'POST',{summary:run.completion.summary,artifactIds:Object.values(run.artifacts).map(a=>a.artifactId),sessionId:run.sessionId});
    run.state='ready_for_review';this.dsh.release?.(run.sessionId);await this.journal.save();
  }
}
