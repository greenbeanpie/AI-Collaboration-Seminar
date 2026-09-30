import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env';
import { runAiJob } from '../services/ai-jobs';

/**
 * AI 类任务 Workflow（agent_run / review_run / rehearsal_turn）。
 * 实例 ID = jobId（确定性派发见 services/jobs.ts tryDispatchJob）。
 */
export class AgentRunWorkflow extends WorkflowEntrypoint<Env, { jobId: string }> {
  async run(event: WorkflowEvent<{ jobId: string }>, step: WorkflowStep): Promise<void> {
    await step.do(
      'run-ai-job',
      { retries: { limit: 2, delay: '5 seconds' } },
      async () => runAiJob(this.env, event.payload.jobId),
    );
  }
}
