export type HierarchyTask = { taskId: string; title: string; parentTaskId?: string | null; status?: string; dependsOnTaskIds?: string[] };

export function taskAncestors<T extends HierarchyTask>(task: T, tasks: readonly T[]): T[] {
  const byId = new Map(tasks.map(row => [row.taskId, row]));
  const seen = new Set([task.taskId]);
  const ancestors: T[] = [];
  let parent = task.parentTaskId ? byId.get(task.parentTaskId) : undefined;
  while (parent && !seen.has(parent.taskId)) {
    seen.add(parent.taskId); ancestors.unshift(parent);
    parent = parent.parentTaskId ? byId.get(parent.parentTaskId) : undefined;
  }
  return ancestors;
}

/** Keep ancestors as context, never invent a second parent from dependency edges. */
export function taskTreeRows<T extends HierarchyTask>(tasks: readonly T[], matches: (task: T) => boolean, collapsed: ReadonlySet<string>, filtering: boolean) {
  const byId = new Map(tasks.map(task => [task.taskId, task]));
  const children = new Map<string, T[]>();
  for (const task of tasks) {
    const key = task.parentTaskId && byId.has(task.parentTaskId) ? task.parentTaskId : '';
    children.set(key, [...(children.get(key) ?? []), task]);
  }
  const matching = new Set(tasks.filter(matches).map(task => task.taskId));
  const visible = new Set(matching);
  if (filtering) for (const task of tasks) if (matching.has(task.taskId)) for (const parent of taskAncestors(task, tasks)) visible.add(parent.taskId);
  const rows: Array<{ task: T; depth: number; contextOnly: boolean; children: T[] }> = [];
  const seen = new Set<string>();
  const visit = (task: T, depth: number) => {
    if (seen.has(task.taskId)) return;
    seen.add(task.taskId);
    if (filtering && !visible.has(task.taskId)) return;
    const childTasks = children.get(task.taskId) ?? [];
    rows.push({ task, depth, contextOnly: !matching.has(task.taskId), children: childTasks });
    if (filtering || !collapsed.has(task.taskId)) childTasks.forEach(child => visit(child, depth + 1));
  };
  (children.get('') ?? []).forEach(task => visit(task, 0));
  // Malformed historical cycles must not make the UI loop or lose all tasks.
  if (!rows.length && tasks.length) tasks.forEach(task => visit(task, 0));
  return rows;
}
