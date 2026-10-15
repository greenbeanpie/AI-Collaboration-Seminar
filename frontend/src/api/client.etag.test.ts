import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({account:'a',cache:new Map<string,{data:unknown;etag?:string}>()}));
vi.mock('../offline/store', async (original) => ({ ...await original<typeof import('../offline/store')>(),offlineAccount:()=>state.account?{id:state.account}:null,readSnapshot:async(url:string,account=state.account)=>state.cache.get(account+':'+url),readCachedList:async()=>undefined,writeSnapshot:async(url:string,data:unknown,account:string,etag?:string)=>{state.cache.set(account+':'+url,{data,etag});},operations:async()=>[],rememberAccount:vi.fn(),forgetAccount:vi.fn()}));
import {request} from './client';
const url='/api/v1/projects/p/tasks';
beforeEach(()=>{state.account='a';state.cache.clear();vi.stubGlobal('navigator',{onLine:true});});
afterEach(()=>vi.unstubAllGlobals());
it('sends a snapshot validator and accepts empty 304 without update notifications',async()=>{
 state.cache.set('a:'+url,{data:{items:[]},etag:'"one"'});
 const updated=vi.fn();window.addEventListener('offline-snapshot-updated',updated);
 const fetcher=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>{void _input;void _init;return new Response(null,{status:304,headers:{ETag:'"one"'}});});vi.stubGlobal('fetch',fetcher);
 expect(await request(url)).toEqual({items:[]});await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledOnce());await new Promise(r=>setTimeout(r,20));
 expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('If-None-Match')).toBe('"one"');expect(updated).not.toHaveBeenCalled();
 window.removeEventListener('offline-snapshot-updated',updated);
});
it('upgrades legacy snapshots and announces a changed validator',async()=>{
 state.cache.set('a:'+url,{data:{items:[]}});const updated=vi.fn();window.addEventListener('offline-snapshot-updated',updated);
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({data:{items:[{taskId:'new'}]}},{headers:{ETag:'"two"'}})));
 await request(url);await vi.waitFor(()=>expect(updated).toHaveBeenCalledOnce());expect(state.cache.get('a:'+url)?.etag).toBe('"two"');window.removeEventListener('offline-snapshot-updated',updated);
});
it('never accepts a conditional result after switching identity',async()=>{
 let finish!:(r:Response)=>void;vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(r=>{finish=r;})));
 const pending=request(url,{networkOnly:true,conditionalSnapshot:{accountId:'a',data:{items:[{private:'a'}]},etag:'"one"'}});state.account='b';finish(new Response(null,{status:304}));
 await expect(pending).rejects.toMatchObject({code:'AUTH_CONTEXT_CHANGED'});expect(state.cache.has('b:'+url)).toBe(false);
});
it('does not announce identical legacy data when a response has no validator',async()=>{
 state.cache.set('a:'+url,{data:{items:[{taskId:'same'}]}});
 const updated=vi.fn();window.addEventListener('offline-snapshot-updated',updated);
 const fetcher=vi.fn(async()=>Response.json({data:{items:[{taskId:'same'}]}}));vi.stubGlobal('fetch',fetcher);
 await request(url);await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledOnce());await new Promise(resolve=>setTimeout(resolve,20));
 expect(updated).not.toHaveBeenCalled();window.removeEventListener('offline-snapshot-updated',updated);
});
it('rejects in-flight account data after device clearing even when the same account logs back in',async()=>{
 let finish!:(response:Response)=>void;
 vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve;})));
 const pending=request(url,{networkOnly:true});
 window.dispatchEvent(new CustomEvent('account-device-cleared',{detail:{accountId:'a'}}));
 state.account='a';
 finish(Response.json({data:{items:[{private:'old-session'}]}},{headers:{ETag:'"old"'}}));
 await expect(pending).rejects.toMatchObject({code:'AUTH_CONTEXT_CHANGED'});
 expect(state.cache.has('a:'+url)).toBe(false);
});
it('coalesces offline-snapshot-updated events within 50ms and invalidates only matching queryKeys across mounted queries', async () => {
  const { QueryClient } = await import('@tanstack/react-query');
  const { createSnapshotInvalidationScheduler, matchesSnapshotUrl } = await import('./snapshot-invalidation');
  const queryClient = new QueryClient();
  const tasksObserver = vi.fn().mockResolvedValue({ items: [] });
  const membersObserver = vi.fn().mockResolvedValue({ items: [] });
  const otherProjectTasksObserver = vi.fn().mockResolvedValue({ items: [] });
  const sessionObserver = vi.fn().mockResolvedValue({ id: 'a' });

  await queryClient.fetchQuery({ queryKey: ['tasks', 'p', 'page', 1], queryFn: tasksObserver });
  await queryClient.fetchQuery({ queryKey: ['members', 'p'], queryFn: membersObserver });
  await queryClient.fetchQuery({ queryKey: ['tasks', 'other-project'], queryFn: otherProjectTasksObserver });
  await queryClient.fetchQuery({ queryKey: ['session'], queryFn: sessionObserver });

  expect(matchesSnapshotUrl(['tasks', 'p', 'page', 1], '/api/v1/projects/p/tasks?limit=50')).toBe(true);
  expect(matchesSnapshotUrl(['collaboration-tasks', 'p'], '/api/v1/projects/p/tasks?limit=50')).toBe(true);
  expect(matchesSnapshotUrl(['members', 'p'], '/api/v1/projects/p/tasks?limit=50')).toBe(false);
  expect(matchesSnapshotUrl(['tasks', 'other-project'], '/api/v1/projects/p/tasks?limit=50')).toBe(false);
  expect(matchesSnapshotUrl(['session'], '/api/v1/auth/session')).toBe(true);
  expect(matchesSnapshotUrl(['capabilities'], '/api/v1/capabilities')).toBe(true);

  const scheduler = createSnapshotInvalidationScheduler(queryClient, () => state.account, 50);
  scheduler.schedule({ accountId: 'a', url: '/api/v1/projects/p/tasks?limit=50' });
  scheduler.schedule({ accountId: 'a', url: '/api/v1/projects/p/tasks/t-1' });
  scheduler.schedule({ accountId: 'b', url: '/api/v1/auth/session' }); // ignored foreign account

  await new Promise(resolve => setTimeout(resolve, 70));

  expect(queryClient.getQueryState(['tasks', 'p', 'page', 1])?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(['members', 'p'])?.isInvalidated).toBe(false);
  expect(queryClient.getQueryState(['tasks', 'other-project'])?.isInvalidated).toBe(false);
  expect(queryClient.getQueryState(['session'])?.isInvalidated).toBe(false);
  scheduler.dispose();
});
