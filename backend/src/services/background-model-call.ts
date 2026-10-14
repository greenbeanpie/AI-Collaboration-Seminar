import type { Env } from '../env';
import { AppError } from '../core/errors';
import { acquireExecutionCall, abortExecutionCall, finishExecutionCall, isExecutionPaused, readExecution, resolveExecutionTarget } from './ai-execution-control';
import { BackgroundContinuation, isBackgroundContinuation } from './ai-execution-slices';
import { claimAiResource, finishAiResource, type AiResourceClaim } from './ai-resource-quota';

/** Only wrap generation, never provider uploads, polling, probes or cached responses. */
export async function backgroundModelCall<T>(env:Env,jobId:string,callAndCheckpoint:()=>Promise<T>,resourceManaged=false):Promise<T>{
  if(env.AI_EXECUTION_CONTEXT && env.AI_EXECUTION_CONTEXT.modelCalls>=1)throw new BackgroundContinuation();
  const resourceClaim:AiResourceClaim|undefined=resourceManaged?undefined:await claimAiResource(env,{jobId,operation:'workers_ai',model:'@cf/openai/whisper-large-v3-turbo'});
  const target=await resolveExecutionTarget(env,{kind:'job',id:jobId});
  let token;
  try{token=await acquireExecutionCall(env,target,env.AI_EXECUTION_CONTEXT?.generation);}catch(error){if(resourceClaim)await finishAiResource(env,resourceClaim,'cancelled');throw error;}
  if(env.AI_EXECUTION_CONTEXT){env.AI_EXECUTION_CONTEXT.modelCalls++;env.AI_EXECUTION_CONTEXT.generation=token.generation;}
  let received=false;
  try{
    const result=await callAndCheckpoint();received=true;
    if(resourceClaim)await finishAiResource(env,resourceClaim,'completed');
    if(!await finishExecutionCall(env,target,token))throw new AppError('INVALID_STATE','任务已取消或执行代次已变化；迟到结果不发布',409,false,{executionSuperseded:true});
    return result;
  }catch(error){
    if(error instanceof AppError&&error.details?.resourceQuota){if(resourceClaim&&!received)await finishAiResource(env,resourceClaim,'cancelled');await abortExecutionCall(env,target,token);if(env.AI_EXECUTION_CONTEXT)env.AI_EXECUTION_CONTEXT.modelCalls--;throw error;}
    if(resourceClaim&&!received){const known=error instanceof AppError&&!error.details?.acceptanceUncertain&&(typeof error.details?.status==='number'||error.code==='AI_OUTPUT_INVALID');await finishAiResource(env,resourceClaim,error instanceof AppError&&error.code==='VALIDATION_FAILED'?'cancelled':known?'completed':'uncertain');}
    if(isBackgroundContinuation(error)){await abortExecutionCall(env,target,token);if(env.AI_EXECUTION_CONTEXT)env.AI_EXECUTION_CONTEXT.modelCalls--;throw error;}
    if(received||isExecutionPaused(error)||isBackgroundContinuation(error))throw error;
    if(error instanceof AppError&&error.code==='VALIDATION_FAILED'){await abortExecutionCall(env,target,token);if(env.AI_EXECUTION_CONTEXT)env.AI_EXECUTION_CONTEXT.modelCalls--;throw error;}
    // Explicit rejections and invalid completed outputs are known results. Transport loss is ambiguous.
    const knownStatus=error instanceof AppError?error.details?.status:(error as {status?:unknown}|null)?.status;
    const uncertain=Boolean(error instanceof AppError&&error.details?.acceptanceUncertain)||!(typeof knownStatus==='number'||error instanceof AppError && ['AI_OUTPUT_INVALID','VALIDATION_FAILED'].includes(error.code));
    await finishExecutionCall(env,target,token,{uncertain});
    if(uncertain){const { ExecutionPaused }=await import('./ai-execution-control');throw new ExecutionPaused((await readExecution(env,target))!);}
    throw error;
  }
}
