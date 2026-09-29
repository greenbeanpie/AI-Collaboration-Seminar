import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env';
import { runParseJob } from '../services/parse';

/**
 * 来源解析 Workflow（PLAN 二.4/二.7）。
 * 实例 ID = jobId（确定性）；步骤失败按配置重试，状态机由 services/parse.ts 维护。
 */
export class ParseSourceWorkflow extends WorkflowEntrypoint<Env, { jobId: string }> {
  async run(event: WorkflowEvent<{ jobId: string }>, step: WorkflowStep): Promise<void> {
    await step.do(
      'parse-source',
      { retries: { limit: 2, delay: '5 seconds' } },
      async () => runParseJob(this.env, event.payload.jobId),
    );
  }
}
