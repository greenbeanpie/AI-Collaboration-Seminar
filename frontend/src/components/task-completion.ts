/** Keep completion tied to saved task counts, never the actionable-task subset. */
export function taskCompletion(completedCount: number, totalCount: number) {
  const total = Number.isFinite(totalCount) ? Math.max(0, Math.floor(totalCount)) : 0;
  const completed = Number.isFinite(completedCount) ? Math.min(total, Math.max(0, Math.floor(completedCount))) : 0;
  const ratio = total > 0 ? completed / total * 100 : 0;
  const complete = total > 0 && completed === total;
  // Rounding must not turn a nearly finished project into a completed one.
  const percent = complete ? 100 : Math.min(99, Math.round(ratio));
  const tone = complete ? 'green' : ratio >= 50 ? 'yellow' : 'red';
  return { completed, total, percent, ratio, tone };
}
