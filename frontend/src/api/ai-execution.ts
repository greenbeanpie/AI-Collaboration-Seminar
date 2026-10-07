export type ExecutionView = { generation: number; windowCalls: number; totalCalls: number; limit: number; state: 'running' | 'paused' | 'finalizing' | 'cancelled' | 'completed'; pauseReason: string | null; canContinue: boolean; canOutput: boolean };
export function executionOf(value: unknown): ExecutionView | null { return (value as { execution?: ExecutionView | null } | null)?.execution ?? null; }
export function olderExecution(next: unknown, current: unknown): boolean { const a = executionOf(next), b = executionOf(current); return Boolean(a && b && a.generation < b.generation); }
