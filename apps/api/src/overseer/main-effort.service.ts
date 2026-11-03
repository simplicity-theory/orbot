import {
  BadRequestException,
  ConflictException,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  DEFAULT_SETTINGS,
  SETTINGS_ID,
  type MainEffort,
  type MainEffortView,
  type RecordVersion,
  type TaskBody,
} from '@orbot/shared';
import type { Subscription } from 'rxjs';
import { Background } from '../common/background.js';
import { TaskRunner } from '../execution/task-runner.js';
import { RecordBus } from '../record/record-bus.js';
import { RecordService } from '../record/record.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { OverseerService } from './overseer.service.js';
import { mainEffortMissionIds } from './main-effort.js';
import { HQ_ACTOR } from './overseers.js';

/** Status reason on supporting work paused for the main effort. */
export const YIELDED_TO_MAIN_EFFORT = 'Made way for the main effort:';

/**
 * The main effort: one operation the force puts first. Overseers start its tasks before
 * supporting work. When one of its tasks is ready but its bot is busy, the Overseer moves
 * it to a free bot in the unit; if there is none and the setting allows, a bot's running
 * supporting task makes way: it pauses with a handover and goes back in the queue behind
 * the main effort. Commander-started work is never paused for it.
 */
@Injectable()
export class MainEffortService implements OnApplicationBootstrap, OnModuleDestroy {
  private sub: Subscription | null = null;

  constructor(
    private readonly record: RecordService,
    private readonly settings: SettingsService,
    private readonly bus: RecordBus,
    private readonly background: Background,
    private readonly runner: TaskRunner,
    private readonly overseer: OverseerService,
  ) {}

  onApplicationBootstrap(): void {
    this.sub = this.bus.notifications$.subscribe((n) => {
      if (n.type !== 'version') return;
      const v = n.version;
      const b = v.body as Record<string, unknown>;
      if (v.entityType === 'task' && v.unitId && b['status'] === 'queued' && b['autoStart']) {
        this.reinforceSoon(v.unitId);
      } else if (v.entityType === 'mission' && v.unitId && b['status'] !== 'waiting') {
        this.reinforceSoon(v.unitId);
      } else if (v.entityType === 'operation' && b['phase'] === 'closed') {
        const id = v.entityId;
        this.background.run('hq:main-effort', 'main-effort:closed', async () => {
          const me = (await this.settings.get()).mainEffort;
          if (me?.operationId === id)
            await this.set(null, 'The operation is closed', HQ_ACTOR).catch(() => undefined);
        });
      }
    });
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
  }

  async view(): Promise<MainEffortView> {
    const s = await this.settings.get();
    const op = s.mainEffort
      ? await this.record.getActive('operation', s.mainEffort.operationId)
      : null;
    return {
      mainEffort: s.mainEffort ?? null,
      operation: op ? { id: op.entityId, name: op.body.name, phase: op.body.phase } : null,
      missionIds: op?.body.missionIds ?? [],
      yieldEnabled: s.mainEffortYield ?? true,
    };
  }

