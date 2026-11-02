import type { OperationPhase } from './entities.js';

/**
 * Operation lifecycle as an explicit state machine:
 * Intent → O Group → Backbrief → Execution → Handoffs → Sitreps → After Action → Closed.
 * A Frago is not a phase: it may be issued in any phase before After Action and
 * never changes the phase by itself.
 */
export const OPERATION_TRANSITIONS: Record<OperationPhase, readonly OperationPhase[]> = {
  intent: ['o-group', 'closed'],
  'o-group': ['backbrief', 'closed'],
  // A rejected backbrief goes back to the O Group for re-planning.
  backbrief: ['execution', 'o-group', 'closed'],
  // Back to the O Group when the main repository changes: the missions are issued again there.
  // Closed straight away when the Commander cancels.
  execution: ['handoffs', 'sitreps', 'after-action', 'o-group', 'closed'],
  handoffs: ['execution', 'sitreps', 'after-action', 'o-group', 'closed'],
  sitreps: ['execution', 'handoffs', 'after-action', 'o-group', 'closed'],
  'after-action': ['closed'],
  closed: [],
};

export function canTransition(from: OperationPhase, to: OperationPhase): boolean {
  return OPERATION_TRANSITIONS[from].includes(to);
}

export function canIssueFrago(phase: OperationPhase): boolean {
  return phase !== 'after-action' && phase !== 'closed';
}
