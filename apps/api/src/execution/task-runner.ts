import { OFFICER_SECRET_PREFIX } from '../officers/officers.service.js';
import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  actorRef,
  renderHandoverMarkdown,
  type BotEvent,
  type BotStatus,
  type FragoNote,
  type LiveOrders,
  type Principal,
  type RecordEvent,
  type RecordEventRefs,
  type RecordVersion,
  type RunContext,
  type TaskBody,
  type TaskBrief,
  type TaskStatus,
} from '@orbot/shared';
import { errorAction } from '../common/api-error.js';
import { GitError } from '../common/git.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { ServersService } from '../servers/servers.service.js';
import { SitesService } from '../servers/sites.service.js';
import { BriefingService } from '../overseer/briefing.service.js';
import { WhispersService } from '../whispers/whispers.service.js';
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

const STARTABLE: readonly TaskStatus[] = ['queued', 'blocked', 'stood-down', 'failed'];

const NEXT = {
  blocked:
    'Give the bot what it is held for (a decision, an item from the Supply Depot, a credential), then Resume the task. For a finding: order the fix in chat, change the hold policy, or accept it and Resume.',
  failed:
    'Read the reason (and the handover, if there is one), change what it names, then Retry the task or reassign it to another bot.',
  crashed:
    'Retry the task. If the bot keeps crashing, check its runtime: `orbot logs` shows the error, and Settings shows which runtime it is on.',
  noReport:
    'Retry the task; the bot carries on from its handover if it wrote one. If it keeps stopping without a report, check the runtime with `orbot logs`.',
  policy: 'Clear what holds it (the rule named in the reason), then Resume the task.',
  dispute:
    'HQ rules on the dispute and the task resumes with the ruling; you can rule yourself on the Disputes page.',
  git: 'Retry the task: its workspace is prepared again from the integrated work. If git fails the same way, `orbot logs` has the full output.',
} as const;

/**
 * What the Commander can do about a task that stops short: the bot's own suggestion when it
 * gave one, else the usual way out; and when the task stops the same way it did last time, a
 * warning first that resuming alone will not change it (D112).
 */
export function nextStep(
  status: TaskStatus,
  reason: string,
  before: Pick<TaskBody, 'status' | 'statusReason'>,
  given: string | null,
  crashed: boolean,
): string | null {
  if (status !== 'blocked' && status !== 'failed') return null;
  const usual = status === 'blocked' ? NEXT.blocked : crashed ? NEXT.crashed : NEXT.failed;
  const step = given ?? usual;
  if (before.status !== status || before.statusReason !== reason) return step;
  return status === 'blocked'
    ? `Held again for the same reason: resuming alone will not clear it. ${step}`
    : `Failed again in the same way: retrying alone will not fix it. ${step}`;
}

/**
 * Drives one bot through one task:
 *   brief → workspace → runtime events → policy check → record → final status.
 * Every event the runtime yields becomes at least one entry in the record.
 */
