const activeMediaStatuses = ['pending', 'uploading', 'processing', 'generating'];

/** True while an imported audio/video file is still being uploaded or summarized. */
export function isMediaProcessing(status: string | null | undefined): boolean {
  return activeMediaStatuses.includes(status ?? '');
}
