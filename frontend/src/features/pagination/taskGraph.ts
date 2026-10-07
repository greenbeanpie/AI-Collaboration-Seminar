import { projectRequest } from '../../api/simplification';
import type { Task } from '../../api/types';
export async function completeTaskGraph(projectId: string): Promise<Task[]> {
  const graph = await projectRequest<{ items: Task[] }>(projectId, '/tasks/graph');
  return graph.items;
}