@Injectable()
export class TaskRunner implements OnApplicationBootstrap {
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
    private readonly whispers: WhispersService,
    private readonly servers: ServersService,
    private readonly sites: SitesService,
  ) {}

  isRunning(taskId: string): boolean {
    return this.active.has(taskId);
  }

  runningCount(): number {
    return this.active.size;
  }

  /** Every run in progress, for the escalation sweep. */
  /**
   * Runs live in this process: after a restart (an update, a crash) every task the record still
   * shows working has no run behind it, and nothing would ever notice. Each goes back to the
   * front of its bot's queue with the reason, its last run is closed on the record and the bot
   * is freed, so the Overseer starts it again from its branch (D115).
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.recoverStranded('system:runner');
  }

  /**
   * Every task the record shows working that has no run in this process is stranded (the
   * process restarted under it, or its run was lost). Each is queued again with the reason,
   * its run closed and its bot freed. Safe to call at any time: the escalation sweep does, and
   * so does "Restart the queues" (D115).
   */
  async recoverStranded(
    actor: string,
  ): Promise<{ taskId: string; number: number; unitId: string; botCallsign: string | null }[]> {
    const working = await this.record.listActive('task', { bodyContains: { status: 'working' } });
    const out: { taskId: string; number: number; unitId: string; botCallsign: string | null }[] =
      [];
    for (const task of working) {
      if (this.active.has(task.entityId)) continue;
      try {
        out.push(await this.recover(task, actor));
      } catch (err) {
        this.logger.error(
          `Could not recover task #${task.body.number}: ${this.message(err)}`,
          'TaskRunner',
        );
      }
    }
    return out;
  }

  private async recover(task: RecordVersion<TaskBody>, actor: string) {
    const t = task.body;
    const reason =
      'ORBOT restarted while the task ran (an update or a crash); it goes again from its branch.';
    const action = t.autoStart
      ? 'Nothing to do: the Overseer starts it again as soon as its bot is free.'
      : 'Start the task again; the bot carries on from its branch and handover.';
    const bot = t.botId ? await this.record.getActive('bot', t.botId) : null;
    const mission = t.missionId ? await this.record.getActive('mission', t.missionId) : null;
    const refs: RecordEventRefs = {
      unitId: t.unitId,
      botId: t.botId,
      taskId: task.entityId,
      missionId: t.missionId,
      operationId: mission?.body.operationId ?? null,
    };
    const starts = await this.record.listEvents({
      taskId: task.entityId,
      kinds: ['run.started'],
      limit: 1000,
    });
    const last = starts.at(-1) as RecordEvent<'run.started'> | undefined;
    await this.record.transaction(async (w) => {
      await this.setStatus(
        w,
        task.entityId,
        'queued',
        reason,
        refs,
        actor,
        reason,
        undefined,
        action,
      );
      if (last) {
        await w.event('run.finished', { runId: last.body.runId, outcome: 'stopped' }, refs, actor);
      }
      if (bot) {
        await w.revise(
          'bot',
          bot.entityId,
          (b) => ({
            ...b,
            status: b.currentTaskId === task.entityId && b.status === 'working' ? 'idle' : b.status,
            currentTaskId: b.currentTaskId === task.entityId ? null : b.currentTaskId,
            queue: [task.entityId, ...b.queue.filter((q) => q !== task.entityId)],
          }),
          { actor, reason },
        );
      }
      await w.event(
        'sitrep',
        {
          level: 'unit',
          text: `Task #${t.number} was running when ORBOT restarted; queued again${bot ? ` for ${bot.body.callsign}` : ''}, to go on from its branch.`,
          status: 'queued',
        },
        refs,
        actor,
      );
    });
    return {
      taskId: task.entityId,
      number: t.number,
      unitId: t.unitId,
      botCallsign: bot?.body.callsign ?? null,
    };
  }

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
      rulesOfEngagement: unit.body.rulesOfEngagement,
      supply: supply
        .filter((s): s is NonNullable<typeof s> => !!s && s.body.connected)
        .map((s) => ({
          name: s.body.name,
          kind: s.body.spec.kind,
          tier:
            s.body.spec.kind === 'environment' ? (s.body.spec.details['tier'] ?? 'staging') : null,
        })),
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
  /**
   * Carry on with a held task (unblocked, decided, ruled on): at once if its bot is free, else
   * first in that bot's queue, for the Overseer to dispatch as soon as the bot finishes.
   */
  async resume(taskId: string, actor: string): Promise<'started' | 'queued'> {
    const task = await this.record.requireActive('task', taskId);
    const bot = task.body.botId ? await this.record.getActive('bot', task.body.botId) : null;
    if (!bot || bot.body.status !== 'working' || bot.body.currentTaskId === taskId) {
      await this.start(taskId, actor);
      return 'started';
    }
    if (!STARTABLE.includes(task.body.status)) {
      throw new ConflictException({
        message: `Task #${task.body.number} is ${task.body.status} and cannot be started.`,
        action: 'Only queued, blocked, stood-down or failed tasks can be started.',
      });
    }
    const allowed = await this.policy.check({
      principal: { kind: 'bot', id: bot.entityId, displayName: bot.body.callsign },
      action: 'task.start',
      unitId: task.body.unitId,
      taskId,
      details: { startedBy: actor },
    });
    if (!allowed.allowed) {
      throw new ConflictException({
        message: `Task #${task.body.number} cannot start: ${allowed.reason}`,
        action: allowed.action ?? 'Clear what is holding it, then start it again.',
      });
    }
    const reason = `Resumes when ${bot.body.callsign} finishes task in hand`;
    const mission = task.body.missionId
      ? await this.record.getActive('mission', task.body.missionId)
      : null;
    const refs: RecordEventRefs = {
      unitId: task.body.unitId,
      botId: bot.entityId,
      taskId,
      missionId: task.body.missionId,
      operationId: mission?.body.operationId ?? null,
    };
    await this.record.transaction(async (w) => {
      await w.revise('task', taskId, (b) => ({ ...b, autoStart: true }), {
        actor,
        reason: 'Resumes from the queue',
      });
      await this.setStatus(w, taskId, 'queued', reason, refs, actor, reason);
      await w.revise(
        'bot',
        bot.entityId,
        (b) => ({ ...b, queue: [taskId, ...b.queue.filter((q) => q !== taskId)] }),
        { actor, reason: `Task #${task.body.number} resumes next` },
      );
    });
    return 'queued';
  }

  async start(taskId: string, actor: string): Promise<RunHandle> {
    if (this.active.has(taskId)) throw new ConflictException('That task is already running.');
    const task = await this.record.requireActive('task', taskId);
    const t = task.body;
    if (!STARTABLE.includes(t.status)) {
      throw new ConflictException({
        message: `Task #${t.number} is ${t.status} and cannot be started.`,
        action: 'Only queued, blocked, stood-down or failed tasks can be started.',
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
          {
            path: workspace.path,
            branch: workspace.branch,
            baseCommit: workspace.baseCommit,
            restarted: workspace.restarted,
          },
          refs,
          botActor,
        );
        if (workspace.restarted) {
          await w.event(
            'sitrep',
            {
              level: 'unit',
              status: null,
              text: `Task #${t.number}: the integrated work could not be merged into ${workspace.branch} (conflicts in ${workspace.restarted.conflicts.join(', ') || 'the tree'}), so the branch restarts from it; the earlier commits are kept on ${workspace.restarted.kept}.`,
            },
            refs,
            botActor,
          );
        }
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
        whisper: async (text) => {
          this.whispers.leave(text);
        },
        orders: () => this.liveOrders(t.unitId),
        waitForFrago: (ms) => this.waitForFrago(run, ms),
        servers: () => this.servers.list(t.unitId),
        serverRun: async (server, command) =>
          this.servers.run(
            await this.record.requireActive('task', taskId),
            botPrincipal,
            refs,
            server,
            command,
            run.abort.signal,
          ),
        devRun: async (server, command) =>
          this.servers.devRun(
            await this.record.requireActive('task', taskId),
            botPrincipal,
            refs,
            server,
            command,
            run.abort.signal,
          ),
        devFetch: async (server, path) =>
          this.servers.devFetch(
            await this.record.requireActive('task', taskId),
            botPrincipal,
            refs,
            server,
            path,
            run.abort.signal,
          ),
        serverUpload: async (server, path) =>
          this.servers.upload(
            await this.record.requireActive('task', taskId),
            botPrincipal,
            refs,
            server,
            path,
            run.abort.signal,
          ),
        sites: () => this.sites.list(t.unitId),
        publish: async (site, paths) =>
          this.sites.publish(
            await this.record.requireActive('task', taskId),
            botPrincipal,
            refs,
            site,
            paths,
          ),
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
        undefined,
        false,
        errorAction(err) ?? (err instanceof GitError ? NEXT.git : null),
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
            false,
            decision.action ?? NEXT.policy,
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
                {
                  environment: ref!.replace(/^deploy\//, ''),
                  ref: ref!,
                  commit: commit ?? '',
                  url: null,
                },
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
              false,
              NEXT.dispute,
            );
          case 'permission':
            // Its rules of engagement say ask first: the task waits for the decision.
            return this.awaitPermission(ev, task.body, refs, botActor, run.runId, spent);
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
                false,
                go.action ?? NEXT.policy,
              );
            }
            break;
          }
          case 'report':
            await this.fileReport(task, ev.title, ev.markdown, refs, botActor);
            break;
          case 'handover':
            await this.writeHandover(task, ev.note, refs, botActor);
            run.handoverWritten = true;
            break;
          case 'blocked':
            return this.finish(
              'blocked',
              ev.reason,
              task.body,
              refs,
              botActor,
              run.runId,
              spent,
              false,
              ev.action ?? null,
            );
          case 'failed':
            return this.finish(
              'failed',
              ev.reason,
              task.body,
              refs,
              botActor,
              run.runId,
              spent,
              false,
              ev.action ?? null,
            );
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
        false,
        NEXT.noReport,
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
    if (name.startsWith(OFFICER_SECRET_PREFIX) || !task.credentialNames.includes(name)) {
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

  /** A report (recon findings) becomes a unit document; a later report revises it. */
  private async fileReport(
    task: RecordVersion<TaskBody>,
    title: string,
    markdown: string,
    refs: RecordEventRefs,
    actor: string,
  ) {
    title = title.trim() || `Recon: task #${task.body.number}`;
    const [existing] = await this.record.listActive('document', {
      bodyContains: { kind: 'recon', taskId: task.entityId },
    });
    const doc = existing
      ? await this.record.revise(
          'document',
          existing.entityId,
          (d) => ({ ...d, title, markdown, botId: refs.botId ?? null }),
          { actor, reason: 'Recon report revised' },
        )
      : await this.record.create(
          'document',
          {
            kind: 'recon',
            unitId: task.body.unitId,
            title,
            markdown,
            taskId: task.entityId,
            botId: refs.botId ?? null,
            operationId: null,
          },
          { actor, reason: `Recon report for task #${task.body.number}` },
        );
    await this.record.event('report.filed', { documentId: doc.entityId, title }, refs, actor);
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
    action: string | null = null,
  ): Promise<RunOutcome> {
    const taskStatus: TaskStatus =
      outcome === 'done'
        ? 'done'
        : outcome === 'blocked'
          ? 'blocked'
          : outcome === 'stopped'
            ? 'stood-down'
            : 'failed';
    // A held task does not hold its bot: the bot moves on to its queue, and the task resumes
    // later (`resume`). Only a bot that itself crashed stays with its task, as failed.
    const botStatus: BotStatus = botCrashed ? 'failed' : 'idle';
    const keepTask = botCrashed;
    // `task` is the task as it stood when this run started: the same hold again is called out.
    const next = nextStep(taskStatus, reason, task, action, botCrashed);
    await this.record.transaction(async (w) => {
      await this.setStatus(w, refs.taskId!, taskStatus, reason, refs, actor, reason, spent, next);
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

  /**
   * The bot asked permission under its rules of engagement. The run ends; the task waits
   * (awaiting approval) with the request on it, and the bot keeps the task for when it resumes.
   */
  private async awaitPermission(
    ev: Extract<BotEvent, { type: 'permission' }>,
    task: TaskBody,
    refs: RecordEventRefs,
    actor: string,
    runId: string,
    spent: number,
  ): Promise<RunOutcome> {
    const reason = `Asks permission: ${ev.action}`;
    await this.record.transaction(async (w) => {
      const e = await w.event(
        'permission.requested',
        { action: ev.action, rule: ev.rule, reason: ev.reason },
        refs,
        actor,
      );
      await w.revise(
        'task',
        refs.taskId!,
        (b) => ({
          ...b,
          permission: {
            action: ev.action,
            rule: ev.rule,
            reason: ev.reason,
            status: 'pending',
            requestedAt: e.createdAt,
            by: null,
            at: null,
            note: null,
          },
        }),
        { actor, reason },
      );
      await this.setStatus(
        w,
        refs.taskId!,
        'awaiting-approval',
        reason,
        refs,
        actor,
        reason,
        spent,
      );
      await this.setBot(
        w,
        refs.botId!,
        'idle',
        null,
        `Task #${task.number}: awaiting approval; on to the next task`,
        actor,
      );
      await w.event('run.finished', { runId, outcome: 'blocked' }, refs, actor);
    });
    return 'blocked';
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
    statusAction: string | null = null,
  ) {
    const current = await this.record.requireActive('task', taskId);
    await w.revise(
      'task',
      taskId,
      (b) => ({
        ...b,
        status: to,
        statusReason,
        statusAction,
        budget: spent === undefined ? b.budget : { ...b.budget, spentUnits: spent },
      }),
      { actor, reason },
    );
    if (current.body.status !== to) {
      await w.event(
        'task.status',
        { from: current.body.status, to, reason: statusReason, action: statusAction },
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
