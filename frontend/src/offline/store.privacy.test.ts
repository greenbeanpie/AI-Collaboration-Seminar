import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { clearOfflineAccount, rememberAccount, writeSnapshot, readSnapshot, putOperation, operations, forgetAccount } from './store';
const user=(id:string)=>({id,username:id,displayName:id,email:null,isAdmin:false,role:'user' as const});
afterEach(()=>forgetAccount());
it('atomically deletes snapshots and pending intents for one account only and prevents late cache writes',async()=>{
 rememberAccount(user('a'));await writeSnapshot('/api/v1/projects/p',{private:'a'},'a','"old"');
 await putOperation({key:'a:op',accountId:'a',projectId:'p',url:'x',method:'POST',body:{},localId:'x',base:null,createdAt:'2026-10-06',state:'pending'});
 rememberAccount(user('b'));await writeSnapshot('/api/v1/projects/p',{private:'b'},'b','"other"');
 await clearOfflineAccount('a');expect(await readSnapshot('/api/v1/projects/p','a')).toBeUndefined();expect(await operations('a')).toEqual([]);expect((await readSnapshot('/api/v1/projects/p','b'))?.data).toEqual({private:'b'});
 await writeSnapshot('/api/v1/projects/p',{private:'late'},'a');expect(await readSnapshot('/api/v1/projects/p','a')).toBeUndefined();
 expect(rememberAccount(user('a'))).toBe(false);
 rememberAccount(user('a'), true);await writeSnapshot('/api/v1/projects/p',{private:'fresh'},'a','"fresh"');expect((await readSnapshot('/api/v1/projects/p','a'))?.etag).toBe('"fresh"');await clearOfflineAccount('a');await clearOfflineAccount('b');
});
