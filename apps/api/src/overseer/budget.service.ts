import { BadRequestException, Injectable, type OnModuleInit } from '@nestjs/common';
import { budgetView, type BudgetView, type PolicyRule, type PolicyRequest } from '@orbot/shared';
import { TaskRunner } from '../execution/task-runner.js';
import { PolicyService } from '../policy/policy.service.js';
import { RecordService } from '../record/record.service.js';
import { SettingsService } from '../settings/settings.service.js';

/** Status reason prefix on tasks held at a budget cap; raising the cap releases exactly these. */
export const BUDGET_HELD = 'Compute budget cap reached';

interface Line {
  scope: 'unit' | 'operation' | 'task';
  targetId: string;
  label: string;
  unitId: string;
  cap: number;
  spent: number;
}

/**
 * Budget caps: a hard limit per unit, per operation and per task, with a warning first.
 * Spend is the sum of `cost` events in the record. A policy rule refuses to start work at a
 * cap and stops a run as soon as a cost takes it there (the task is blocked, with the reason).
 * Raising the cap releases the work it held.
 */
@Injectable()
export class BudgetService implements OnModuleInit {
  constructor(
    private readonly record: RecordService,
    private readonly settings: SettingsService,
    private readonly policy: PolicyService,
    private readonly runner: TaskRunner,
  ) {}

  onModuleInit() {
    this.policy.addRule(this.rule());
  }

  private rule(): PolicyRule {
    return {
      name: 'Budget cap',
      evaluate: async (req) => {
        if (req.action !== 'task.start' && req.action !== 'task.continue') return null;
        if (!req.taskId) return null;
        const lines = await this.lines(req.taskId);
        if (req.action === 'task.continue') await this.warn(lines, req);
        const over = lines.find((l) => l.spent >= l.cap);
        if (!over) return null;
        return {
          allowed: false,
          reason: `${BUDGET_HELD}: ${over.label} has used ${over.spent} of ${over.cap} units`,
          action:
            over.scope === 'unit'
              ? `Raise ${over.label}'s compute budget (unit page, or in chat: “Give ${over.label} 20 more compute budget”).`
              : over.scope === 'operation'
                ? `Raise the budget of ${over.label} on its operation page.`
                : 'Raise or remove the task’s own budget limit.',
        };
      },
    };
  }

  /** Every cap that applies to a task: its unit's, its operation's and its own. */
  private async lines(taskId: string): Promise<Line[]> {
    const task = await this.record.getActive('task', taskId);
    if (!task) return [];
    const t = task.body;
    const out: Line[] = [];
    const unit = await this.record.getActive('unit', t.unitId);
    if (unit && unit.body.computeBudget > 0) {
      out.push({
        scope: 'unit',
        targetId: unit.entityId,
        label: unit.body.name,
        unitId: t.unitId,
        cap: unit.body.computeBudget,
        spent: await this.record.costOf({ unitId: unit.entityId }),
      });
    }
    const mission = t.missionId ? await this.record.getActive('mission', t.missionId) : null;
    const opId = mission?.body.operationId ?? null;
    const op = opId ? await this.record.getActive('operation', opId) : null;
    if (op && op.body.budgetUnits !== null) {
      out.push({
        scope: 'operation',
        targetId: op.entityId,
        label: `Operation ${op.body.name}`,
        unitId: t.unitId,
        cap: op.body.budgetUnits,
        spent: await this.record.costOf({ operationId: op.entityId }),
      });
    }
    if (t.budget.limitUnits !== null) {
      out.push({
        scope: 'task',
        targetId: taskId,
        label: `Task #${t.number}`,
        unitId: t.unitId,
        cap: t.budget.limitUnits,
        spent: await this.record.costOf({ taskId }),
      });
    }
    return out;
  }

