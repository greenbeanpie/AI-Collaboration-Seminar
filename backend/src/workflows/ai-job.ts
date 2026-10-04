import { getJob } from '../services/jobs';
import { runMediaJob } from '../services/media-summary';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env';
import { runAiJob } from '../services/ai-jobs';
import { previewDraft } from '../services/creation-drafts';
import type { DraftPreviewInput } from '../services/draft-preview-jobs';
import { completeExecutionSlice, executeAiSlice } from '../services/ai-execution-slices';

/** A business job relays safe checkpoints through independently budgeted instances. */
export class AgentRunWorkflow extends WorkflowEntrypoint<Env, { jobId: string; slice?:number; draftPreview?:DraftPreviewInput }> {
  async run(event: WorkflowEvent<{ jobId: string; slice?:number; draftPreview?:DraftPreviewInput }>, step: WorkflowStep): Promise<void> {
    if(event.payload.draftPreview){
      const draft=event.payload.draftPreview;
      // A clarification pause ends this instance successfully; the answer starts a distinct
      // deterministic continuation instance and the same encrypted draft checkpoint.
      await step.do('draft-preview',{retries:{limit:0,delay:'5 seconds'}},()=>previewDraft(this.env,draft.draftId,draft.userId,draft.revision,'ai',draft.tasks,false,draft.goal,draft.attempt));
      return;
    }
    const job=await getJob(this.env,event.payload.jobId);
    if(['media.draft','media.summary'].includes(JSON.parse(job.input_json).operation)){
      const input=JSON.parse(job.input_json) as {sourceVersionId?:string};
      const slice=event.payload.slice ?? 0;
      // Media has its own per-stage lease. Bookkeeping must also identify the active engine for cron recovery.
      await this.env.DB.prepare("UPDATE ai_execution_slices SET status='running',updated_at=?3 WHERE job_id=?1 AND slice=?2 AND status IN ('pending','dispatched')").bind(job.id,slice,new Date().toISOString()).run();
      for(let window=0;window<240;window++){
        const result=await step.do('media-window-'+window,{retries:{limit:0,delay:'5 seconds'},timeout:'15 minutes'},()=>runMediaJob(this.env,event.payload.jobId,input.sourceVersionId,1));
        if(result.status==='busy'){await step.sleep('media-wait-'+window,'15 seconds');continue;}
        if(result.status!=='running'){await completeExecutionSlice(this.env,job.id,slice);return;}
      }
      return;
    }
    // step.do alone does not reset the Worker invocation subrequest budget.
    await step.do('run-ai-job', { retries: { limit: 0, delay: '5 seconds' } }, () =>
      executeAiSlice(this.env,event.payload.jobId,event.payload.slice ?? 0,()=>runAiJob({ ...this.env, AI_EXECUTION_SLICE: true }, event.payload.jobId)));
  }
}
