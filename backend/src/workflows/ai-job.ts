import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env';
import { runAiJob } from '../services/ai-jobs';
import { previewDraft } from '../services/creation-drafts';
import type { DraftPreviewInput } from '../services/draft-preview-jobs';

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
    await step.do(
      'run-ai-job',
      { retries: { limit: 2, delay: '5 seconds' } },
      async () => runAiJob(this.env, event.payload.jobId),
    );
  }
}
