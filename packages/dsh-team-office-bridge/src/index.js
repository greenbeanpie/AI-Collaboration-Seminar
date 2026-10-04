import { randomBytes } from 'node:crypto';
import { join, basename } from 'node:path';
import { homedir, hostname } from 'node:os';
import { realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Journal, CloudClient, BridgeRunner, hash } from './runner.js';
export const name='team-office-bridge';
export const inject=['credentials','sessionController','connection','agents','tools','directoryPicker'];
export const DEFAULT_API='https://greenbp-team-office.hddhp.workers.dev/api/v1/agent-bridges';
const KEY='team-office-bridge/device';
const require=createRequire(import.meta.url);
export function compatibility(ctx) {
  const missing=[];
  for(const key of ['create','prompt','follow','control','inspect','resolveAgent','cancel','updateQueue']) if(typeof ctx.sessionController?.[key]!=='function') missing.push(`sessionController.${key}`);
  for(const key of ['readRecord','modifyRecord','deleteRecord']) if(typeof ctx.credentials?.[key]!=='function') missing.push(`credentials.${key}`);
  if(typeof ctx.connection?.fetch?.register!=='function') missing.push('connection.fetch.register');
  if(typeof ctx.directoryPicker?.capability!=='function') missing.push('directoryPicker.capability');
  return missing;
}
export class DshAdapter {
  constructor(ctx) {this.ctx=ctx; this.bindings=new Map(); this.followers=new Map();this.controlAbort=null;this.projections=new Map();}
  async create(run,complete) {await this.ctx.sessionController.create({sessionId:run.sessionId,cwd:run.cwd}); await this.attach(run,complete);}
  async attach(run,complete) {
    if(this.bindings.has(run.sessionId)) return;
    const result=await this.ctx.sessionController.resolveAgent(run.sessionId); if(result.error) throw result.error;
    const agent=result.agent;
    if(!this.controlAbort){this.controlAbort=new AbortController();void(async()=>{try{for await(const frame of this.ctx.sessionController.control(this.controlAbort.signal)){if(frame.type==='projection'&&this.bindings.has(frame.sessionId))this.projections.set(frame.sessionId,frame);}}catch{/* Durable inspect polling handles stream reconnection. */}})();}
    const unregister=agent.ctx.tools.register({name:'team_office_complete',description:'Register the final deliverables for this website task. Files must be inside this run outputs directory. Does not submit acceptance.',parameters:{type:'object',properties:{summary:{type:'string',description:'Final Chinese summary'},paths:{type:'array',items:{type:'string'},description:'Relative paths inside outputs'}},required:['summary','paths'],additionalProperties:false},output:{schema:{type:'object',properties:{registered:{type:'boolean'}},required:['registered'],additionalProperties:false},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},async execute(args,exec){if(exec.agent?.id!==run.sessionId)throw new Error('Completion tool is bound to another session');exec.signal.throwIfAborted();return complete(args);}});
    this.bindings.set(run.sessionId,unregister);
    const abort=new AbortController(); this.followers.set(run.sessionId,abort);
    // The durable inspect path remains the authority; follow keeps the UI projection live.
    void (async()=>{try{for await(const _frame of this.ctx.sessionController.follow({address:{kind:'session',sessionId:run.sessionId},maxMessages:100},abort.signal)) {if(abort.signal.aborted) break;}}catch{/* polling reconciles a closed follow stream */}})();
  }
  prompt(run) {return this.ctx.sessionController.prompt({requestId:run.id,sessionId:run.sessionId,mode:'queue',content:[{type:'text',text:run.prompt}]},new AbortController().signal);}
  isLive(id){return !!this.ctx.agents.get(id);}
  inspect(id) {return this.ctx.sessionController.inspect(id,new AbortController().signal);}
  async cancel(id) {const hit=this.ctx.agents.get(id);if(!hit)return;const requestId=id.replace(/^bridge-/,'');for(const item of [...hit.inbox.nextTurn,...hit.inbox.nextStep].filter(m=>m.source?.rpcId===requestId)){try{await this.ctx.sessionController.updateQueue({sessionId:id,itemId:item.id,action:{kind:'remove'}});}catch(e){if(e.code!=='session/queue-item-not-found')throw e;}}await this.ctx.sessionController.cancel({sessionId:id});await hit.whenIdle();this.release(id);}
  release(id){this.followers.get(id)?.abort();this.followers.delete(id);this.bindings.get(id)?.();this.bindings.delete(id);this.projections.delete(id);}
  dispose() {this.controlAbort?.abort();this.controlAbort=null;this.projections.clear();for(const abort of this.followers.values()) abort.abort(); for(const unregister of this.bindings.values()) unregister(); this.followers.clear();this.bindings.clear();}
}
export async function apply(ctx) {
  const missing=compatibility(ctx);
  const journal=await new Journal(join(process.env.DSH_HOME||join(homedir(),'.dsh'),'team-office-bridge')).load();
  await journal.acquire();
  const adapter=new DshAdapter(ctx); let runner=null; let disposed=false; let nextDelay=5000; let timer;let settingsBusy=false;
  let version='unknown'; try{version=require('@deepseek-ai/dsh-api-session-controller/package.json').version;}catch{}
  const readCredential=async()=>{const record=await ctx.credentials.readRecord(KEY);if(!record)return null;const value=record.payload;if(typeof value?.secret!=='string'||typeof value?.apiBase!=='string')throw new Error('Invalid bridge credential record');return value;};
  const ensureRunner=async()=>{if(missing.length)throw new Error(`DSH 不兼容：缺少 ${missing.join(', ')}`);const credential=await readCredential(); if(!credential)return null;if(!runner||runner.client.base!==credential.apiBase||runner.client.secret!==credential.secret)runner=new BridgeRunner({journal,client:new CloudClient(credential.apiBase,credential.secret),dsh:adapter});return runner;};
  const status=async()=>{const credential=await readCredential();return {compatible:!missing.length,compatibilityMessage:missing.length?`DSH 缺少 ${missing.join(', ')}`:null,configured:!!credential,paired:!!runner?.device?.paired,approvalUrl:journal.state.pairing?.approvalUrl||null,projects:(runner?.device?.projects||[]).map(p=>({...p,bound:!!journal.state.bindings[p.projectId],localLabel:journal.state.bindings[p.projectId]?.label||null})),runs:Object.values(journal.state.runs).map(r=>({handoffId:r.id,state:r.state,sessionId:r.sessionId})),error:runner?.lastError||null,dshVersion:version};};
  const handler=async req=>{
    let changing=false,pausedRunner=null;
    try{
      if(req.method==='GET')return Response.json(await status());
      const body=await req.json();if(body.action==='connect'||body.action==='disconnect'){if(settingsBusy)throw new Error('连接设置正在更新，请稍后重试');changing=true;settingsBusy=true;pausedRunner=runner;if(pausedRunner)await pausedRunner.pause();}
      if(missing.length)throw new Error(`DSH 不兼容：${missing.join(', ')}`);
      if(body.action==='connect') {
        if(Object.values(journal.state.runs).some(r=>!['ready_for_review','blocked','failed','cancelled'].includes(r.state)))throw new Error('请先取消正在执行的交接任务');
        // Always mint a fresh secret when selecting an endpoint. Never send an existing credential elsewhere.
        const apiBase=new CloudClient(body.apiBase||DEFAULT_API,'validation').base;
        const old=await readCredential();
        if(old && old.apiBase===apiBase && journal.state.pairing && Date.parse(journal.state.pairing.expiresAt)>Date.now())return Response.json(await status());
        if(old){const oldClient=new CloudClient(old.apiBase,old.secret);const oldDevice=await oldClient.request('device');if(oldDevice.paired&&!oldDevice.revoked){await oldClient.request('device/disconnect','POST',{});if(runner)await runner.stopRuns();}}
        const secret=randomBytes(32).toString('hex');
        await ctx.credentials.modifyRecord(KEY,()=>({kind:'grant',payload:{secret,apiBase}}));runner=null;
        const client=new CloudClient(apiBase,secret);
        const pairing=await client.request('pairings','POST',{credentialHash:hash(secret),deviceName:hostname(),bridgeVersion:'0.1.0',dshVersion:version});
        const url=new URL(pairing.approvalUrl);const allowedOrigins=new Set([new URL(apiBase).origin,...(apiBase===DEFAULT_API?['https://team.greenbp.dpdns.org']:[])]);if(url.protocol!=='https:'||!allowedOrigins.has(url.origin)||url.pathname!=='/app/agent-bridges/connect'||url.searchParams.get('pairing')!==pairing.pairingId)throw new Error('Untrusted approval URL');
        journal.state.pairing=pairing;await journal.save();await ensureRunner();return Response.json(await status());
      }
      if(body.action==='disconnect'){const active=await ensureRunner();if(active){await active.pause();pausedRunner=active;await active.client.request('device/disconnect','POST',{});await active.stopRuns();}adapter.dispose();await ctx.credentials.deleteRecord(KEY);runner=null;delete journal.state.pairing;await journal.save();return Response.json(await status());}
      const active=await ensureRunner();if(!active)throw new Error('请先连接网站');
      if(body.action==='refresh'){await active.tick();return Response.json(await status());}
      if(body.action==='bind') {
        if(!active.device?.projects.some(p=>p.projectId===body.projectId))throw new Error('Project is not authorized');
        const picker=ctx.directoryPicker.capability();if(picker.kind!=='native')throw new Error('此 DSH 需要本机目录选择器');
        const selected=await picker.pick(new AbortController().signal); if(!selected)return Response.json(await status());
        const cwd=await realpath(selected);if(!(await stat(cwd)).isDirectory())throw new Error('请选择文件夹');const label=basename(cwd)||'工作目录';
        // Persist before notifying the cloud; failed notification is retryable through bind.
        journal.state.bindings[body.projectId]={cwd,label};await journal.save();
        await active.client.request('device/workspaces','POST',{projectId:body.projectId,workspaceLabel:label});return Response.json(await status());
      }
      throw new Error('Unknown bridge settings action');
    }catch(e){return Response.json({error:e.status?`Bridge HTTP ${e.status}`:e.message},{status:400});}finally{if(changing){settingsBusy=false;pausedRunner?.resume();}}
  };
  ctx.connection.fetch.register({path:'/api/team-office-bridge/config',methods:['GET','POST'],requestBody:'buffered',fetch:handler});
  const loop=async()=>{if(disposed)return;if(settingsBusy){timer=setTimeout(loop,5000);timer.unref?.();return;}try{const active=await ensureRunner();if(active)await active.tick();nextDelay=5000;}catch{nextDelay=Math.min(nextDelay*2,60000);}if(!disposed){timer=setTimeout(loop,nextDelay);timer.unref?.();}};
  timer=setTimeout(loop,0);timer.unref?.();
  ctx.effect(()=>()=>{disposed=true;clearTimeout(timer);adapter.dispose();return journal.release();},'team-office-bridge: shutdown');
}
