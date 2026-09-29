import { createApp } from './app';
import { handleScheduled } from './cron';
import type { Env } from './env';

const app = createApp();

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  scheduled: (event, env, ctx) => {
    ctx.waitUntil(handleScheduled(env));
  },
} satisfies ExportedHandler<Env>;
