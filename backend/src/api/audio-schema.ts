import { z } from '@hono/zod-openapi';

/** Public quality metadata only; private transcript content stays in R2. */
export const audioStatusSchema = z.object({
  phase: z.string(),
  qualityScore: z.number().min(0).max(1).nullable(),
  reasons: z.array(z.string()),
  transcriptAvailable: z.boolean(),
  canResumeFallback: z.boolean(),
});
export const audioResumeSchema = z.object({ jobId: z.string().uuid(), status: z.string() });
