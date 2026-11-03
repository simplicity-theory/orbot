import {
  BadRequestException,
  ConflictException,
  Injectable,
  type OnModuleInit,
} from '@nestjs/common';
import {
  DEFAULT_SETTINGS,
  SETTINGS_ID,
  type Halt,
  type PolicyRule,
  type RecordVersion,
  type StandDownScope,
  type StandDownView,
  type TaskBody,
} from '@orbot/shared';
import { TaskRunner } from '../execution/task-runner.js';
import { PolicyService } from '../policy/policy.service.js';
import { RecordService } from '../record/record.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { OverseerService } from './overseer.service.js';

/** Status reason on tasks paused by a stand-down order; lifting the order resumes exactly these. */
export const STOOD_DOWN_BY_ORDER = 'Stood down by order:';

export interface StandDownTarget {
  scope: StandDownScope;
  targetId: string | null;
}

/**
 * Stand down: halt a bot, a unit or everything. Running work pauses with a handover
 * (TaskRunner writes one if the bot didn't), nothing new starts while the order is in
 * force (a policy rule refuses it), and lifting the order puts the paused work back in
 * the queue. The order itself is a versioned field: on the bot, the unit, or settings.
 */
@Injectable()
export class StandDownService implements OnModuleInit {
  constructor(
    private readonly record: RecordService,
    private readonly settings: SettingsService,
    private readonly runner: TaskRunner,
    private readonly overseer: OverseerService,
    private readonly policy: PolicyService,
  ) {}

  onModuleInit() {
    this.policy.addRule(this.rule());
  }

  /** Bot work refused while a stand-down order covers the bot. */
  private rule(): PolicyRule {
    return {
      name: 'Stand down',
      evaluate: async (req) => {
        if (req.principal.kind !== 'bot') return null;
        if (req.action !== 'task.start' && !req.action.startsWith('bot.')) return null;
        const halt = await this.haltFor(req.principal.id);
        if (!halt) return null;
        return {
          allowed: false,
          reason: `Stood down: ${halt.reason}`,
          action: 'Lift the stand-down order (Resume work), then start it again.',
        };
      },
    };
  }

  /** The order that covers a bot, if any: everything, its unit, or the bot itself. */
  async haltFor(botId: string): Promise<Halt | null> {
    const all = (await this.settings.get()).halt;
    if (all) return all;
    const bot = await this.record.getActive('bot', botId);
    if (!bot) return null;
    if (bot.body.halt) return bot.body.halt;
    return (await this.record.getActive('unit', bot.body.unitId))?.body.halt ?? null;
  }

  async view(): Promise<StandDownView> {
    const [settings, units, bots] = await Promise.all([
      this.settings.get(),
      this.record.listActive('unit'),
      this.record.listActive('bot'),
    ]);
    return {
      all: settings.halt ?? null,
      units: units
        .filter((u) => u.body.halt)
        .map((u) => ({ id: u.entityId, name: u.body.name, halt: u.body.halt! })),
      bots: bots
        .filter((b) => b.body.halt)
        .map((b) => ({
          id: b.entityId,
          callsign: b.body.callsign,
          unitId: b.body.unitId,
          halt: b.body.halt!,
        })),
    };
  }

  private async describe(t: StandDownTarget): Promise<{ label: string; unitIds: string[] }> {
    if (t.scope === 'all') {
      const units = await this.record.listActive('unit');
      return { label: 'All units', unitIds: units.map((u) => u.entityId) };
    }
    if (!t.targetId) throw new BadRequestException('Say which unit or bot.');
    if (t.scope === 'unit') {
      const unit = await this.record.requireActive('unit', t.targetId);
      return { label: unit.body.name, unitIds: [unit.entityId] };
    }
    const bot = await this.record.requireActive('bot', t.targetId);
    if (bot.body.isOverseer) {
      throw new BadRequestException({
        message: `${bot.body.callsign} is an Overseer and does no task work.`,
        action: 'Stand down its unit instead.',
      });
    }
    return { label: bot.body.callsign, unitIds: [bot.body.unitId] };
  }

  private async current(t: StandDownTarget): Promise<Halt | null> {
    if (t.scope === 'all') return (await this.settings.get()).halt ?? null;
    if (t.scope === 'unit') return (await this.record.requireActive('unit', t.targetId!)).body.halt;
    return (await this.record.requireActive('bot', t.targetId!)).body.halt;
  }

  /** The bots an order at this level covers (Overseers do no task work). */
  private async botsIn(t: StandDownTarget) {
    const bots = await this.record.listActive(
      'bot',
      t.scope === 'unit' ? { unitId: t.targetId! } : undefined,
    );
    return bots.filter(
      (b) =>
        !b.body.isOverseer &&
        b.body.status !== 'stood-down' &&
        (t.scope !== 'bot' || b.entityId === t.targetId),
    );
  }

