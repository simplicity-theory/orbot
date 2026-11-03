import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { RecordEvent, RecordEventBody } from '@orbot/shared';
import type { Subscription } from 'rxjs';
import { Background } from '../common/background.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { TaskRunner } from '../execution/task-runner.js';
import { RecordBus } from '../record/record-bus.js';
import { RecordService, type RecordWriter } from '../record/record.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { HQ_ACTOR } from './hq.service.js';
import { Overseers } from './overseers.js';
import { StandDownService } from './stand-down.service.js';

type Cause = RecordEventBody<'escalation'>['cause'];

/** Status reasons on runs the Overseer stopped as stuck. */
export const STALLED = 'Stalled:';
export const TIMED_OUT = 'Timed out:';

interface Step {
  overseer: { text: string; action: string };
  hq: { text: string; action: string };
  commander: string;
}

/**
 * Stuck work goes up the chain: bot → its Overseer → HQ → the Commander.
 *  - Stall (no entry on the record for `stallSeconds`): the Overseer checks in with a frago;
 *    still silent after another `stallSeconds`, it stops the run with a handover and escalates.
 *  - Timeout (one run longer than `timeoutSeconds`): stopped with a handover, escalated.
 *  - Repeated failure (a task failed `repeatedFailures` times): not retried, escalated.
 *  - Failing bot (its last `failingBotRuns` runs all failed): stood down, escalated.
 * Each level's step is an `escalation` event; the Commander's step stays open (Needs you)
 * until the work moves on or the Commander acknowledges it.
 */
