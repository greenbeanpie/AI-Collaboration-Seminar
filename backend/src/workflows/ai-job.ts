import { getJob } from '../services/jobs';
import { runMediaJob } from '../services/media-summary';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env';
import { runAiJob } from '../services/ai-jobs';
import { previewDraft } from '../services/creation-drafts';
import type { DraftPreviewInput } from '../services/draft-preview-jobs';
import { executeAiSlice } from '../services/ai-execution-slices';

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
    if(JSON.parse(job.input_json).operation==='media.draft'){for(let window=0;window<240;window++){const result=await step.do('media-window-'+window,{retries:{limit:0,delay:'5 seconds'},timeout:'15 minutes'},()=>runMediaJob(this.env,event.payload.jobId,undefined,1));if(result.status==='busy'){await step.sleep('media-wait-'+window,'15 seconds');continue;}if(result.status!=='running')return;}return;}
    // step.do alone does not reset the Worker invocation subrequest budget.
    await step.do('run-ai-job', { retries: { limit: 0, delay: '5 seconds' } }, () =>
      executeAiSlice(this.env,event.payload.jobId,event.payload.slice ?? 0,()=>runAiJob({ ...this.env, AI_EXECUTION_SLICE: true }, event.payload.jobId)));
  }
}
