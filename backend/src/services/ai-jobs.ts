import { BackgroundContinuation } from './ai-execution-slices';
import { runProjectChatJob } from './project-ai-chat';
import { runTaskAssistancePlanJob } from './task-assistance-plan';
import { runMediaJob } from './media-summary';
import { runTaskAgentEligibilityJob } from './task-agent-eligibility';
import { runTaskSummaryJob } from './task-summary';
import { runStandardsGeneration } from './standards-generation';
import type { Env } from '../env';
import { getJob } from './jobs';
import { runAgentJob } from './agent';
import { runReviewJob } from './review';
import { runRehearsalTurnJob } from './rehearsal';
import { runRehearsalSpeechJob } from './rehearsal-speech';
import { runAssignmentSuggestionJob } from './assignment';
import { runCollaborationAiJob } from './collaboration-ai';
import { runParseJob } from './parse';

/** AI 类任务的统一入口（AgentRunWorkflow 按 job.kind 路由到对应执行器） */
export async function runAiJob(env: Env, jobId: string): Promise<void> {
  const job = await getJob(env, jobId);
  if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return;
  switch (job.kind) {
    case 'parse_source':
    case 'ocr_pages':
    case 'requirement_extract':
      { const result = await runParseJob(env, jobId); if (['running','busy'].includes(result.status)) throw new BackgroundContinuation(); }
      return;
    case 'agent_run':
      if(JSON.parse(job.input_json).operation==='project.chat'){await runProjectChatJob(env,jobId);return;}
      if (JSON.parse(job.input_json).operation === 'rehearsal.tts') { await runRehearsalSpeechJob(env,jobId); return; }
      if (JSON.parse(job.input_json).operation === 'collaboration.assistance-plan') { await runTaskAssistancePlanJob(env,jobId); return; }
      if(['media.draft','media.summary'].includes(JSON.parse(job.input_json).operation)){const input=JSON.parse(job.input_json);const result=await runMediaJob(env,jobId,input.sourceVersionId,1);if(['running','busy'].includes(result.status))throw new BackgroundContinuation();return;}
      if (JSON.parse(job.input_json).operation === 'collaboration.agent-eligibility') {
        await runTaskAgentEligibilityJob(env,jobId); return;
      }
      if (JSON.parse(job.input_json).operation === 'standards.generate') {
        await runStandardsGeneration(env,jobId); return;
      }
      if (JSON.parse(job.input_json).operation === 'collaboration.summary') {
        await runTaskSummaryJob(env,jobId); return;
      }
      if (typeof JSON.parse(job.input_json).operation === 'string' && JSON.parse(job.input_json).operation.startsWith('collaboration.')) {
        await runCollaborationAiJob(env, jobId);
        return;
      }
      await runAgentJob(env, jobId);
      return;
    case 'review_run':
      await runReviewJob(env, jobId);
      return;
    case 'rehearsal_turn':
      await runRehearsalTurnJob(env, jobId);
      return;
    case 'assignment_suggest':
      await runAssignmentSuggestionJob(env, jobId);
      return;
    default:
      throw new Error(`任务类型 ${job.kind} 不属于 AI Workflow`);
  }
}