@Injectable()
export class EscalationService implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private sub: Subscription | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly record: RecordService,
    private readonly bus: RecordBus,
    private readonly background: Background,
    private readonly settings: SettingsService,
    private readonly runner: TaskRunner,
    private readonly overseers: Overseers,
    private readonly standDowns: StandDownService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.escalationSweepMs > 0) {
      this.timer = setInterval(() => void this.sweep(), this.config.escalationSweepMs);
      this.timer.unref();
    }
    this.sub = this.bus.notifications$.subscribe((n) => {
      if (n.type !== 'event') return;
      const e = n.event;
      if (e.kind === 'task.status' && e.unitId && e.taskId) {
        const to = (e as RecordEvent<'task.status'>).body.to;
        if (to === 'failed') {
          this.background.run(`unit:${e.unitId}`, 'escalation:failure', () =>
            this.afterFailure(e.taskId!),
          );
        } else if (to === 'working' || to === 'done') {
          this.background.run(`unit:${e.unitId}`, 'escalation:resolve', () =>
            this.resolveFor({ taskId: e.taskId! }, to === 'done' ? 'Task done' : 'Picked up again'),
          );
        }
      } else if (e.kind === 'stand-down.lifted' && e.botId) {
        this.background.run(`unit:${e.unitId}`, 'escalation:resolve', () =>
          this.resolveFor({ botId: e.botId! }, 'Bot back at work'),
        );
      }
    });
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.sub?.unsubscribe();
  }

  /** Look at every run in progress for stalls and timeouts. */
  async sweep(now = Date.now()): Promise<void> {
    // A task the record shows working with no run behind it is queued again (D115).
    await this.runner.recoverStranded('system:runner');
    const { escalation: s } = await this.settings.get();
    for (const run of this.runner.running()) {
      const chains = await this.chains({ taskId: run.taskId, runId: run.runId });
      if (now - run.startedAt > s.timeoutSeconds * 1000) {
        if (!chains.some((c) => c.cause === 'timeout')) await this.timeout(run, s.timeoutSeconds);
        continue;
      }
      const [last] = await this.record.listEvents(
        { taskId: run.taskId, limit: 1 },
        { latest: true },
      );
      const quietMs = now - Date.parse(last?.createdAt ?? new Date(run.startedAt).toISOString());
      if (quietMs <= s.stallSeconds * 1000) continue;
      const stall = chains.find((c) => c.cause === 'stall');
      if (!stall) await this.checkIn(run, s.stallSeconds);
      else if (stall.level === 'overseer') await this.stalled(run, stall.chainId, s.stallSeconds);
    }
  }

  // ---------- Stall ----------

  private async checkIn(run: Running, seconds: number) {
    const cmd = await this.overseers.of(run.unitId);
    const task = await this.record.requireActive('task', run.taskId);
    const chainId = randomUUID();
    await this.step(chainId, 'stall', 'overseer', run, cmd.actor, {
      text: `Task #${task.body.number}: no progress on the record for ${minutes(seconds)}.`,
      action: 'Sent a status check (frago): report, or hand over if stuck.',
    });
    await this.runner.frago(
      run.taskId,
      `Status check from your Overseer: nothing on the record for ${minutes(seconds)}. Report progress, or write a handover if you are stuck.`,
      null,
      cmd.actor,
    );
  }

  private async stalled(run: Running, chainId: string, seconds: number) {
    const cmd = await this.overseers.of(run.unitId);
    const task = await this.record.requireActive('task', run.taskId);
    const reason = `${STALLED} no progress for ${minutes(seconds)} after a status check`;
    await this.climb(chainId, 'stall', run, cmd.actor, {
      overseer: {
        text: `Task #${task.body.number} is still silent after the status check.`,
        action: 'Stopped the run; the task is paused with a handover.',
      },
      hq: {
        text: `${await this.unitName(run.unitId)} reports task #${task.body.number} stalled.`,
        action: 'No other unit can take it on: raised to the Commander.',
      },
      commander: `Task #${task.body.number} “${task.body.title}” stalled and was paused with a handover. Resume it, reassign it, or stand it down.`,
    });
    await this.runner.stop(run.taskId, reason);
  }

  // ---------- Timeout ----------

  private async timeout(run: Running, seconds: number) {
    const cmd = await this.overseers.of(run.unitId);
    const task = await this.record.requireActive('task', run.taskId);
    await this.climb(randomUUID(), 'timeout', run, cmd.actor, {
      overseer: {
        text: `Task #${task.body.number} has been running for more than ${minutes(seconds)}.`,
        action: 'Stopped the run; the task is paused with a handover.',
      },
      hq: {
        text: `${await this.unitName(run.unitId)} reports task #${task.body.number} timed out.`,
        action: 'Raised to the Commander.',
      },
      commander: `Task #${task.body.number} “${task.body.title}” ran past the ${minutes(seconds)} limit and was paused with a handover. Resume it, split it, or stand it down.`,
    });
    await this.runner.stop(run.taskId, `${TIMED_OUT} ran for more than ${minutes(seconds)}`);
  }

  // ---------- Failures ----------

  private async afterFailure(taskId: string) {
    const { escalation: s } = await this.settings.get();
    const task = await this.record.getActive('task', taskId);
    if (!task) return;
    const failures = (
      await this.record.listEvents({ taskId, kinds: ['task.status'], limit: 1000 })
    ).filter((e) => (e as RecordEvent<'task.status'>).body.to === 'failed').length;
    const cmd = await this.overseers.of(task.body.unitId);
    const ref = {
      taskId,
      unitId: task.body.unitId,
      botId: task.body.botId,
      runId: null,
    };

    if (failures >= s.repeatedFailures && !(await this.open({ taskId }, 'repeated-failure'))) {
      await this.climb(randomUUID(), 'repeated-failure', ref, cmd.actor, {
        overseer: {
          text: `Task #${task.body.number} has failed ${failures} times.`,
          action: 'Not retrying it again.',
        },
        hq: {
          text: `${await this.unitName(task.body.unitId)} cannot get task #${task.body.number} done.`,
          action: 'Raised to the Commander for a decision.',
        },
        commander: `Task #${task.body.number} “${task.body.title}” has failed ${failures} times: ${task.body.statusReason ?? 'no reason given'}. ${task.body.statusAction ?? 'It needs your decision.'}`,
      });
    }

    const botId = task.body.botId;
    if (!botId) return;
    const runs = (
      await this.record.listEvents(
        { botId, kinds: ['run.finished'], limit: s.failingBotRuns },
        { latest: true },
      )
    ).map((e) => (e as RecordEvent<'run.finished'>).body.outcome);
    if (runs.length < s.failingBotRuns || runs.some((o) => o !== 'failed')) return;
    const bot = await this.record.requireActive('bot', botId);
    if (bot.body.halt || (await this.open({ botId }, 'failing-bot'))) return;
    await this.climb(randomUUID(), 'failing-bot', { ...ref, taskId: null, botId }, cmd.actor, {
      overseer: {
        text: `${bot.body.callsign} failed its last ${runs.length} runs.`,
        action: `Stood ${bot.body.callsign} down so it takes no more work.`,
      },
      hq: {
        text: `${await this.unitName(task.body.unitId)} has a bot that keeps failing.`,
        action: 'Raised to the Commander.',
      },
      commander: `${bot.body.callsign} failed its last ${runs.length} runs and is stood down. Check its runtime or replace it, then resume it.`,
    });
    await this.standDowns.standDown(
      { scope: 'bot', targetId: botId },
      `Failed its last ${runs.length} runs`,
      cmd.actor,
    );
  }

  // ---------- The chain ----------

  /** Record all three steps of a chain: Overseer, HQ, and the open item for the Commander. */
  private async climb(chainId: string, cause: Cause, ref: Ref, overseerActor: string, s: Step) {
    await this.record.transaction(async (w) => {
      const prior = await this.chainLevels(chainId);
      if (!prior.includes('overseer')) {
        await this.write(w, chainId, cause, 'overseer', ref, overseerActor, s.overseer);
      }
      await this.write(w, chainId, cause, 'hq', ref, HQ_ACTOR, s.hq);
      await this.write(w, chainId, cause, 'commander', ref, HQ_ACTOR, {
        text: s.commander,
        action: 'Waiting for the Commander.',
      });
    });
  }

  private async step(
    chainId: string,
    cause: Cause,
    level: 'overseer',
    ref: Ref,
    actor: string,
    s: { text: string; action: string },
  ) {
    await this.record.transaction((w) => this.write(w, chainId, cause, level, ref, actor, s));
  }

  private async write(
    w: RecordWriter,
    chainId: string,
    cause: Cause,
    level: 'overseer' | 'hq' | 'commander',
    ref: Ref,
    actor: string,
    s: { text: string; action: string },
  ) {
    const task = ref.taskId ? await w.getActive('task', ref.taskId) : null;
    const refs = {
      unitId: ref.unitId,
      botId: ref.botId,
      taskId: ref.taskId,
      missionId: task?.body.missionId ?? null,
    };
    await w.event(
      'escalation',
      { chainId, cause, level, text: s.text, action: s.action, runId: ref.runId },
      refs,
      actor,
    );
    if (level !== 'commander') {
      await w.event(
        'sitrep',
        {
          level: level === 'hq' ? 'hq' : 'unit',
          text: `Escalation: ${s.text} ${s.action}`,
          status: null,
        },
        refs,
        actor,
      );
    }
  }

  private async chainLevels(chainId: string) {
    return (await this.record.findEvents(['escalation'], { chainId })).map(
      (e) => (e as RecordEvent<'escalation'>).body.level,
    );
  }

  /** The latest step of each chain about this task (and run). */
  private async chains(ref: { taskId: string; runId?: string }) {
    const events = (
      await this.record.listEvents({ taskId: ref.taskId, kinds: ['escalation'], limit: 1000 })
    ).map((e) => (e as RecordEvent<'escalation'>).body);
    const latest = new Map<string, RecordEventBody<'escalation'>>();
    for (const e of events) {
      if (ref.runId && e.runId !== ref.runId) continue;
      latest.set(e.chainId, e);
    }
    return [...latest.values()];
  }

  /** An unresolved chain of this cause about the task or bot? */
  private async open(ref: { taskId?: string; botId?: string }, cause: Cause) {
    return (await this.openChains(ref)).some((c) => c.body.cause === cause);
  }

  /** Commander-level steps not yet resolved, optionally for one task or bot. */
  async openChains(ref: { taskId?: string; botId?: string; unitId?: string } = {}) {
    const steps = (await this.record.listEvents({
      kinds: ['escalation'],
      limit: 5000,
      ...(ref.taskId ? { taskId: ref.taskId } : {}),
      ...(ref.botId ? { botId: ref.botId } : {}),
      ...(ref.unitId ? { unitId: ref.unitId } : {}),
    })) as RecordEvent<'escalation'>[];
    const top = steps.filter((e) => e.body.level === 'commander');
    if (!top.length) return [];
    const resolved = new Set(
      (await this.record.listEvents({ kinds: ['escalation.resolved'], limit: 5000 })).map(
        (e) => (e as RecordEvent<'escalation.resolved'>).body.chainId,
      ),
    );
    return top.filter((e) => !resolved.has(e.body.chainId));
  }

  /** The work moved on: close the chains about it. */
  private async resolveFor(ref: { taskId?: string; botId?: string }, note: string) {
    const open = (await this.openChains(ref)).filter(
      // A failing bot's chain closes when the bot is back at work, not when one task moves.
      (c) => !ref.taskId || c.body.cause !== 'failing-bot',
    );
    for (const c of open) await this.resolve(c.body.chainId, note, 'system:escalation');
  }

  /** The Commander acknowledges an escalation (or the work moved on). */
  async resolve(chainId: string, note: string, actor: string) {
    const [top] = (await this.record.findEvents(['escalation'], {
      chainId,
      level: 'commander',
    })) as RecordEvent<'escalation'>[] | [];
    if (!top) throw new NotFoundException(`No escalation ${chainId}.`);
    const [done] = await this.record.findEvents(['escalation.resolved'], { chainId }, { limit: 1 });
    if (done) return done;
    return this.record.event(
      'escalation.resolved',
      { chainId, note },
      { unitId: top.unitId, botId: top.botId, taskId: top.taskId, missionId: top.missionId },
      actor,
    );
  }

  private async unitName(unitId: string) {
    return (await this.record.getActive('unit', unitId))?.body.name ?? 'A unit';
  }
}

interface Running {
  taskId: string;
  runId: string;
  unitId: string;
  botId: string;
}

interface Ref {
  taskId: string | null;
  unitId: string;
  botId: string | null;
  runId: string | null;
}

function minutes(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const m = Math.round(seconds / 60);
  return `${m} min`;
}
