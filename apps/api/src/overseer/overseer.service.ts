import {
  BadRequestException,
  ConflictException,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';
import {
  AddBotRequest,
  AmendBackbriefRequest,
  ApproveBackbriefRequest,
  CreateMissionRequest,
  RejectBackbriefRequest,
  ReassignTaskRequest,
  type BackbriefBody,
  type ProposedTask,
  type RecordEvent,
  SETTINGS_ID,
  type RecordVersion,
  type TaskStatus,
} from '@orbot/shared';
import type { z } from 'zod';
import { Background } from '../common/background.js';
import { ForceService } from '../domain/force.service.js';
import { WorkService } from '../domain/work.service.js';
import { TaskRunner } from '../execution/task-runner.js';
import { RecordBus } from '../record/record-bus.js';
import { RecordService, type RecordWriter } from '../record/record.service.js';
import { words } from '../common/similarity.js';
import { BriefingService } from './briefing.service.js';
import { CurationService } from './curation.service.js';
import { Overseers } from './overseers.js';

const REASSIGNABLE: readonly TaskStatus[] = ['queued', 'blocked', 'stood-down', 'failed'];

/**
 * A unit's Overseer: turns missions into backbriefs, issues tasks once a plan is
 * approved, keeps its bots busy, reports up with unit-level sitreps, and curates
 * the Field Manual after every handover. Reacts to committed record writes.
 */
@Injectable()
export class OverseerService implements OnApplicationBootstrap, OnModuleDestroy {
  private sub: Subscription | undefined;

  constructor(
    private readonly record: RecordService,
    private readonly bus: RecordBus,
    private readonly background: Background,
    private readonly overseers: Overseers,
    private readonly briefing: BriefingService,
    private readonly curation: CurationService,
    private readonly work: WorkService,
    private readonly force: ForceService,
    private readonly runner: TaskRunner,
  ) {}

  onApplicationBootstrap(): void {
    this.sub = this.bus.notifications$.subscribe((n) => {
      if (n.type === 'version') {
        const v = n.version;
        const unitId = v.unitId;
        if (!unitId) return;
        const b = v.body as Record<string, unknown>;
        if (v.entityType === 'mission' && v.version === 1 && b['status'] === 'planning') {
          this.enqueue(unitId, 'plan', () => this.plan(v.entityId));
        } else if (v.entityType === 'document' && b['kind'] === 'handover') {
          this.enqueue(unitId, 'curate', () => this.curation.curateHandover(v.entityId));
        } else if (
          (v.entityType === 'bot' && b['status'] === 'idle') ||
          (v.entityType === 'task' && b['status'] === 'queued' && b['autoStart'] === true)
        ) {
          this.enqueue(unitId, 'dispatch', () => this.dispatch(unitId));
        }
      } else if (n.event.kind === 'task.status' && n.event.unitId) {
        const e = n.event as RecordEvent<'task.status'>;
        if (['done', 'failed', 'blocked', 'stood-down'].includes(e.body.to)) {
          this.enqueue(e.unitId!, 'after-task', () => this.afterTask(e));
        }
      }
    });
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
  }

  /** Ask the unit's Overseer to start whatever it can (after a handoff, an approval…). */
  dispatchSoon(unitId: string): void {
    this.enqueue(unitId, 'dispatch', () => this.dispatch(unitId));
  }

  private enqueue(unitId: string, label: string, job: () => Promise<unknown>) {
    this.background.run(`unit:${unitId}`, `overseer:${label}`, job);
  }

  // ---------- Missions and backbriefs ----------

  /** The Commander gives a unit a mission (Phase 4: HQ does, from an operation). */
  async createMission(input: z.output<typeof CreateMissionRequest>, actor: string) {
    await this.overseers.of(input.unitId);
    return this.record.create(
      'mission',
      {
        operationId: null,
        unitId: input.unitId,
        goal: input.goal,
        definitionOfDone: input.definitionOfDone,
        status: 'planning',
      },
      { actor, reason: 'Mission given to the unit' },
    );
  }

  /** Draft (or re-draft) the backbrief for a mission, then gate it. */
  async plan(missionId: string, note: string | null = null): Promise<RecordVersion<BackbriefBody>> {
    const mission = await this.record.requireActive('mission', missionId);
    const cmd = await this.overseers.of(mission.body.unitId);
    const [existing] = await this.record.listActive('backbrief', { bodyContains: { missionId } });
    const round = existing ? existing.body.round + 1 : 1;
    const commanderNotes = [...(existing?.body.commanderNotes ?? []), ...(note ? [note] : [])];

    const bots = (await this.record.listActive('bot', { unitId: cmd.unit.entityId })).filter(
      (b) => !b.body.isOverseer,
    );
    const draft = await cmd.runtime.draftBackbrief({
      mission: {
        id: missionId,
        goal: mission.body.goal,
        definitionOfDone: mission.body.definitionOfDone,
        stage: mission.body.stage ?? null,
      },
      unit: {
        id: cmd.unit.entityId,
        name: cmd.unit.body.name,
        standingOrders: cmd.unit.body.standingOrders.map((o) => o.text),
      },
      bots: bots.map((b) => ({
        id: b.entityId,
        callsign: b.body.callsign,
        role: b.body.role,
        status: b.body.status,
        queueLength: b.body.queue.length,
      })),
      fieldManual: await this.briefing.relevantEntries(
        cmd.unit.entityId,
        `${mission.body.goal} ${mission.body.definitionOfDone.join(' ')}`,
      ),
      commanderNotes,
      round,
    });
    const botIds = new Set(bots.map((b) => b.entityId));
    const proposedTasks = draft.proposedTasks.map((t) => ({
      ...t,
      botId: t.botId && botIds.has(t.botId) ? t.botId : null,
    }));
    const autoApprove = cmd.unit.body.approvalGate === 'escalations-only';

    const bb = await this.record.transaction(async (w) => {
      const body: BackbriefBody = {
        missionId,
        unitId: cmd.unit.entityId,
        overseerBotId: cmd.overseer.entityId,
        summary: draft.summary,
        proposedTasks,
        risks: draft.risks,
        status: 'awaiting-approval',
        decision: null,
        round,
        commanderNotes,
        taskIds: [],
      };
      const ctx = {
        actor: cmd.actor,
        reason: round === 1 ? 'Backbrief drafted' : `Plan revised (round ${round})`,
      };
      const saved = existing
        ? await w.revise('backbrief', existing.entityId, () => body, ctx)
        : await w.create('backbrief', body, ctx);
      if (!autoApprove) {
        await w.revise('mission', missionId, (m) => ({ ...m, status: 'awaiting-approval' }), {
          actor: cmd.actor,
          reason: 'Backbrief awaiting approval',
        });
        await this.sitrep(
          w,
          cmd.unit.entityId,
          missionId,
          null,
          cmd.actor,
          `Backbrief ready for “${mission.body.goal}”: ${proposedTasks.length} task(s). Awaiting your approval.`,
        );
      }
      return saved;
    });
    if (autoApprove)
      return this.approveAs(
        bb.entityId,
        { note: null, expectedVersion: bb.version },
        null,
        cmd.actor,
        'auto-approved',
      );
    return bb;
  }

  approve(id: string, input: z.output<typeof ApproveBackbriefRequest>, actor: string) {
    return this.approveAs(id, input, null, actor, 'approved');
  }

  amend(id: string, input: z.output<typeof AmendBackbriefRequest>, actor: string) {
    return this.approveAs(
      id,
      { note: input.note, expectedVersion: input.expectedVersion },
      input.proposedTasks,
      actor,
      'amended',
    );
  }

  /** Send the plan back with a note; the Overseer re-plans as a new version. */
  async reject(id: string, input: z.output<typeof RejectBackbriefRequest>, actor: string) {
    const bb = await this.awaiting(id);
    await this.record.transaction(async (w) => {
      await w.revise(
        'backbrief',
        id,
        (b) => ({
          ...b,
          status: 'rejected',
          decision: {
            outcome: 'rejected',
            by: actor,
            note: input.note,
            at: new Date().toISOString(),
          },
        }),
        { actor, reason: `Sent back: ${input.note}`, expectedVersion: input.expectedVersion },
      );
      await w.revise('mission', bb.body.missionId, (m) => ({ ...m, status: 'planning' }), {
        actor,
        reason: 'Backbrief sent back for re-planning',
      });
    });
    this.enqueue(bb.body.unitId, 'replan', () => this.plan(bb.body.missionId, input.note));
    return this.record.requireActive('backbrief', id);
  }

  private async awaiting(id: string) {
    const bb = await this.record.requireActive('backbrief', id);
    if (bb.body.status !== 'awaiting-approval') {
      throw new ConflictException({
        message: `This backbrief is already ${bb.body.status}.`,
        action: 'Reload to see the current plan.',
      });
    }
    return bb;
  }

  private async approveAs(
    id: string,
    input: { note: string | null; expectedVersion: number },
    amended: ProposedTask[] | null,
    actor: string,
    outcome: 'approved' | 'amended' | 'auto-approved',
  ) {
    const bb = await this.awaiting(id);
    const cmd = await this.overseers.of(bb.body.unitId);
    const tasks = amended ?? bb.body.proposedTasks;
    const bots = new Set(
      (await this.record.listActive('bot', { unitId: bb.body.unitId }))
        .filter((b) => !b.body.isOverseer)
        .map((b) => b.entityId),
    );
    for (const t of tasks) {
      if (t.botId && !bots.has(t.botId))
        throw new BadRequestException(
          `Task “${t.title}” is assigned to a bot outside ${cmd.unit.body.name}.`,
        );
    }
    const supply = await Promise.all(
      cmd.unit.body.supplyIds.map((s) => this.record.getActive('supply', s)),
    );
    const repo = supply.find((s) => s?.body.connected && s.body.spec.kind === 'repository') ?? null;
    const credentialNames = supply.flatMap((s) =>
      s?.body.connected && s.body.spec.kind === 'credential' ? [s.body.spec.secretName] : [],
    );
    const numbers: number[] = [];
    for (let i = 0; i < tasks.length; i++) numbers.push(await this.record.nextTaskNumber());

    // In an operation: work lands on the operation's branch, and waits for the upstream handoff.
    const mission = await this.record.requireActive('mission', bb.body.missionId);
    const op = mission.body.operationId
      ? await this.record.getActive('operation', mission.body.operationId)
      : null;
    const upstream = mission.body.dependsOnMissionId
      ? await this.record.getActive('mission', mission.body.dependsOnMissionId)
      : null;
    const waiting = !!upstream && upstream.body.status !== 'done';
    const deployNeedsApproval = cmd.unit.body.approvalGate !== 'escalations-only';

    return this.record.transaction(async (w) => {
      const taskIds: string[] = [];
      for (const [i, t] of tasks.entries()) {
        const task = await this.work.writeTask(
          w,
          numbers[i]!,
          {
            unitId: bb.body.unitId,
            botId: t.botId,
            missionId: bb.body.missionId,
            title: t.title,
            description: t.description,
            repoSupplyId: op?.body.repoSupplyId ?? repo?.entityId ?? null,
            credentialNames,
            scenario: t.scenario,
            budgetLimitUnits: null,
            continuesTaskId: null,
            autoStart: true,
            kind: t.kind,
            baseRef: op?.body.integrationBranch ?? null,
            approval:
              t.kind === 'deploy' && deployNeedsApproval
                ? { kind: 'production-deploy', status: 'pending', by: null, at: null, note: null }
                : null,
          },
          { actor: cmd.actor, reason: `Issued under approved backbrief (round ${bb.body.round})` },
        );
        taskIds.push(task.entityId);
      }
      const decided = await w.revise(
        'backbrief',
        id,
        (b) => ({
          ...b,
          proposedTasks: tasks,
          status: 'approved',
          taskIds,
          decision: { outcome, by: actor, note: input.note, at: new Date().toISOString() },
        }),
        {
          actor,
          reason:
            outcome === 'amended'
              ? `Approved with changes: ${input.note}`
              : input.note
                ? `Approved: ${input.note}`
                : 'Approved',
          expectedVersion: input.expectedVersion,
        },
      );
      await w.revise(
        'mission',
        bb.body.missionId,
        (m) => ({ ...m, status: waiting ? 'waiting' : 'working' }),
        {
          actor: cmd.actor,
          reason: waiting
            ? 'Backbrief approved; waiting for the handoff from upstream'
            : 'Backbrief approved; work issued',
        },
      );
      await this.sitrep(
        w,
        bb.body.unitId,
        bb.body.missionId,
        null,
        cmd.actor,
        `Wilco. “${mission.body.goal}”: ${tasks.length} task(s) issued${outcome === 'amended' ? ' as amended' : ''}${waiting ? '; they start when the upstream unit hands off' : ''}.`,
      );
      return decided;
    });
  }

  // ---------- Work in progress ----------

  /** Start the next auto-start task for every idle bot in the unit. */
  async dispatch(unitId: string): Promise<void> {
    const cmd = await this.overseers.of(unitId);
    // A stand-down order on everything or on this unit: nothing starts.
    if ((await this.record.getActive('settings', SETTINGS_ID))?.body.halt) return;
    if ((await this.record.getActive('unit', unitId))?.body.halt) return;
    const bots = (await this.record.listActive('bot', { unitId })).filter(
      (b) => !b.body.isOverseer && b.body.status === 'idle' && !b.body.halt,
    );
    for (const bot of bots.sort((a, b) =>
      a.body.callsign.localeCompare(b.body.callsign, undefined, { numeric: true }),
    )) {
      for (const taskId of bot.body.queue) {
        if (this.runner.isRunning(taskId)) break;
        const task = await this.record.getActive('task', taskId);
        if (!task || task.body.status !== 'queued' || !task.body.autoStart) continue;
        if (task.body.missionId) {
          const m = await this.record.getActive('mission', task.body.missionId);
          if (m?.body.status === 'waiting') continue; // not handed off yet
        }
        if (task.body.kind === 'deploy' && task.body.approval?.status === 'pending') {
          // Production deploys wait for the Commander.
          await this.record.transaction(async (w) => {
            await w.revise(
              'task',
              taskId,
              (t) => ({
                ...t,
                status: 'awaiting-approval',
                statusReason: 'Production deploy: waiting for your approval',
              }),
              {
                actor: cmd.actor,
                reason: 'Production deploys need the Commander’s approval',
              },
            );
            await w.event(
              'task.status',
              {
                from: 'queued',
                to: 'awaiting-approval',
                reason: 'Production deploy: waiting for your approval',
              },
              { unitId, botId: bot.entityId, taskId, missionId: task.body.missionId },
              cmd.actor,
            );
            await this.sitrep(
              w,
              unitId,
              task.body.missionId,
              taskId,
              cmd.actor,
              `Task #${task.body.number} is ready to deploy to production and waits for your approval.`,
              'awaiting-approval',
            );
          });
          continue;
        }
        try {
          await this.runner.start(taskId, cmd.actor);
        } catch (err) {
          await this.record.event(
            'sitrep',
            {
              level: 'unit',
              text: `Could not start task #${task.body.number} on ${bot.body.callsign}: ${(err as Error).message}`,
              status: null,
            },
            { unitId, botId: bot.entityId, taskId, missionId: task.body.missionId },
            cmd.actor,
          );
        }
        break;
      }
    }
  }

  private async afterTask(e: RecordEvent<'task.status'>): Promise<void> {
    const task = await this.record.getActive('task', e.taskId!);
    if (!task) return;
    const cmd = await this.overseers.of(task.body.unitId);
    const bot = task.body.botId ? await this.record.getActive('bot', task.body.botId) : null;
    const who = bot ? bot.body.callsign : 'Unassigned';
    const text: Record<string, string> = {
      done: `${who} completed task #${task.body.number}: ${task.body.title}.`,
      failed: `${who} failed task #${task.body.number}: ${e.body.reason ?? 'no reason given'}. Needs a decision.`,
      blocked: `${who} blocked on task #${task.body.number}: ${e.body.reason ?? 'no reason given'}.`,
      'stood-down': `${who} stood down from task #${task.body.number} with a handover; it can be picked up again.`,
    };
    await this.record.transaction(async (w) => {
      await this.sitrep(
        w,
        task.body.unitId,
        task.body.missionId,
        task.entityId,
        cmd.actor,
        text[e.body.to]!,
        e.body.to,
      );
      if (task.body.missionId && e.body.to === 'done') {
        const all = await w.listActive('task', {
          bodyContains: { missionId: task.body.missionId },
        });
        const mission = await w.getActive('mission', task.body.missionId);
        // Close the mission only while handling the last completion, so its report comes last.
        const dones = await this.record.listEvents(
          { kinds: ['task.status'], limit: 1000 },
          { missionId: task.body.missionId },
        );
        const lastDone = Math.max(
          ...dones
            .filter((d) => (d as RecordEvent<'task.status'>).body.to === 'done')
            .map((d) => d.seq),
        );
        if (
          mission &&
          mission.body.status !== 'done' &&
          e.seq === lastDone &&
          all.length &&
          all.every((t) => t.body.status === 'done')
        ) {
          await w.revise('mission', mission.entityId, (m) => ({ ...m, status: 'done' }), {
            actor: cmd.actor,
            reason: 'All tasks done',
          });
          await this.sitrep(
            w,
            task.body.unitId,
            mission.entityId,
            null,
            cmd.actor,
            `Mission complete: ${mission.body.goal}.`,
            'done',
          );
        }
      }
    });
    await this.dispatch(task.body.unitId);
  }

  /** The Commander approves (or rejects) a production deploy. */
  async decideDeploy(taskId: string, approve: boolean, note: string | null, actor: string) {
    const task = await this.record.requireActive('task', taskId);
    const mission = task.body.missionId
      ? await this.record.getActive('mission', task.body.missionId)
      : null;
    const operationId = mission?.body.operationId ?? null;
    if (task.body.kind !== 'deploy' || task.body.approval?.status !== 'pending') {
      throw new ConflictException({
        message: `Task #${task.body.number} is not a deploy waiting for approval.`,
        action: 'Reload to see its current state.',
      });
    }
    const next = await this.record.transaction(async (w) => {
      const t = await w.revise(
        'task',
        taskId,
        (b) => ({
          ...b,
          approval: {
            ...b.approval!,
            status: approve ? 'approved' : 'rejected',
            by: actor,
            at: new Date().toISOString(),
            note,
          },
          status: approve ? 'queued' : 'stood-down',
          statusReason: approve
            ? 'Production deploy approved'
            : `Production deploy rejected${note ? `: ${note}` : ''}`,
        }),
        {
          actor,
          reason: approve
            ? `Production deploy approved${note ? `: ${note}` : ''}`
            : `Production deploy rejected${note ? `: ${note}` : ''}`,
        },
      );
      await w.event(
        'deploy.approval',
        { status: approve ? 'approved' : 'rejected', note },
        {
          unitId: task.body.unitId,
          taskId,
          botId: task.body.botId,
          missionId: task.body.missionId,
          operationId,
        },
        actor,
      );
      await w.event(
        'task.status',
        {
          from: task.body.status,
          to: approve ? 'queued' : 'stood-down',
          reason: approve ? 'Production deploy approved' : 'Production deploy rejected',
        },
        {
          unitId: task.body.unitId,
          taskId,
          botId: task.body.botId,
          missionId: task.body.missionId,
        },
        actor,
      );
      return t;
    });
    this.enqueue(task.body.unitId, 'dispatch', () => this.dispatch(task.body.unitId));
    return next;
  }

  /** Move a task to another bot of the same unit. Its workspace (branch) goes with it. */
  async reassign(
    taskId: string,
    input: z.output<typeof ReassignTaskRequest>,
    actor: string,
    w?: RecordWriter,
  ) {
    if (this.runner.isRunning(taskId)) {
      throw new ConflictException({
        message: 'That task is running.',
        action: 'Wait for it to stop before reassigning it.',
      });
    }
    const go = async (w: RecordWriter) => {
      const task = await w.getActive('task', taskId);
      if (!task) throw new BadRequestException(`No task with id ${taskId}.`);
      if (!REASSIGNABLE.includes(task.body.status)) {
        throw new ConflictException({
          message: `Task #${task.body.number} is ${task.body.status}.`,
          action: 'Only queued, blocked, stood-down or failed tasks can be reassigned.',
        });
      }
      const to = await w.getActive('bot', input.botId);
      if (!to || to.body.unitId !== task.body.unitId || to.body.isOverseer) {
        throw new BadRequestException('Pick a bot from the same unit (not its Overseer).');
      }
      if (task.body.botId === to.entityId) return task;
      if (task.body.botId) {
        await w.revise(
          'bot',
          task.body.botId,
          (b) => ({
            ...b,
            queue: b.queue.filter((q) => q !== taskId),
            currentTaskId: b.currentTaskId === taskId ? null : b.currentTaskId,
            status:
              b.currentTaskId === taskId && (b.status === 'blocked' || b.status === 'failed')
                ? 'idle'
                : b.status,
          }),
          { actor, reason: `Task #${task.body.number} reassigned to ${to.body.callsign}` },
        );
      }
      await w.revise('bot', to.entityId, (b) => ({ ...b, queue: [...b.queue, taskId] }), {
        actor,
        reason: `Task #${task.body.number} reassigned here`,
      });
      await w.event(
        'task.reassigned',
        { fromBotId: task.body.botId, toBotId: to.entityId, reason: input.reason },
        { unitId: task.body.unitId, botId: to.entityId, taskId, missionId: task.body.missionId },
        actor,
      );
      return w.revise(
        'task',
        taskId,
        (t) => ({
          ...t,
          botId: to.entityId,
          status: 'queued',
          statusReason: `Reassigned to ${to.body.callsign}: ${input.reason}`,
        }),
        { actor, reason: `Reassigned to ${to.body.callsign}: ${input.reason}` },
      );
    };
    return w ? go(w) : this.record.transaction(go);
  }

  /** Add a bot to a unit, optionally replacing one: the old bot stands down and its work moves over. */
  async addBot(unitId: string, input: z.output<typeof AddBotRequest>, actor: string) {
    await this.record.requireActive('unit', unitId);
    const old = input.replacesBotId
      ? await this.record.requireActive('bot', input.replacesBotId)
      : null;
    if (old) {
      if (old.body.unitId !== unitId || old.body.isOverseer)
        throw new BadRequestException(
          'Only a bot of this unit (not its Overseer) can be replaced here.',
        );
      if (old.body.status === 'working') {
        throw new ConflictException({
          message: `${old.body.callsign} is working.`,
          action: 'Wait for it to finish or stand it down before replacing it.',
        });
      }
    }
    const callsign = await this.force.nextCallsign(unitId);
    return this.record.transaction(async (w) => {
      const bot = await w.create(
        'bot',
        {
          unitId,
          callsign,
          role: input.role,
          isOverseer: false,
          status: 'idle',
          currentTaskId: null,
          queue: [],
          runtime: old?.body.runtime ?? 'simulated',
        },
        { actor, reason: old ? `Replaces ${old.body.callsign}: ${input.reason}` : input.reason },
      );
      if (old) {
        // Everything the old bot still owns: current task, queue, and any task it left blocked, failed or stood down.
        const owned = (await w.listActive('task', { bodyContains: { botId: old.entityId } }))
          .filter((t) => REASSIGNABLE.includes(t.body.status))
          .map((t) => t.entityId);
        const work = [
          ...new Set([
            ...(old.body.currentTaskId ? [old.body.currentTaskId] : []),
            ...old.body.queue,
            ...owned,
          ]),
        ];
        for (const taskId of work) {
          await this.reassign(
            taskId,
            { botId: bot.entityId, reason: `${old.body.callsign} replaced by ${callsign}` },
            actor,
            w,
          );
        }
        await w.revise(
          'bot',
          old.entityId,
          (b) => ({ ...b, status: 'stood-down', currentTaskId: null, queue: [] }),
          {
            actor,
            reason: `Replaced by ${callsign}: ${input.reason}`,
          },
        );
      }
      return bot;
    });
  }

  /**
   * Orders or supply changed: make it reach work already in progress. Running bots get a
   * frago (they re-read their orders); blocked tasks whose reason the change speaks to are
   * started again. New tasks pick the change up from their brief anyway.
   */
  applyToLiveWork(
    unitId: string,
    change: { summary: string; affects: string[] },
    actor: string,
  ): void {
    if (!change.affects.length) return;
    this.enqueue(unitId, 'live-work', async () => {
      const cmd = await this.overseers.of(unitId);
      for (const taskId of this.runner.runningIn(unitId)) {
        await this.runner.frago(taskId, change.summary, actor, cmd.actor);
      }
      const about = change.affects.flatMap((a) => [...words(a)]);
      const blocked = (await this.record.listActive('task', { unitId })).filter(
        (t) => t.body.status === 'blocked',
      );
      for (const t of blocked) {
        const reason = words(t.body.statusReason ?? '');
        const shared = about.filter(
          (w) =>
            reason.has(w) || [...reason].some((r) => r.startsWith(w.slice(0, 5)) && w.length > 4),
        );
        if (shared.length < 2 || this.runner.isRunning(t.entityId)) continue;
        await this.record.event(
          'sitrep',
          {
            level: 'unit',
            text: `Frago: task #${t.body.number} was blocked (“${t.body.statusReason}”); orders changed (${change.summary}) — resuming.`,
            status: null,
          },
          { unitId, taskId: t.entityId, botId: t.body.botId, missionId: t.body.missionId },
          cmd.actor,
        );
        await this.runner.start(t.entityId, cmd.actor).catch(async (err: Error) => {
          await this.record.event(
            'sitrep',
            {
              level: 'unit',
              text: `Could not resume task #${t.body.number}: ${err.message}`,
              status: null,
            },
            { unitId, taskId: t.entityId },
            cmd.actor,
          );
        });
      }
    });
  }

  private sitrep(
    w: RecordWriter,
    unitId: string,
    missionId: string | null,
    taskId: string | null,
    actor: string,
    text: string,
    status: TaskStatus | null = null,
  ) {
    return w.event('sitrep', { level: 'unit', text, status }, { unitId, missionId, taskId }, actor);
  }
}
