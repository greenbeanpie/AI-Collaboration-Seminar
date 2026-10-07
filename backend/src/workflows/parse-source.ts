import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env';
import { runParseJob } from '../services/parse';
import { executeAiSlice, ensureInitialExecutionSlice } from '../services/ai-execution-slices';

/** Legacy parse instances enter the same checkpointed execution path as new jobs. */
export class ParseSourceWorkflow extends WorkflowEntrypoint<Env, { jobId: string; slice?: number }> {
  async run(event: WorkflowEvent<{ jobId: string; slice?: number }>, step: WorkflowStep): Promise<void> {
    await step.do('parse-source', { retries: { limit: 0, delay: '5 seconds' } }, async () => {
      const sliceEnv: Env = { ...this.env, AI_EXECUTION_SLICE: true, AI_EXECUTION_CONTEXT: { modelCalls: 0 } };
      await ensureInitialExecutionSlice(sliceEnv, event.payload.jobId);
      await executeAiSlice(sliceEnv, event.payload.jobId, event.payload.slice ?? 0, async () => { await runParseJob(sliceEnv, event.payload.jobId); });
    });
  }
}
