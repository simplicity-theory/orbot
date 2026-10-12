import { Injectable } from '@nestjs/common';
import { actorRef, type PolicyDecision, type PolicyRequest, type PolicyRule } from '@orbot/shared';
import { RecordService } from '../record/record.service.js';

export const POLICY_RULES = Symbol('POLICY_RULES');

/**
 * Every bot action passes through here before it takes effect.
 * Rules are evaluated in order; the first non-null decision wins; no decision = allowed.
 * Refusals and escalations are written to the record. (Allowed actions are
 * evidenced by the resulting record entry itself.)
 *
 * Phase 1 ships with no rules. Rules of engagement, budget caps, stand-down and
 * separation of duties are added as PolicyRules later, without touching callers.
 */
@Injectable()
export class PolicyService {
  private readonly rules: PolicyRule[] = [];

  constructor(private readonly record: RecordService) {}

  addRule(rule: PolicyRule): void {
    this.rules.push(rule);
  }

  async check(req: PolicyRequest): Promise<PolicyDecision> {
    for (const rule of this.rules) {
      const d = await rule.evaluate(req);
      if (d) {
        if (!d.allowed || d.escalate) {
          await this.record.event(
            'policy.check',
            { action: req.action, allowed: d.allowed, reason: `${rule.name}: ${d.reason}` },
            { unitId: req.unitId, taskId: req.taskId, botId: req.principal.kind === 'bot' ? req.principal.id : null },
            actorRef(req.principal),
          );
        }
        return d;
      }
    }
    return { allowed: true, reason: 'No rule objected.' };
  }
}
