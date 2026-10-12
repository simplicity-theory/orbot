import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import {
  actorRef,
  renderHandoverMarkdown,
  type BotEvent,
  type BotStatus,
  type FragoNote,
  type LiveOrders,
  type Principal,
  type RecordEventRefs,
  type RecordVersion,
  type RunContext,
  type TaskBody,
  type TaskBrief,
  type TaskStatus,
} from '@orbot/shared';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { BriefingService } from '../overseer/briefing.service.js';
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
  unitId: string;
  botId: string;
  /** Fragos delivered but not yet read by the bot. */
  fragos: FragoNote[];
  wake: (() => void) | null;
  /** What the bot did this run, for the handover written if it is stood down mid-task. */
  steps: string[];
  handoverWritten: boolean;
  branch: string | null;
  finished: Promise<RunOutcome> | null;
  startedAt: number;
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
    private readonly briefing: BriefingService,
  ) {}

  isRunning(taskId: string): boolean {
    return this.active.has(taskId);
  }

  runningCount(): number {
    return this.active.size;
  }

  /** Every run in progress, for the escalation sweep. */
  running(): { taskId: string; runId: string; unitId: string; botId: string; startedAt: number }[] {
    return [...this.active.entries()].map(([taskId, r]) => ({
      taskId,
      runId: r.runId,
      unitId: r.unitId,
      botId: r.botId,
      startedAt: r.startedAt,
    }));
  }

  /** Task ids currently running in a unit. */
  runningIn(unitId: string): string[] {
    return [...this.active.entries()].filter(([, r]) => r.unitId === unitId).map(([id]) => id);
  }

  /**
   * Deliver a change of orders to a running bot. Recorded first; the bot picks it up at
   * its next check (or immediately, if it is waiting for one).
   */
  async frago(
    taskId: string,
    text: string,
    source: string | null,
    actor: string,
  ): Promise<boolean> {
    const run = this.active.get(taskId);
    if (!run) return false;
    const ev = await this.record.event(
      'frago',
      { text, source },
      { unitId: run.unitId, botId: run.botId, taskId },
      actor,
    );
    run.fragos.push({ text: ev.body.text, at: ev.createdAt });
    run.wake?.();
    return true;
  }

  private async liveOrders(unitId: string): Promise<LiveOrders> {
    const unit = await this.record.requireActive('unit', unitId);
    const supply = await Promise.all(
      unit.body.supplyIds.map((id) => this.record.getActive('supply', id)),
    );
    return {
      standingOrders: unit.body.standingOrders.map((o) => o.text),
      supply: supply
        .filter((s): s is NonNullable<typeof s> => !!s && s.body.connected)
        .map((s) => ({ name: s.body.name, kind: s.body.spec.kind })),
    };
  }

  private waitForFrago(run: ActiveRun, ms: number): Promise<FragoNote | null> {
    const next = () => run.fragos.shift() ?? null;
    const ready = next();
    if (ready || ms <= 0 || run.abort.signal.aborted) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        run.wake = null;
        run.abort.signal.removeEventListener('abort', done);
        resolve(next());
      };
      const timer = setTimeout(done, ms);
      run.wake = done;
      run.abort.signal.addEventListener('abort', done, { once: true });
    });
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
    if (t.kind === 'deploy' && t.approval && t.approval.status !== 'approved') {
      throw new ConflictException({
        message: `Task #${t.number} is a production deploy waiting for your approval.`,
        action: 'Approve it in Approvals (or in chat: “Approve the deploy”).',
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
    const allowed = await this.policy.check({
      principal: { kind: 'bot', id: bot.entityId, displayName: bot.body.callsign },
      action: 'task.start',
      unitId: t.unitId,
      taskId,
      details: { startedBy: actor },
    });
    if (!allowed.allowed) {
      throw new ConflictException({
        message: `Task #${t.number} cannot start: ${allowed.reason}`,
        action: allowed.action ?? 'Clear what is holding it, then start it again.',
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
    const run: ActiveRun = {
      runId,
      abort: new AbortController(),
      stopReason: null,
      unitId: t.unitId,
      botId: bot.entityId,
      fragos: [],
      wake: null,
      steps: [],
      handoverWritten: false,
      branch: null,
      finished: null,
      startedAt: Date.now(),
    };
    this.active.set(taskId, run);

    const botPrincipal: Principal = {
      kind: 'bot',
      id: bot.entityId,
      displayName: bot.body.callsign,
    };
    const botActor = actorRef(botPrincipal);
    const mission = t.missionId ? await this.record.getActive('mission', t.missionId) : null;
    const refs: RecordEventRefs = {
      unitId: t.unitId,
      botId: bot.entityId,
      taskId,
      missionId: t.missionId,
      operationId: mission?.body.operationId ?? null,
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
      run.branch = workspace.branch;
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

      const brief: TaskBrief = await this.briefing.build(
        runId,
        task,
        { id: bot.entityId, callsign: bot.body.callsign, role: bot.body.role },
        unit,
        workspace,
        botActor,
      );

      const ctx: RunContext = {
        signal: run.abort.signal,
        timeScale: this.config.simSpeed,
        withCredential: (name, purpose, fn) =>
          this.useCredential(name, purpose, fn, t, botPrincipal, refs),
        searchRecord: (q) => this.briefing.search(t.unitId, q),
        orders: () => this.liveOrders(t.unitId),
        waitForFrago: (ms) => this.waitForFrago(run, ms),
      };

      const finished = this.drive(runtime.run(brief, ctx), run, task, botPrincipal, refs).finally(
        () => this.active.delete(taskId),
      );
      run.finished = finished;
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

  /**
   * Halt a running task (stand down). The task becomes stood-down with a handover, so
   * it can be picked up again. Resolves when the run has finished, or null if it wasn't running.
   */
  stop(taskId: string, reason: string): Promise<RunOutcome | null> {
    const run = this.active.get(taskId);
    if (!run) return Promise.resolve(null);
    run.stopReason ??= reason;
    run.abort.abort();
    run.wake?.();
    return run.finished ?? Promise.resolve('stopped');
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
          if (run.stopReason !== null) return this.standDown(run, task, refs, botActor, spent);
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
            run.steps.push(`${ev.action}: ${ev.detail}`);
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
          case 'artifact': {
            await this.record.event(
              'artifact',
              { kind: ev.kind, ref: ev.ref, summary: ev.summary },
              refs,
              botActor,
            );
            if (ev.kind === 'deployment') {
              const [ref, commit] = ev.ref.split('@');
              await this.record.event(
                'deployment',
                { environment: ref!.replace(/^deploy\//, ''), ref: ref!, commit: commit ?? '' },
                refs,
                botActor,
              );
            }
            break;
          }
          case 'dispute':
            // The bot disagrees with another unit: HQ rules, and the task waits for it.
            await this.record.event(
              'dispute.raised',
              { against: ev.against, claim: ev.claim },
              refs,
              botActor,
            );
            return this.finish(
              'blocked',
              `Disputed with ${ev.against}: ${ev.claim}`,
              task.body,
              refs,
              botActor,
              run.runId,
              spent,
            );
          case 'send-back':
            // The check did its job: pause this task until the previous unit has fixed it.
            return this.finish(
              'stopped',
              `Sent back: ${ev.reason}`,
              task.body,
              refs,
              botActor,
              run.runId,
              spent,
            );
          case 'cost': {
            spent += ev.units;
            await this.record.event('cost', { units: ev.units, total: spent }, refs, botActor);
            // The spend is on the record either way; at a budget cap the run stops here.
            const go = await this.policy.check({
              principal: bot,
              action: 'task.continue',
              unitId: refs.unitId ?? null,
              taskId: refs.taskId ?? null,
              details: { units: ev.units },
            });
            if (!go.allowed) {
              run.abort.abort();
              if (run.stopReason !== null) return this.standDown(run, task, refs, botActor, spent);
              return this.finish(
                'blocked',
                `Held by policy: ${go.reason}`,
                task.body,
                refs,
                botActor,
                run.runId,
                spent,
              );
            }
            break;
          }
          case 'handover':
            await this.writeHandover(task, ev.note, refs, botActor);
            run.handoverWritten = true;
            break;
          case 'blocked':
            return this.finish('blocked', ev.reason, task.body, refs, botActor, run.runId, spent);
          case 'failed':
            return this.finish('failed', ev.reason, task.body, refs, botActor, run.runId, spent);
          case 'done':
            return this.finish('done', ev.summary, task.body, refs, botActor, run.runId, spent);
          case 'stood-down':
            return this.finish('stopped', ev.reason, task.body, refs, botActor, run.runId, spent);
        }
      }
      if (run.stopReason !== null) return this.standDown(run, task, refs, botActor, spent);
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

  /**
   * Stood down mid-task. If the bot didn't leave a handover this run, ORBOT writes one from
   * the record of the run, so the work can be picked up again by any bot.
   */
  private async standDown(
    run: ActiveRun,
    task: RecordVersion<TaskBody>,
    refs: RecordEventRefs,
    botActor: string,
    spent: number,
  ): Promise<RunOutcome> {
    const reason = run.stopReason!;
    if (!run.handoverWritten) {
      const done = run.steps.slice(-5);
      await this.writeHandover(
        task,
        {
          state: `Stood down mid-task (${reason}).${
            done.length
              ? ` Last steps this run: ${done.join('; ')}.`
              : ' No steps recorded this run.'
          }`,
          nextSteps: [
            run.branch
              ? `Pick the task up from branch ${run.branch}: check what is committed, then carry on.`
              : 'Start the task again from its brief.',
          ],
          triedAndFailed: [],
          openProblems: [],
          flagsForSuccessor: [
            'Uncommitted changes in the old workspace were not reviewed: check `git status` first.',
          ],
        },
        refs,
        botActor,
      );
    }
    return this.finish('stopped', reason, task.body, refs, botActor, run.runId, spent);
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
