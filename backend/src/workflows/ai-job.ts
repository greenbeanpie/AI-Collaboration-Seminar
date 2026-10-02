import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env';
import { runAiJob } from '../services/ai-jobs';
import { previewDraft } from '../services/creation-drafts';
import type { DraftPreviewInput } from '../services/draft-preview-jobs';
import { InvestigationContinuation } from '../services/project-investigation';

/**
 * AI 类任务 Workflow（agent_run / review_run / rehearsal_turn）。
 * 实例 ID = jobId（确定性派发见 services/jobs.ts tryDispatchJob）。
 */
export class AgentRunWorkflow extends WorkflowEntrypoint<Env, { jobId: string; draftPreview?:DraftPreviewInput }> {
  async run(event: WorkflowEvent<{ jobId: string; draftPreview?:DraftPreviewInput }>, step: WorkflowStep): Promise<void> {
    if(event.payload.draftPreview){
      const draft=event.payload.draftPreview;
      await step.do('draft-preview',{retries:{limit:0,delay:'5 seconds'}},()=>previewDraft(this.env,draft.draftId,draft.userId,draft.revision,'ai',draft.tasks,false,draft.goal,draft.attempt));
      return;
    }
    // Each successful continuation closes the current invocation. Its durable
    // checkpoint contains the already-paid model response and completed reads.
    for (let slice = 0; slice < 512; slice++) {
      const continued = await step.do(`run-ai-job-${slice}`, { retries: { limit: 0, delay: '5 seconds' } }, async () => {
        try {
          await runAiJob({ ...this.env, AI_EXECUTION_SLICE: true }, event.payload.jobId);
          return false;
        } catch (error) {
          if (error instanceof InvestigationContinuation) return true;
          throw error;
        }
      });
      if (!continued) return;
    }
    throw new Error('自主调查超过安全执行分片数量，请核对任务');
  }
}
