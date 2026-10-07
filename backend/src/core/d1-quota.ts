import { AppError } from './errors';
/** Classify Cloudflare quota rejection only; ordinary D1 failures remain errors. */
export function isD1DailyQuotaError(error:unknown):boolean {
 let current=error;const seen=new Set<unknown>();
 for(let i=0;i<5&&current&&typeof current==='object'&&!seen.has(current);i++){
  seen.add(current);const e=current as {message?:unknown;cause?:unknown};
  if(typeof e.message==='string'&&/D1.*(?:free tier daily|daily row (?:read|write) limit|daily.*limit)/i.test(e.message))return true;
  current=e.cause;
 }
 return false;
}
export function d1QuotaError(now=new Date()):AppError {
 const reset=new Date(now);reset.setUTCHours(24,0,0,0);
 return new AppError('QUOTA_EXCEEDED','后台数据库当日额度已用尽，请等待额度重置或联系管理员升级套餐',503,false,{service:'database',resetAt:reset.toISOString()});
}
