import { createApp } from './app';
import { handleScheduled } from './cron';
import { ParseSourceWorkflow } from './workflows/parse-source';
import { AgentRunWorkflow } from './workflows/ai-job';
import type { Env } from './env';

const app = createApp();

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  scheduled: (event, env, ctx) => {
    ctx.waitUntil(handleScheduled(env, event.cron));
  },
} satisfies ExportedHandler<Env>;

export { ParseSourceWorkflow, AgentRunWorkflow };
