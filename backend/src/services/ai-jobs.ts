import type { Env } from '../env';
import { getJob } from './jobs';
import { runAgentJob } from './agent';
import { runReviewJob } from './review';
import { runRehearsalTurnJob } from './rehearsal';

/** AI 类任务的统一入口（AgentRunWorkflow 按 job.kind 路由到对应执行器） */
export async function runAiJob(env: Env, jobId: string): Promise<void> {
  const job = await getJob(env, jobId);
  switch (job.kind) {
    case 'agent_run':
      await runAgentJob(env, jobId);
      return;
    case 'review_run':
      await runReviewJob(env, jobId);
      return;
    case 'rehearsal_turn':
      await runRehearsalTurnJob(env, jobId);
      return;
    default:
      throw new Error(`任务类型 ${job.kind} 不属于 AI Workflow`);
  }
}