  /** A cost just crossed the warning share of a budget (and not the cap): say so, once. */
  private async warn(lines: Line[], req: PolicyRequest) {
    const added = Number(req.details?.['units'] ?? 0);
    if (!added) return;
    const { budgetWarnAt } = await this.settings.get();
    for (const l of lines) {
      const at = l.cap * budgetWarnAt;
      if (l.spent - added >= at || l.spent < at || l.spent >= l.cap) continue;
      await this.record.transaction(async (w) => {
        await w.event(
          'budget.warning',
          { scope: l.scope, targetId: l.targetId, label: l.label, spent: l.spent, cap: l.cap },
          {
            unitId: l.unitId,
            taskId: req.taskId,
            operationId: l.scope === 'operation' ? l.targetId : null,
          },
          'system:budget',
        );
        await w.event(
          'sitrep',
          {
            level: 'unit',
            text: `Budget warning: ${l.label} has used ${l.spent} of ${l.cap} compute units (${Math.round(
              (l.spent / l.cap) * 100,
            )}%). Work stops at the cap.`,
            status: null,
          },
          { unitId: l.unitId, taskId: req.taskId },
          'system:budget',
        );
      });
    }
  }

  async unitBudget(unitId: string): Promise<BudgetView> {
    const unit = await this.record.requireActive('unit', unitId);
    const { budgetWarnAt } = await this.settings.get();
    const cap = unit.body.computeBudget > 0 ? unit.body.computeBudget : null;
    return budgetView(cap, await this.record.costOf({ unitId }), budgetWarnAt);
  }

  /** Set a unit's cap (0 = none). Work held at the old cap is released. */
  async setUnitCap(unitId: string, units: number | null, reason: string, actor: string) {
    if (units === null) throw new BadRequestException('Give a number of units (0 for no cap).');
    const unit = await this.record.requireActive('unit', unitId);
    const from = unit.body.computeBudget;
    await this.record.revise('unit', unitId, (b) => ({ ...b, computeBudget: units }), {
      actor,
      reason: `Compute budget ${from} → ${units}: ${reason}`,
    });
    const released = await this.release({ unitId }, actor);
    await this.record.event(
      'budget.set',
      { scope: 'unit', targetId: unitId, from, to: units, releasedTaskIds: released },
      { unitId },
      actor,
    );
    return released;
  }

  /** Set an operation's cap (null = none). Work held at the old cap is released. */
  async setOperationCap(opId: string, units: number | null, reason: string, actor: string) {
    const op = await this.record.requireActive('operation', opId);
    const from = op.body.budgetUnits;
    await this.record.revise('operation', opId, (b) => ({ ...b, budgetUnits: units }), {
      actor,
      reason: `Budget ${from ?? 'none'} → ${units ?? 'none'}: ${reason}`,
    });
    const released = await this.release({ operationId: opId }, actor);
    await this.record.event(
      'budget.set',
      { scope: 'operation', targetId: opId, from, to: units, releasedTaskIds: released },
      { operationId: opId },
      actor,
    );
    return released;
  }

  /**
   * Start again the tasks a budget cap held, in a unit or an operation. Each start goes
   * through the policy check again, so a task still over another cap stays held.
   */
  async release(scope: { unitId: string } | { operationId: string }, actor: string) {
    let tasks = await this.record.listActive(
      'task',
      'unitId' in scope ? { unitId: scope.unitId } : undefined,
    );
    if ('operationId' in scope) {
      const op = await this.record.requireActive('operation', scope.operationId);
      tasks = tasks.filter(
        (t) => t.body.missionId && op.body.missionIds.includes(t.body.missionId),
      );
    }
    const held = tasks.filter(
      (t) =>
        t.body.status === 'blocked' &&
        t.body.statusReason?.includes(BUDGET_HELD) &&
        !this.runner.isRunning(t.entityId),
    );
    const released: string[] = [];
    for (const t of held) {
      try {
        await this.runner.start(t.entityId, actor);
        released.push(t.entityId);
      } catch {
        // Still over a cap (or otherwise unable to start): it stays blocked, with its reason.
      }
    }
    return released;
  }
}
