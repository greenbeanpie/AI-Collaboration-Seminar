import {it,expect} from 'vitest';
import {env} from './helpers/env';
import {createApp} from '../src/app';
import {handleScheduled} from '../src/cron';
import {isD1DailyQuotaError,d1QuotaError} from '../src/core/d1-quota';
const quota=new Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow");
it('classifies only quota errors and publishes UTC reset without leaking SQL',async()=>{
 expect(isD1DailyQuotaError(new Error('wrapper',{cause:quota}))).toBe(true);expect(isD1DailyQuotaError(new Error('D1_ERROR: no such table'))).toBe(false);
 expect(d1QuotaError(new Date('2026-10-07T12:00:00Z')).details?.resetAt).toBe('2026-10-08T00:00:00.000Z');
 const db={prepare:()=>{throw quota;}};const local={...env,DB:db as unknown as D1Database};
 const response=await createApp().request('/api/v1/projects',{headers:{Cookie:'ai_office_session=opaque-token'}},local);
 expect(response.status).toBe(503);expect(response.headers.get('Retry-After')).toBeTruthy();expect(await response.text()).toContain('后台数据库当日额度已用尽');
});
it('stops scheduled maintenance after the first quota rejection',async()=>{
 let reads=0;const local={...env,DB:{prepare:()=>{reads++;throw quota;}} as unknown as D1Database};
 await handleScheduled(local,'* * * * *');expect(reads).toBe(1);
});
