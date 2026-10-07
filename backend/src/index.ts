import { isD1DailyQuotaError } from './core/d1-quota';
import { createApp } from './app';
import { handleScheduled } from './cron';
import { ParseSourceWorkflow } from './workflows/parse-source';
import { AgentRunWorkflow } from './workflows/ai-job';
import { activeExecutionSlice, dispatchExecutionSlice } from './services/ai-execution-slices';
import { dispatchDraftPreviewById } from './services/draft-preview-jobs';
import type { AiContinuationMessage, Env } from './env';

const app = createApp();

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  scheduled: (event, env, ctx) => {
    ctx.waitUntil(handleScheduled(env, event.cron));
  },
  queue: async (batch, env) => {
    for(const message of batch.messages){
      const body=message.body as AiContinuationMessage;
      try{
        if(body?.kind==='job-slice'&&typeof body.jobId==='string'&&Number.isInteger(body.slice)&&body.slice>=0){
          const active=await activeExecutionSlice(env,body.jobId);
          // Queue delivery is at-least-once; stale/duplicate messages are safe.
          if(active?.status==='pending'&&active.slice===body.slice)await dispatchExecutionSlice(env,active);
          message.ack();
          continue;
        }
        if(body?.kind==='draft-preview'&&typeof body.instanceId==='string'){
          await dispatchDraftPreviewById(env,body.instanceId);
          message.ack();
          continue;
        }
        // The producer is internal; malformed messages are discarded rather
        // than retried forever.
        message.ack();
      }catch(error){
        message.retry({delaySeconds:isD1DailyQuotaError(error)?3600:5});
      }
    }
  },
} satisfies ExportedHandler<Env,AiContinuationMessage>;

export { ParseSourceWorkflow, AgentRunWorkflow };
