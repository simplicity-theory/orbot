import { ForbiddenException, Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  BackbriefBody,
  BotBody,
  PolicyRule,
  SettingsBody,
  TaskBody,
  UnitBody,
} from '@orbot/shared';
import { RecordService, type GuardedChange } from '../record/record.service.js';
import { PolicyService } from './policy.service.js';

/** What a bot was trying to do to itself (or its own unit). */
export type Duty =
  'approve-own-work' | 'change-own-rules' | 'grant-own-supply' | 'lift-own-stand-down';

const REFUSAL: Record<Duty, string> = {
  'approve-own-work': 'a bot cannot approve its own work (or its own unit’s)',
  'change-own-rules': 'a bot cannot change its own unit’s rules',
  'grant-own-supply': 'a bot cannot grant itself (or its unit) supply',
  'lift-own-stand-down': 'a bot cannot lift a stand-down that covers itself',
};

/**
 * Separation of duties: a bot can't approve its own work, change its own rules, or grant
 * itself supply (nor lift its own stand-down). Enforced on every entity write, whatever
 * path it comes by: the record calls this guard before a version lands. A refusal is a
 * policy decision on the record ("Separation of duties: …") and the write is rolled back.
 * The Commander, HQ and other system actors are not bots and are not limited by this.
 */
@Injectable()
export class DutiesService implements OnModuleInit {
  constructor(
    private readonly record: RecordService,
    private readonly policy: PolicyService,
  ) {}

  onModuleInit() {
    this.policy.addRule(this.rule());
    this.record.addGuard((c) => this.guard(c));
  }

  private rule(): PolicyRule {
    return {
      name: 'Separation of duties',
      evaluate: (req) => {
        if (req.principal.kind !== 'bot' || !req.action.startsWith('duty:')) return null;
        const duty = req.action.slice('duty:'.length) as Duty;
        return {
          allowed: false,
          reason: REFUSAL[duty] ?? 'not allowed for a bot',
          action: 'Ask the Commander (or HQ) to do it.',
        };
      },
    };
  }

  private async guard(c: GuardedChange): Promise<void> {
    if (!c.actor.startsWith('bot:')) return;
    const botId = c.actor.slice('bot:'.length);
    const bot = await this.record.getActive('bot', botId);
    if (!bot) return;
    const hit = this.duty(c, botId, bot.body);
    if (!hit) return;
    const d = await this.policy.check({
      principal: { kind: 'bot', id: botId, displayName: bot.body.callsign },
      action: `duty:${hit.duty}`,
      unitId: hit.unitId,
      taskId: hit.taskId,
      details: { entity: c.type, id: c.id },
    });
    if (!d.allowed) {
      throw new ForbiddenException({
        message: `Refused: ${bot.body.callsign} — ${d.reason}.`,
        action: d.action ?? 'Ask the Commander.',
      });
    }
  }

  /** Is this write a bot doing one of the things it may not do to itself? */
  private duty(
    c: GuardedChange,
    botId: string,
    bot: BotBody,
  ): { duty: Duty; unitId: string | null; taskId: string | null } | null {
    const own = { unitId: bot.unitId, taskId: null };
    switch (c.type) {
      case 'unit': {
        if (c.id !== bot.unitId) return null;
        const b = (c.before ?? {}) as Partial<UnitBody>;
        const a = c.after as UnitBody;
        const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
        if (
          !same(b.standingOrders, a.standingOrders) ||
          !same(b.rulesOfEngagement, a.rulesOfEngagement) ||
          !same(b.approvalGate, a.approvalGate) ||
          !same(b.holdPolicy, a.holdPolicy)
        )
          return { duty: 'change-own-rules', ...own };
        if (
          a.supplyIds.some((s) => !(b.supplyIds ?? []).includes(s)) ||
          (a.computeBudget ?? 0) > (b.computeBudget ?? 0)
        )
          return { duty: 'grant-own-supply', ...own };
        if (b.halt && !a.halt) return { duty: 'lift-own-stand-down', ...own };
        return null;
      }
      case 'bot': {
        const b = (c.before ?? {}) as Partial<BotBody>;
        const a = c.after as BotBody;
        if (c.id === botId && b.halt && !a.halt) return { duty: 'lift-own-stand-down', ...own };
        return null;
      }
      case 'settings': {
        const b = (c.before ?? {}) as Partial<SettingsBody>;
        const a = c.after as SettingsBody;
        if (b.halt && !a.halt) return { duty: 'lift-own-stand-down', ...own };
        // The main effort orders every unit's priorities, its own included.
        if (
          (b.mainEffort?.operationId ?? null) !== (a.mainEffort?.operationId ?? null) ||
          (b.mainEffortYield ?? true) !== (a.mainEffortYield ?? true)
        )
          return { duty: 'change-own-rules', ...own };
        return null;
      }
      case 'backbrief': {
        const b = (c.before ?? {}) as Partial<BackbriefBody>;
        const a = c.after as BackbriefBody;
        const decided = a.status !== b.status && a.status === 'approved';
        if (decided && (a.overseerBotId === botId || a.unitId === bot.unitId))
          return { duty: 'approve-own-work', unitId: a.unitId, taskId: null };
        return null;
      }
      case 'task': {
        const b = (c.before ?? {}) as Partial<TaskBody>;
        const a = c.after as TaskBody;
        if (a.unitId !== bot.unitId) return null;
        const t = { unitId: a.unitId, taskId: c.id };
        if (a.approval?.status === 'approved' && b.approval?.status !== 'approved')
          return { duty: 'approve-own-work', ...t };
        // Deciding a permission request its own unit made (either way) is the chain's job.
        if (b.permission?.status === 'pending' && a.permission?.status !== 'pending')
          return { duty: 'approve-own-work', ...t };
        if (
          a.botId === botId &&
          a.credentialNames.some((n) => !(b.credentialNames ?? []).includes(n))
        )
          return { duty: 'grant-own-supply', ...t };
        if (
          a.botId === botId &&
          (a.budget?.limitUnits ?? Infinity) > (b.budget?.limitUnits ?? Infinity)
        )
          return { duty: 'grant-own-supply', ...t };
        return null;
      }
      default:
        return null;
    }
  }
}