  /** Give the order. Running work pauses with a handover; resolves once it has. */
  async standDown(t: StandDownTarget, reason: string, actor: string) {
    const { label, unitIds } = await this.describe(t);
    if (await this.current(t)) {
      throw new ConflictException({
        message: `${label} ${t.scope === 'all' ? 'are' : 'is'} already stood down.`,
        action: 'Resume work first if you want to give a new order.',
      });
    }
    const halt: Halt = { reason, by: actor, at: new Date().toISOString() };
    const bots = await this.botsIn(t);
    const running = bots
      .map((b) => b.body.currentTaskId)
      .filter((id): id is string => !!id && this.runner.isRunning(id));
    // Stop first, so a run that is refused by the policy rule finishes as stood down, not blocked.
    const stopping = running.map((id) => this.runner.stop(id, `${STOOD_DOWN_BY_ORDER} ${reason}`));

    await this.record.transaction(async (w) => {
      const ctx = { actor, reason: `Stand down: ${reason}` };
      if (t.scope === 'all') {
        if (await w.getActive('settings', SETTINGS_ID))
          await w.revise('settings', SETTINGS_ID, (b) => ({ ...b, halt }), ctx);
        else await w.create('settings', { ...DEFAULT_SETTINGS, halt }, ctx, SETTINGS_ID);
      } else if (t.scope === 'unit') {
        await w.revise('unit', t.targetId!, (b) => ({ ...b, halt }), ctx);
      } else {
        await w.revise('bot', t.targetId!, (b) => ({ ...b, halt }), ctx);
      }
      await w.event(
        'stand-down',
        { scope: t.scope, targetId: t.targetId, reason, pausedTaskIds: running },
        {
          unitId: t.scope === 'all' ? null : unitIds[0],
          botId: t.scope === 'bot' ? t.targetId : null,
        },
        actor,
      );
      for (const unitId of unitIds) {
        const here = bots.filter((b) => b.body.unitId === unitId);
        const paused = running.filter((id) => here.some((b) => b.body.currentTaskId === id));
        await w.event(
          'sitrep',
          {
            level: 'unit',
            text: `${label} stood down: ${reason}.${
              paused.length ? ` ${paused.length} task(s) paused with a handover.` : ''
            }`,
            status: 'stood-down',
          },
          { unitId },
          actor,
        );
      }
    });
    await Promise.all(stopping);
    return { label, pausedTaskIds: running };
  }

  /** Lift the order. Work it paused goes back in the queue and starts again. */
  async lift(t: StandDownTarget, reason: string, actor: string) {
    const { label, unitIds } = await this.describe(t);
    if (!(await this.current(t))) {
      throw new ConflictException({
        message: `${label} ${t.scope === 'all' ? 'are' : 'is'} not stood down.`,
        action: 'Nothing to resume.',
      });
    }
    const bots = await this.botsIn(t);
    const paused: RecordVersion<TaskBody>[] = [];
    for (const unitId of unitIds) {
      for (const task of await this.record.listActive('task', { unitId })) {
        if (
          task.body.status === 'stood-down' &&
          task.body.statusReason?.startsWith(STOOD_DOWN_BY_ORDER) &&
          bots.some((b) => b.entityId === task.body.botId)
        )
          paused.push(task);
      }
    }
    await this.record.transaction(async (w) => {
      const ctx = { actor, reason: `Resume work: ${reason}` };
      if (t.scope === 'all') {
        await w.revise('settings', SETTINGS_ID, (b) => ({ ...b, halt: null }), ctx);
      } else if (t.scope === 'unit') {
        await w.revise('unit', t.targetId!, (b) => ({ ...b, halt: null }), ctx);
      } else {
        await w.revise('bot', t.targetId!, (b) => ({ ...b, halt: null }), ctx);
      }
      for (const task of paused) {
        const why = `Resumed: ${reason}`;
        await w.revise(
          'task',
          task.entityId,
          (b) => ({ ...b, status: 'queued', statusReason: why, statusAction: null }),
          ctx,
        );
        await w.event(
          'task.status',
          { from: 'stood-down', to: 'queued', reason: why },
          {
            unitId: task.body.unitId,
            botId: task.body.botId,
            taskId: task.entityId,
            missionId: task.body.missionId,
          },
          actor,
        );
        // Back to the front of its bot's queue: it was that bot's current work.
        await w.revise(
          'bot',
          task.body.botId!,
          (b) =>
            b.queue.includes(task.entityId) ? b : { ...b, queue: [task.entityId, ...b.queue] },
          ctx,
        );
      }
      await w.event(
        'stand-down.lifted',
        {
          scope: t.scope,
          targetId: t.targetId,
          reason,
          resumedTaskIds: paused.map((p) => p.entityId),
        },
        {
          unitId: t.scope === 'all' ? null : unitIds[0],
          botId: t.scope === 'bot' ? t.targetId : null,
        },
        actor,
      );
      for (const unitId of unitIds) {
        await w.event(
          'sitrep',
          {
            level: 'unit',
            text: `${label}: stand-down lifted (${reason}). Back to work.`,
            status: null,
          },
          { unitId },
          actor,
        );
      }
    });
    // Overseer-issued work is dispatched; work the Commander started directly restarts here.
    for (const unitId of unitIds) this.overseer.dispatchSoon(unitId);
    for (const task of paused.filter((p) => !p.body.autoStart)) {
      if (!(await this.haltFor(task.body.botId!))) {
        await this.runner.start(task.entityId, actor).catch(() => undefined);
      }
    }
    return { label, resumedTaskIds: paused.map((p) => p.entityId) };
  }
}
