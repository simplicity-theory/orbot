import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import {
  actorRef,
  renderHandoverMarkdown,
  type BotEvent,
  type BotStatus,
  type Principal,
  type RecordEventRefs,
  type RecordVersion,
  type RunContext,
  type TaskBody,
  type TaskBrief,
  type TaskStatus,
} from '@orbot/shared';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { PolicyService } from '../policy/policy.service.js';
import { RecordService, type RecordWriter } from '../record/record.service.js';
import { RedactionService } from '../redaction/redaction.service.js';
import { RedactingLogger } from '../redaction/redacting-logger.js';
import { RuntimeRegistry } from '../runtime/runtime.registry.js';
import { WorkspaceManager } from '../runtime/workspace-manager.js';
import { SecretsService } from '../secrets/secrets.service.js';

export type RunOutcome = 'done' | 'failed' | 'blocked' | 'stopped';

export interface RunHandle {
  runId: string;
  taskId: string;
  finished: Promise<RunOutcome>;
}

interface ActiveRun {
  runId: string;
  abort: AbortController;
  stopReason: string | null;
}

const STARTABLE: readonly TaskStatus[] = ['queued', 'blocked', 'stood-down'];

/**
 * Drives one bot through one task:
 *   brief → workspace → runtime events → policy check → record → final status.
 * Every event the runtime yields becomes at least one entry in the record.
 */
