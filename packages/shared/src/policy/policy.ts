import type { Principal } from '../domain/principal.js';

/**
 * Every bot action passes through a policy check before it takes effect.
 * Phase 1 allows everything (and records each check). Rules of engagement,
 * budget caps, stand-down and separation of duties plug in here later.
 */
export interface PolicyRequest {
  principal: Principal;
  /** e.g. `bot.step`, `credential.use`, `task.complete`. */
  action: string;
  unitId: string | null;
  taskId: string | null;
  details?: Record<string, unknown>;
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  /** When true the action is held and escalated rather than refused outright. */
  escalate?: boolean;
  /** What would clear it, for the person reading the refusal. */
  action?: string;
}

export interface PolicyRule {
  readonly name: string;
  evaluate(req: PolicyRequest): PolicyDecision | null | Promise<PolicyDecision | null>;
}