  /** Name the main effort (or clear it with null). Returns the previous one, for Undo. */
  async set(
    operationId: string | null,
    reason: string,
    actor: string,
  ): Promise<{ previous: string | null; label: string }> {
    const before = (await this.settings.get()).mainEffort ?? null;
    const op = operationId ? await this.record.requireActive('operation', operationId) : null;
    if (op && op.body.phase === 'closed') {
      throw new BadRequestException({
        message: `Operation ${op.body.name} is closed.`,
        action: 'Name an operation that is still under way.',
      });
    }
    if ((before?.operationId ?? null) === operationId) {
      throw new ConflictException({
        message: op
          ? `Operation ${op.body.name} is already the main effort.`
          : 'There is no main effort.',
        action: op ? 'Nothing to change.' : 'Name an operation to make it the main effort.',
      });
    }
    const prev = before ? await this.record.getActive('operation', before.operationId) : null;
    const mainEffort: MainEffort | null = op
      ? { operationId: op.entityId, reason, by: actor, at: new Date().toISOString() }
      : null;
    const label = op ? `Operation ${op.body.name}` : 'No main effort';
    const units = await this.record.listActive('unit');
    await this.record.transaction(async (w) => {
      const ctx = {
        actor,
        reason: op ? `Main effort: ${op.body.name} (${reason})` : `Main effort cleared (${reason})`,
      };
      if (await w.getActive('settings', SETTINGS_ID))
        await w.revise('settings', SETTINGS_ID, (b) => ({ ...b, mainEffort }), ctx);
      else await w.create('settings', { ...DEFAULT_SETTINGS, mainEffort }, ctx, SETTINGS_ID);
      await w.event(
        'main-effort',
        {
          operationId: op?.entityId ?? null,
          previousOperationId: before?.operationId ?? null,
          reason,
        },
        { operationId: op?.entityId ?? before?.operationId ?? null },
        actor,
      );
      const text = op
        ? `HQ: Operation ${op.body.name} is now the main effort (${reason}). Its tasks go first${
            prev ? `; Operation ${prev.body.name} becomes a supporting effort` : ''
          }.`
        : `HQ: no main effort any more (${reason}). ${
            prev ? `Operation ${prev.body.name}` : 'All work'
          } is worked in normal queue order.`;
      for (const u of units) {
        await w.event(
          'sitrep',
          { level: 'hq', text, status: null },
          { unitId: u.entityId, operationId: op?.entityId ?? null },
          HQ_ACTOR,
        );
      }
    });
    for (const u of units) {
      this.reinforceSoon(u.entityId);
      this.overseer.dispatchSoon(u.entityId);
    }
    return { previous: before?.operationId ?? null, label };
  }

  private reinforceSoon(unitId: string) {
    this.background.run(`unit:${unitId}`, 'main-effort', () => this.reinforce(unitId));
  }

