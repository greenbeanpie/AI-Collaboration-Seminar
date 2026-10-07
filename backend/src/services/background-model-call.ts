import type { Env } from '../env';
import { AppError } from '../core/errors';
import { acquireExecutionCall, abortExecutionCall, finishExecutionCall, isExecutionPaused, readExecution, resolveExecutionTarget } from './ai-execution-control';
import { BackgroundContinuation, isBackgroundContinuation } from './ai-execution-slices';

/** Only wrap generation, never provider uploads, polling, probes or cached responses. */
export async function backgroundModelCall<T>(env:Env,jobId:string,callAndCheckpoint:()=>Promise<T>):Promise<T>{
  if(env.AI_EXECUTION_CONTEXT && env.AI_EXECUTION_CONTEXT.modelCalls>=1)throw new BackgroundContinuation();
  const target=await resolveExecutionTarget(env,{kind:'job',id:jobId}),token=await acquireExecutionCall(env,target,env.AI_EXECUTION_CONTEXT?.generation);
  if(env.AI_EXECUTION_CONTEXT){env.AI_EXECUTION_CONTEXT.modelCalls++;env.AI_EXECUTION_CONTEXT.generation=token.generation;}
  let received=false;
  try{
    const result=await callAndCheckpoint();received=true;
    if(!await finishExecutionCall(env,target,token))throw new AppError('INVALID_STATE','任务已取消或执行代次已变化；迟到结果不发布',409,false,{executionSuperseded:true});
    return result;
  }catch(error){
    if(received||isExecutionPaused(error)||isBackgroundContinuation(error))throw error;
    if(error instanceof AppError&&error.code==='VALIDATION_FAILED'){await abortExecutionCall(env,target,token);if(env.AI_EXECUTION_CONTEXT)env.AI_EXECUTION_CONTEXT.modelCalls--;throw error;}
    // Explicit rejections and invalid completed outputs are known results. Transport loss is ambiguous.
    const knownStatus=error instanceof AppError?error.details?.status:(error as {status?:unknown}|null)?.status;
    const uncertain=!(typeof knownStatus==='number'||error instanceof AppError && ['AI_OUTPUT_INVALID','VALIDATION_FAILED'].includes(error.code));
    await finishExecutionCall(env,target,token,{uncertain});
    if(uncertain){const { ExecutionPaused }=await import('./ai-execution-control');throw new ExecutionPaused((await readExecution(env,target))!);}
    throw error;
  }
}
