import { executionOf } from '../api/ai-execution';
import { isMediaProcessing } from './media-processing';

export type PollableDraftFile = {
  mediaStatus?: string | null;
  audio?: { phase?: string | null } | null;
};

export type PollableDraftState = {
  id: string;
  revision: number;
  previewState?: string;
  files: PollableDraftFile[];
};

export function isDraftPreviewRunning(draft: PollableDraftState | null | undefined): boolean {
  return Boolean(draft?.previewState === 'running' && executionOf(draft)?.state !== 'paused');
}

export function hasDraftMediaPending(draft: PollableDraftState | null | undefined): boolean {
  return draft?.files.some(file => isMediaProcessing(file.mediaStatus ?? undefined)) ?? false;
}

export function hasDraftMediaPolling(draft: PollableDraftState | null | undefined): boolean {
  return draft?.files.some(file => file.audio?.phase !== 'waiting_config' && isMediaProcessing(file.mediaStatus ?? undefined)) ?? false;
}

export function draftPollIntervalMs(draft: PollableDraftState | null | undefined): number | false {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
  if (!draft) return 3000;
  return draft.previewState === 'running' || hasDraftMediaPolling(draft) ? 3000 : false;
}
