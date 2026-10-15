import type { Env } from '../env';
import { AppError } from '../core/errors';
import { isExecutionPaused } from './ai-execution-control';
import {
  acquireCoordinatedModelCall,
  abortCoordinatedModelCall,
  completeCoordinatedModelCall,
  pauseUncertainCoordinatedCall,
} from './ai-execution-coordinator';
import { BackgroundContinuation, isBackgroundContinuation } from './ai-execution-slices';
import { finishAiResource } from './ai-resource-quota';

/** Only wrap generation, never provider uploads, polling, probes or cached responses. */
export async function backgroundModelCall<T>(env:Env,jobId:string,callAndCheckpoint:()=>Promise<T>,resourceManaged=false):Promise<T>{
  if(env.AI_EXECUTION_CONTEXT && env.AI_EXECUTION_CONTEXT.modelCalls>=1)throw new BackgroundContinuation();
  const slot=await acquireCoordinatedModelCall(env,{jobId,operation:'workers_ai',model:'@cf/openai/whisper-large-v3-turbo',resourceManaged});
  const { resourceClaim }=slot;
  if(env.AI_EXECUTION_CONTEXT){env.AI_EXECUTION_CONTEXT.modelCalls++;env.AI_EXECUTION_CONTEXT.generation=slot.token.generation;}
  let received=false;
  try{
    const result=await callAndCheckpoint();received=true;
    await completeCoordinatedModelCall(env,slot);
    return result;
  }catch(error){
    if(error instanceof AppError&&error.details?.resourceQuota){if(!received)await abortCoordinatedModelCall(env,slot,'cancelled');else await abortCoordinatedModelCall(env,{...slot,resourceClaim:undefined});if(env.AI_EXECUTION_CONTEXT)env.AI_EXECUTION_CONTEXT.modelCalls--;throw error;}
    if(resourceClaim&&!received){const known=error instanceof AppError&&!error.details?.acceptanceUncertain&&(typeof error.details?.status==='number'||error.code==='AI_OUTPUT_INVALID');await finishAiResource(env,resourceClaim,error instanceof AppError&&error.code==='VALIDATION_FAILED'?'cancelled':known?'completed':'uncertain');}
    if(isBackgroundContinuation(error)){await abortCoordinatedModelCall(env,{...slot,resourceClaim:undefined});if(env.AI_EXECUTION_CONTEXT)env.AI_EXECUTION_CONTEXT.modelCalls--;throw error;}
    if(received||isExecutionPaused(error)||isBackgroundContinuation(error))throw error;
    if(error instanceof AppError&&error.code==='VALIDATION_FAILED'){await abortCoordinatedModelCall(env,{...slot,resourceClaim:undefined});if(env.AI_EXECUTION_CONTEXT)env.AI_EXECUTION_CONTEXT.modelCalls--;throw error;}
    // Explicit rejections and invalid completed outputs are known results. Transport loss is ambiguous.
    const knownStatus=error instanceof AppError?error.details?.status:(error as {status?:unknown}|null)?.status;
    const uncertain=Boolean(error instanceof AppError&&error.details?.acceptanceUncertain)||!(typeof knownStatus==='number'||error instanceof AppError && ['AI_OUTPUT_INVALID','VALIDATION_FAILED'].includes(error.code));
    await pauseUncertainCoordinatedCall(env,slot,uncertain);
    throw error;
  }
}