@Injectable()
export class TaskRunner {
  private readonly active = new Map<string, ActiveRun>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly record: RecordService,
    private readonly runtimes: RuntimeRegistry,
    private readonly workspaces: WorkspaceManager,
    private readonly policy: PolicyService,
    private readonly secrets: SecretsService,
    private readonly redaction: RedactionService,
    private readonly logger: RedactingLogger,
  ) {}

  isRunning(taskId: string): boolean {
    return this.active.has(taskId);
  }

  /** Start a task in the background. Resolves once the run has started. */
  async start(taskId: string, actor: string): Promise<RunHandle> {
    if (this.active.has(taskId)) throw new ConflictException('That task is already running.');
    const task = await this.record.requireActive('task', taskId);
    const t = task.body;
    if (!STARTABLE.includes(t.status)) {
      throw new ConflictException({
        message: `Task #${t.number} is ${t.status} and cannot be started.`,
        action: 'Only queued, blocked or stood-down tasks can be started.',
      });
    }
    if (!t.botId) {
      throw new BadRequestException({
        message: `Task #${t.number} has no bot assigned.`,
        action: 'Assign a bot first.',
      });
    }
    if (!t.repoSupplyId) {
      throw new BadRequestException({
        message: `Task #${t.number} has no repository.`,
        action: 'Issue a connected repository from the Supply Depot to this task.',
      });
    }
    const bot = await this.record.requireActive('bot', t.botId);
    if (bot.body.status === 'working' && bot.body.currentTaskId !== taskId) {
      throw new ConflictException({
        message: `Bot ${bot.body.callsign} is busy with another task.`,
        action: 'Wait for it to finish, or assign this task to another bot.',
      });
    }
    const unit = await this.record.requireActive('unit', t.unitId);
    const repo = await this.record.requireActive('supply', t.repoSupplyId);
    for (const name of t.credentialNames) {
      if (!(await this.secrets.exists(name))) {
        throw new BadRequestException({
          message: `Credential "${name}" is not in the secrets store.`,
          action: 'Connect it in the Supply Depot, then start the task again.',
        });
      }
    }
    const runtime = this.runtimes.get(bot.body.runtime);

    const runId = randomUUID();
    const run: ActiveRun = { runId, abort: new AbortController(), stopReason: null };
    this.active.set(taskId, run);

    const botPrincipal: Principal = {
      kind: 'bot',
      id: bot.entityId,
      displayName: bot.body.callsign,
    };
    const botActor = actorRef(botPrincipal);
    const refs: RecordEventRefs = {
      unitId: t.unitId,
      botId: bot.entityId,
      taskId,
      missionId: t.missionId,
    };

    try {
      await this.record.transaction(async (w) => {
        await w.event('run.started', { runId, runtime: runtime.kind }, refs, actor);
        await this.setStatus(w, task.entityId, 'working', null, refs, actor, `Started by ${actor}`);
        await this.setBot(
          w,
          bot.entityId,
          'working',
          taskId,
          `Working on task #${t.number}`,
          actor,
        );
      });

      const workspace = await this.workspaces.prepare(repo.entityId, repo.body, t);
      await this.record.transaction(async (w) => {
        await w.event(
          'workspace.prepared',
          { path: workspace.path, branch: workspace.branch, baseCommit: workspace.baseCommit },
          refs,
          botActor,
        );
        await w.revise('task', taskId, (b) => ({ ...b, workspace }), {
          actor: botActor,
          reason: 'Workspace prepared',
        });
      });

      const brief: TaskBrief = {
        runId,
        taskId,
        task: { ...t, workspace, status: 'working' },
        bot: { id: bot.entityId, callsign: bot.body.callsign, role: bot.body.role },
        unit: {
          id: unit.entityId,
          name: unit.body.name,
          standingOrders: unit.body.standingOrders.map((s) => s.text),
        },
        workspace,
        lastHandover: null,
        fieldManual: [],
        recentDiary: [],
      };

      const ctx: RunContext = {
        signal: run.abort.signal,
        timeScale: this.config.simSpeed,
        withCredential: (name, purpose, fn) =>
          this.useCredential(name, purpose, fn, t, botPrincipal, refs),
      };

      const finished = this.drive(runtime.run(brief, ctx), run, task, botPrincipal, refs).finally(
        () => this.active.delete(taskId),
      );
      return { runId, taskId, finished };
    } catch (err) {
      this.active.delete(taskId);
      await this.finish(
        'failed',
        `Could not start: ${this.message(err)}`,
        task.body,
        refs,
        botActor,
        runId,
      ).catch(() => undefined);
      throw err;
    }
  }

  /** Halt a running task. Hook for Phase 5 stand-down. */
  stop(taskId: string, reason: string): boolean {
    const run = this.active.get(taskId);
    if (!run) return false;
    run.stopReason = reason;
    run.abort.abort();
    return true;
  }

  private async drive(
    events: AsyncIterable<BotEvent>,
    run: ActiveRun,
    task: RecordVersion<TaskBody>,
    bot: Principal,
    refs: RecordEventRefs,
  ): Promise<RunOutcome> {
    const botActor = actorRef(bot);
    let spent = task.body.budget.spentUnits;
    try {
      for await (const ev of events) {
        const decision = await this.policy.check({
          principal: bot,
          action: `bot.${ev.type}`,
          unitId: refs.unitId ?? null,
          taskId: refs.taskId ?? null,
          details: { event: ev },
        });
        if (!decision.allowed) {
          run.abort.abort();
          return this.finish(
            'blocked',
            `Held by policy: ${decision.reason}`,
            task.body,
            refs,
            botActor,
            run.runId,
            spent,
          );
        }
        switch (ev.type) {
          case 'step':
            await this.record.event(
              'bot.step',
              { action: ev.action, detail: ev.detail, outcome: ev.outcome ?? null },
              refs,
              botActor,
            );
            break;
          case 'diary':
            await this.record.event(
              'diary.entry',
              { category: ev.category, text: ev.text },
              refs,
              botActor,
            );
            break;
          case 'sitrep':
            await this.record.event(
              'sitrep',
              { level: 'bot', text: ev.text, status: ev.status ?? null },
              refs,
              botActor,
            );
            break;
          case 'artifact':
            await this.record.event(
              'artifact',
              { kind: ev.kind, ref: ev.ref, summary: ev.summary },
              refs,
              botActor,
            );
            break;
          case 'cost':
            spent += ev.units;
            await this.record.event('cost', { units: ev.units, total: spent }, refs, botActor);
            break;
          case 'handover':
            await this.writeHandover(task, ev.note, refs, botActor);
            break;
          case 'blocked':
            return this.finish('blocked', ev.reason, task.body, refs, botActor, run.runId, spent);
          case 'failed':
            return this.finish('failed', ev.reason, task.body, refs, botActor, run.runId, spent);
          case 'done':
            return this.finish('done', ev.summary, task.body, refs, botActor, run.runId, spent);
        }
      }
      if (run.stopReason !== null) {
        return this.finish('stopped', run.stopReason, task.body, refs, botActor, run.runId, spent);
      }
      return this.finish(
        'failed',
        'The bot stopped without reporting done, blocked or failed.',
        task.body,
        refs,
        botActor,
        run.runId,
        spent,
      );
    } catch (err) {
      const reason = `The bot's runtime crashed: ${this.message(err)}`;
      this.logger.error(this.redaction.clean(reason), 'TaskRunner');
      return this.finish('failed', reason, task.body, refs, botActor, run.runId, spent, true);
    }
  }

  private async useCredential<T>(
    name: string,
    purpose: string,
    fn: (value: string) => Promise<T>,
    task: TaskBody,
    bot: Principal,
    refs: RecordEventRefs,
  ): Promise<T> {
    if (!task.credentialNames.includes(name)) {
      throw new Error(`Credential "${name}" was not issued to task #${task.number}.`);
    }
    const d = await this.policy.check({
      principal: bot,
      action: 'credential.use',
      unitId: task.unitId,
      taskId: refs.taskId ?? null,
      details: { secretName: name, purpose },
    });
    if (!d.allowed) throw new Error(`Policy refused use of credential "${name}": ${d.reason}`);
    const value = await this.secrets.reveal(name);
    await this.record.event('credential.used', { secretName: name, purpose }, refs, actorRef(bot));
    return fn(value);
  }

  private async writeHandover(
    task: RecordVersion<TaskBody>,
    note: Parameters<typeof renderHandoverMarkdown>[1],
    refs: RecordEventRefs,
    actor: string,
  ) {
    const title = `Handover: Task #${task.body.number} — ${task.body.title}`;
    const markdown = renderHandoverMarkdown(`Task #${task.body.number} — ${task.body.title}`, note);
    const [existing] = await this.record.listActive('document', {
      bodyContains: { kind: 'handover', taskId: task.entityId },
    });
    if (existing) {
      await this.record.revise(
        'document',
        existing.entityId,
        (d) => ({ ...d, title, markdown, botId: refs.botId ?? null }),
        {
          actor,
          reason: 'New handover at end of run',
        },
      );
    } else {
      await this.record.create(
        'document',
        {
          kind: 'handover',
          unitId: task.body.unitId,
          title,
          markdown,
          taskId: task.entityId,
          botId: refs.botId ?? null,
        },
        { actor, reason: `Handover for task #${task.body.number}` },
      );
    }
  }

  private async finish(
    outcome: RunOutcome,
    reason: string,
    task: TaskBody,
    refs: RecordEventRefs,
    actor: string,
    runId: string,
    spent?: number,
    botCrashed = false,
  ): Promise<RunOutcome> {
    const taskStatus: TaskStatus =
      outcome === 'done'
        ? 'done'
        : outcome === 'blocked'
          ? 'blocked'
          : outcome === 'stopped'
            ? 'stood-down'
            : 'failed';
    const botStatus: BotStatus = botCrashed ? 'failed' : outcome === 'blocked' ? 'blocked' : 'idle';
    const keepTask = outcome === 'blocked' || botCrashed;
    await this.record.transaction(async (w) => {
      await this.setStatus(w, refs.taskId!, taskStatus, reason, refs, actor, reason, spent);
      await this.setBot(
        w,
        refs.botId!,
        botStatus,
        keepTask ? refs.taskId! : null,
        `Task #${task.number}: ${taskStatus}`,
        actor,
      );
      await w.event('run.finished', { runId, outcome }, refs, actor);
    });
    return outcome;
  }

  private async setStatus(
    w: RecordWriter,
    taskId: string,
    to: TaskStatus,
    statusReason: string | null,
    refs: RecordEventRefs,
    actor: string,
    reason: string,
    spent?: number,
  ) {
    const current = await this.record.requireActive('task', taskId);
    await w.revise(
      'task',
      taskId,
      (b) => ({
        ...b,
        status: to,
        statusReason,
        budget: spent === undefined ? b.budget : { ...b.budget, spentUnits: spent },
      }),
      { actor, reason },
    );
    if (current.body.status !== to) {
      await w.event(
        'task.status',
        { from: current.body.status, to, reason: statusReason },
        refs,
        actor,
      );
    }
  }

  private async setBot(
    w: RecordWriter,
    botId: string,
    status: BotStatus,
    currentTaskId: string | null,
    reason: string,
    actor: string,
  ) {
    await w.revise(
      'bot',
      botId,
      (b) => ({
        ...b,
        status,
        currentTaskId,
        queue: currentTaskId ? b.queue.filter((q) => q !== currentTaskId) : b.queue,
      }),
      { actor, reason },
    );
  }

  private message(err: unknown): string {
    return this.redaction.clean(err instanceof Error ? err.message : String(err));
  }
}
