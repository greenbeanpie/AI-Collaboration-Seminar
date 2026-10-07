/** Public execution progress; generations fence stale actions and late responses. */
export interface ExecutionTarget { kind: 'job' | 'draft_preview'; id: string }
export type ExecutionState = 'running' | 'paused' | 'finalizing' | 'cancelled' | 'completed';
export type ExecutionPauseReason = 'round_limit' | 'request_uncertain' | 'output_invalid' | 'interrupted';
export interface ExecutionView {
  generation: number;
  windowCalls: number;
  totalCalls: number;
  limit: number;
  state: ExecutionState;
  pauseReason: ExecutionPauseReason | null;
  canContinue: boolean;
  canOutput: boolean;
}
export interface AiExecutionPolicy { version: number; maxModelCalls: number }
