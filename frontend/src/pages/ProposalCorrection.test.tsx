import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProposalCorrection } from './ProposalCorrection';
import type { CorrectionProposal } from './ProposalCorrection';
afterEach(()=>{cleanup();vi.unstubAllGlobals();sessionStorage.clear();});
const proposal={proposalId:'proposal',kind:'decompose',status:'pending',revision:1,createdAt:'2026-10-02T00:00:00Z',payload:{tasks:[{key:'new',title:'验证项目',detail:'原说明',criteria:'有证据',effortHours:2,dependsOn:[]}]}} as CorrectionProposal;
function ui(value:CorrectionProposal,onChanged=vi.fn(async()=>{})){return <QueryClientProvider client={new QueryClient({defaultOptions:{mutations:{retry:false}}})}><ProposalCorrection projectId="p" proposal={value} members={[]} onChanged={onChanged}/></QueryClientProvider>;}
it('preserves local fields after a concurrent revision and only saves after latest review acknowledgment',async()=>{
 const latest={...proposal,status:'stale',revision:2} as CorrectionProposal;
 const fetch=vi.fn(async(_url:unknown,options?:RequestInit)=>Response.json({data:options?.method==='PATCH'?{...latest,status:'pending',revision:3}: {items:[latest],nextCursor:null},requestId:'r'}));vi.stubGlobal('fetch',fetch);
 const view=render(ui(proposal));fireEvent.click(screen.getByText('修正建议、部分应用或重新反馈'));
 fireEvent.change(screen.getByLabelText('说明'),{target:{value:'人工追加边界说明'}});fireEvent.change(screen.getByLabelText('预计工时'),{target:{value:'6'}});fireEvent.change(screen.getByLabelText('修正理由或重新反馈'),{target:{value:'管理员已核对'}});
 view.rerender(ui(latest));expect(screen.getByLabelText('说明')).toHaveValue('人工追加边界说明');expect(screen.getByLabelText('预计工时')).toHaveValue(6);expect(screen.getByRole('button',{name:'保存方案修正'})).toBeDisabled();
 fireEvent.click(screen.getByRole('button',{name:'读取最新方案（保留本地修改）'}));await screen.findByText('已读取方案 r2 · 已过期');expect(screen.getByRole('button',{name:'保存方案修正'})).toBeDisabled();
 fireEvent.click(screen.getByRole('button',{name:'已核对最新方案，保留修改并继续'}));const save=screen.getByRole('button',{name:'保存方案修正'});expect(save).not.toBeDisabled();fireEvent.click(save);fireEvent.click(save);
 await waitFor(()=>expect(fetch.mock.calls.filter(([,options])=>options?.method==='PATCH')).toHaveLength(1));const [,options]=fetch.mock.calls.find(([,options])=>options?.method==='PATCH')!;expect(JSON.parse(String(options?.body))).toMatchObject({expectedRevision:2,payload:{tasks:[{detail:'人工追加边界说明',effortHours:6}]},reason:'管理员已核对'});expect(new Headers(options?.headers).get('idempotency-key')).toBeTruthy();
 await screen.findByText(/方案修正已保存/);
});
it('preserves a rejected draft and reuses its idempotency key on an unchanged network retry',async()=>{
 let fail=true;const fetch=vi.fn(async(_url:unknown,options?:RequestInit)=>{if(options?.method==='PATCH'&&fail)throw new TypeError('network lost');return Response.json({data:{...proposal,revision:2},requestId:'r'});});vi.stubGlobal('fetch',fetch);render(ui({...proposal,status:'rejected'} as CorrectionProposal));fireEvent.click(screen.getByText('修正建议、部分应用或重新反馈'));fireEvent.change(screen.getByLabelText('说明'),{target:{value:'保留这个修改'}});fireEvent.change(screen.getByLabelText('修正理由或重新反馈'),{target:{value:'重新核对'}});fireEvent.click(screen.getByRole('button',{name:'保存方案修正'}));await waitFor(()=>expect(fetch.mock.calls).toHaveLength(1));await waitFor(()=>expect(screen.getByRole('button',{name:'保存方案修正'})).not.toBeDisabled());expect(screen.getByLabelText('说明')).toHaveValue('保留这个修改');fail=false;fireEvent.click(screen.getByRole('button',{name:'保存方案修正'}));await screen.findByText(/方案修正已保存/);const keys=fetch.mock.calls.map(([,options])=>new Headers(options?.headers).get('idempotency-key'));expect(keys[0]).toBeTruthy();expect(keys[1]).toBe(keys[0]);
});
it('blocks applying unsaved edits so another apply button cannot discard corrections',()=>{
 render(ui(proposal));fireEvent.click(screen.getByText('修正建议、部分应用或重新反馈'));expect(screen.getByRole('button',{name:'应用选中条目'})).not.toBeDisabled();fireEvent.change(screen.getByLabelText('预计工时'),{target:{value:'6'}});expect(screen.getByRole('button',{name:'应用选中条目'})).toBeDisabled();
});
