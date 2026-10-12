import type { OperationPhase } from './entities.js';

/**
 * Operation lifecycle as an explicit state machine:
 * Intent → O Group → Backbrief → Execution → Handoffs → Sitreps → After Action → Closed.
 * A Frago is not a phase: it may be issued in any phase before After Action and
 * never changes the phase by itself.
 */
export const OPERATION_TRANSITIONS: Record<OperationPhase, readonly OperationPhase[]> = {
  intent: ['o-group'],
  'o-group': ['backbrief'],
  // A rejected backbrief goes back to the O Group for re-planning.
  backbrief: ['execution', 'o-group'],
  execution: ['handoffs', 'sitreps', 'after-action'],
  handoffs: ['execution', 'sitreps', 'after-action'],
  sitreps: ['execution', 'handoffs', 'after-action'],
  'after-action': ['closed'],
  closed: [],
};

export function canTransition(from: OperationPhase, to: OperationPhase): boolean {
  return OPERATION_TRANSITIONS[from].includes(to);
}

export function canIssueFrago(phase: OperationPhase): boolean {
  return phase !== 'after-action' && phase !== 'closed';
}
