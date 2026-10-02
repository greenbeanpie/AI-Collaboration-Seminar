/** Stable topological order; dependencies outside this list do not hide historical tasks. */
export function dependencyOrder<T extends { taskId: string; dependsOnTaskIds?: string[] }>(tasks: T[]): T[] {
  const ordered: T[] = [];
  const byId = new Map(tasks.map(task => [task.taskId, task]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (task: T) => {
    if (visited.has(task.taskId) || visiting.has(task.taskId)) return;
    visiting.add(task.taskId);
    for (const id of task.dependsOnTaskIds ?? []) { const parent = byId.get(id); if (parent) visit(parent); }
    visiting.delete(task.taskId);
    visited.add(task.taskId);
    ordered.push(task);
  };
  tasks.forEach(visit);
  return ordered;
}
