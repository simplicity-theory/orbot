import { Injectable } from '@nestjs/common';
import {
  describeHoldPolicy,
  effectiveHoldPolicy,
  type HoldPolicy,
  type RecordVersion,
  type TaskBody,
  type UnitBody,
} from '@orbot/shared';
import { RecordService, type WriteContext } from '../record/record.service.js';

/**
 * The hold policy: what a bot fixes on its own, what it records, and what holds the work for
 * the Commander. Set per unit; an operation may override it for its own work. It is briefed,
 * not enforced by code: judging a finding's severity and a fix's size is the bot's call, and
 * the record shows what it decided (D106).
 */
@Injectable()
export class HoldPolicyService {
  constructor(private readonly record: RecordService) {}

  setUnit(unitId: string, policy: HoldPolicy, ctx: WriteContext) {
    return this.record.revise('unit', unitId, (u) => ({ ...u, holdPolicy: policy }), {
      ...ctx,
      reason: ctx.reason || `Hold policy: ${describeHoldPolicy(policy)}`,
    });
  }

  /** null clears the override: each unit's own policy applies again. */
  setOperation(operationId: string, policy: HoldPolicy | null, ctx: WriteContext) {
    return this.record.revise('operation', operationId, (o) => ({ ...o, holdPolicy: policy }), {
      ...ctx,
      reason:
        ctx.reason ||
        (policy
          ? `Hold policy for this operation: ${describeHoldPolicy(policy)}`
          : 'Hold policy: back to each unit’s own'),
    });
  }

  /** The policy that applies to a task: its operation's override, else its unit's. */
  async effectiveFor(
    task: RecordVersion<TaskBody>,
    unit: RecordVersion<UnitBody>,
  ): Promise<HoldPolicy> {
    const mission = task.body.missionId
      ? await this.record.getActive('mission', task.body.missionId)
      : null;
    const op = mission?.body.operationId
      ? await this.record.getActive('operation', mission.body.operationId)
      : null;
    return effectiveHoldPolicy(unit.body.holdPolicy, op?.body.holdPolicy ?? null);
  }
}
