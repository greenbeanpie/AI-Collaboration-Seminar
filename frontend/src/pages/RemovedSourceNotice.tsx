/** Historical reports keep their evidence, but retired manual records cannot be read again. */
export function RemovedSourceNotice({ payload }: { payload: unknown }) {
  if (!payload || typeof payload !== 'object') return null;
  const references = (payload as Record<string, unknown>).references;
  const removed = Array.isArray(references) ? references.filter(reference => reference && typeof reference === 'object' && (reference as Record<string, unknown>).resourceType === 'decision') : [];
  if (!removed.length) return null;
  return <p className="notice notice-warn" role="status">来源已移除：本记录包含 {removed.length} 项历史决策记录引用，无法重新读取，请核对现有资料。</p>;
}
