import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env';
import { runAiJob } from '../services/ai-jobs';
import { previewDraft, DraftPreviewYield } from '../services/creation-drafts';
import { enqueueDraftPreviewSegment, type DraftPreviewInput } from '../services/draft-preview-jobs';
import { isExecutionPaused } from '../services/ai-execution-control';
import { executeAiSlice } from '../services/ai-execution-slices';

/** A business job relays safe checkpoints through independently budgeted instances. */
export class AgentRunWorkflow extends WorkflowEntrypoint<Env, { jobId: string; slice?:number; draftPreview?:DraftPreviewInput }> {
  async run(event: WorkflowEvent<{ jobId: string; slice?:number; draftPreview?:DraftPreviewInput }>, step: WorkflowStep): Promise<void> {
    if(event.payload.draftPreview){
      const draft=event.payload.draftPreview;
      // A clarification pause ends this instance successfully; the answer starts a distinct
      // deterministic continuation instance and the same encrypted draft checkpoint.
      await step.do('draft-preview', { retries: { limit: 0, delay: '5 seconds' } }, async () => {
        try {
          await previewDraft(this.env, draft.draftId, draft.userId, draft.revision, 'ai', draft.tasks, false, draft.goal, draft.attempt, draft.generation, draft.segment);
        } catch (error) {
          if (error instanceof DraftPreviewYield) { await enqueueDraftPreviewSegment(this.env, draft); return; }
          if (isExecutionPaused(error)) return;
          throw error;
        }
      });
      return;
    }
    // A fresh instance resets invocation-local dispatch and subrequest budgets.
    await step.do('run-ai-job', { retries: { limit: 0, delay: '5 seconds' } }, async () => {
      const sliceEnv: Env = { ...this.env, AI_EXECUTION_SLICE: true, AI_EXECUTION_CONTEXT: { modelCalls: 0 } };
      await executeAiSlice(sliceEnv, event.payload.jobId, event.payload.slice ?? 0, () => runAiJob(sliceEnv, event.payload.jobId));
    });
  }
}