  /**
   * Main-effort tasks that are ready but whose bot is busy: move them to a free bot, or
   * have a bot's supporting work make way. Runs in the unit's queue, after dispatch.
   */
  async reinforce(unitId: string): Promise<void> {
    const s = await this.settings.get();
    if (!s.mainEffort || s.halt) return;
    const unit = await this.record.getActive('unit', unitId);
    if (!unit || unit.body.halt) return;
    const missionIds = await mainEffortMissionIds(this.record);
    if (!missionIds.size) return;
    const op = await this.record.getActive('operation', s.mainEffort.operationId);
    const opName = op?.body.name ?? 'the main effort';

    const bots = (await this.record.listActive('bot', { unitId })).filter(
      (b) => !b.body.isOverseer && !b.body.halt,
    );
    const tasks = await this.record.listActive('task', { unitId });
    const isMe = (t: TaskBody) => !!t.missionId && missionIds.has(t.missionId);
    const ready: RecordVersion<TaskBody>[] = [];
    for (const t of tasks) {
      if (t.body.status !== 'queued' || !t.body.autoStart || !isMe(t.body)) continue;
      if (t.body.kind === 'deploy' && t.body.approval?.status === 'pending') continue;
      const m = await this.record.getActive('mission', t.body.missionId!);
      if (m?.body.status === 'waiting') continue;
      ready.push(t);
    }
    // Bots that are free and have main-effort work of their own: dispatch starts it.
    const taken = new Set<string>();
    for (const t of ready) {
      const own = bots.find((b) => b.entityId === t.body.botId);
      if (own?.body.status === 'idle') taken.add(own.entityId);
    }
    const claimed = new Set<string>();
    for (const task of ready) {
      const own = bots.find((b) => b.entityId === task.body.botId);
      // Its own bot is free: dispatch starts it (one per bot; the rest look for another bot).
      if (own?.body.status === 'idle' && !claimed.has(own.entityId)) {
        claimed.add(own.entityId);
        continue;
      }
      const free = bots.find((b) => b.body.status === 'idle' && !taken.has(b.entityId));
      if (free) {
        taken.add(free.entityId);
        await this.record.transaction(async (w) => {
          await this.overseer.reassign(
            task.entityId,
            {
              botId: free.entityId,
              reason: `Main effort (${opName}): ${free.body.callsign} is free`,
            },
            HQ_ACTOR,
            w,
          );
          await w.event(
            'main-effort.yield',
            {
              mainEffortTaskId: task.entityId,
              how: 'moved',
              yieldedTaskId: null,
              toBotId: free.entityId,
            },
            { unitId, botId: free.entityId, taskId: task.entityId, missionId: task.body.missionId },
            HQ_ACTOR,
          );
        });
        continue;
      }
      if (!(s.mainEffortYield ?? true)) continue;
      // No free bot: a bot on supporting work (Overseer-dispatched, not Commander-started) makes way.
      const supporting = async (b: (typeof bots)[number]) => {
        if (taken.has(b.entityId) || b.body.status !== 'working' || !b.body.currentTaskId)
          return null;
        const cur = await this.record.getActive('task', b.body.currentTaskId);
        if (!cur || isMe(cur.body) || !cur.body.autoStart || !this.runner.isRunning(cur.entityId))
          return null;
        return cur;
      };
      let victimBot = own ?? null;
      let victim = own ? await supporting(own) : null;
      if (!victim) {
        for (const b of bots) {
          victim = await supporting(b);
          if (victim) {
            victimBot = b;
            break;
          }
        }
      }
      if (!victim || !victimBot) continue;
      taken.add(victimBot.entityId);
      if (victimBot.entityId !== task.body.botId) {
        await this.overseer.reassign(
          task.entityId,
          { botId: victimBot.entityId, reason: `Main effort (${opName})` },
          HQ_ACTOR,
        );
      }
      await this.makeWay(victim, task, opName);
    }
  }

  /** Pause a supporting task with a handover and put it back in its bot's queue. */
  private async makeWay(
    victim: RecordVersion<TaskBody>,
    meTask: RecordVersion<TaskBody>,
    opName: string,
  ) {
    const why = `${YIELDED_TO_MAIN_EFFORT} task #${meTask.body.number} (Operation ${opName}) goes first`;
    await this.runner.stop(victim.entityId, why);
    const after = await this.record.getActive('task', victim.entityId);
    if (after?.body.status !== 'stood-down') return;
    const refs = {
      unitId: victim.body.unitId,
      botId: victim.body.botId,
      taskId: victim.entityId,
      missionId: victim.body.missionId,
    };
    await this.record.transaction(async (w) => {
      const ctx = { actor: HQ_ACTOR, reason: why };
      await w.revise(
        'task',
        victim.entityId,
        (b) => ({ ...b, status: 'queued', statusReason: why, statusAction: null }),
        ctx,
      );
      await w.event(
        'task.status',
        { from: 'stood-down', to: 'queued', reason: why },
        refs,
        HQ_ACTOR,
      );
      await w.revise(
        'bot',
        victim.body.botId!,
        (b) =>
          b.queue.includes(victim.entityId) ? b : { ...b, queue: [victim.entityId, ...b.queue] },
        ctx,
      );
      await w.event(
        'main-effort.yield',
        {
          mainEffortTaskId: meTask.entityId,
          how: 'paused',
          yieldedTaskId: victim.entityId,
          toBotId: null,
        },
        refs,
        HQ_ACTOR,
      );
      await w.event(
        'sitrep',
        {
          level: 'unit',
          text: `Task #${victim.body.number} paused with a handover to make way for the main effort (task #${meTask.body.number}, Operation ${opName}). It resumes when a bot is free.`,
          status: null,
        },
        refs,
        HQ_ACTOR,
      );
    });
  }
}
