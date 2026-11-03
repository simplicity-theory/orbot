import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';
import {
  canTransition,
  describeNeeds,
  missingNeeds,
  resourceKindOf,
  type BotRuntime,
  type OperationBody,
  type OperationNeed,
  type OperationPlan,
  type SupplyBody,
  type UnitBody,
  type OperationPhase,
  type RecordEvent,
  type RecordVersion,
  type TaskBody,
  type MissionBody,
  type HoldPolicy,
} from '@orbot/shared';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { Background } from '../common/background.js';
import { RecordBus } from '../record/record-bus.js';
import { RecordService, type RecordWriter } from '../record/record.service.js';
import { RuntimeRegistry } from '../runtime/runtime.registry.js';
import { WorkspaceManager } from '../runtime/workspace-manager.js';
import { SitesService } from '../servers/sites.service.js';
import { SupplyService } from '../supply/supply.service.js';
import { OverseerService } from './overseer.service.js';
import { ReconService } from './recon.service.js';
import { SandTableService } from './sand-table.service.js';
import { HQ_ACTOR } from './overseers.js';
import { TaskRunner } from '../execution/task-runner.js';
import { SettingsService } from '../settings/settings.service.js';

export { HQ_ACTOR };

/**
 * What an operation needs once planned: a repository always; a production environment if a
 * mission deploys; and whatever else HQ's plan names. Duplicates are dropped.
 */
export function needsFor(current: OperationNeed[], plan: OperationPlan): OperationNeed[] {
  const out: OperationNeed[] = [...current];
  const add = (n: OperationNeed) => {
    if (!out.some((x) => x.kind === n.kind && x.tier === n.tier)) out.push(n);
  };
  add({ kind: 'repository', label: 'A repository to work in', tier: null, optional: false });
  if (plan.missions.some((m) => m.stage === 'deploy')) {
    add({
      kind: 'environment',
      label: 'A production environment to deploy to',
      tier: 'production',
      optional: false,
    });
  }
  for (const n of plan.needs ?? []) add({ ...n, tier: n.tier ?? null, optional: !!n.optional });
  return out;
}

/**
 * HQ, the planning layer. Turns the Commander's intent into an operation, splits it into
 * one mission per unit in handoff order (Engineers → Inspection → Guard → Logistics),
 * passes work down the chain, sends failed checks back up it, and closes the operation
 * with an After Action review whose lessons are recorded for the Commander (D124).
 *
 * Operation lifecycle: Intent → O Group → Backbrief → Execution → Handoffs → Sitreps →
 * After Action → Closed (a Frago may be issued at any time before After Action).
 */
@Injectable()
export class HqService implements OnApplicationBootstrap, OnModuleDestroy {
  private sub: Subscription | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly record: RecordService,
    private readonly bus: RecordBus,
    private readonly background: Background,
    private readonly runtimes: RuntimeRegistry,
    private readonly workspaces: WorkspaceManager,
    private readonly sites: SitesService,
    private readonly supply: SupplyService,
    private readonly overseer: OverseerService,
    private readonly recon: ReconService,
    private readonly sandTables: SandTableService,
    private readonly runner: TaskRunner,
    private readonly settings: SettingsService,
  ) {}

  /** HQ's staff thinks through the default runtime (HQ has no unit of its own). */
  private get staff(): BotRuntime {
    return this.runtimes.get(this.config.defaultRuntime);
  }

  onApplicationBootstrap(): void {
    this.background.run('startup', 'hq:permissions', () => this.decidePendingForCommander());
    this.background.run('startup', 'hq:retries', () => this.retryFailedForCommander());
    this.sub = this.bus.notifications$.subscribe((n) => {
      if (n.type === 'version') {
        const v = n.version;
        const b = v.body as Record<string, unknown>;
        if (v.entityType === 'mission' && b['operationId'] && b['status'] === 'done') {
          this.enqueue(b['operationId'] as string, 'handoff', () => this.missionDone(v.entityId));
        } else if (v.entityType === 'backbrief' && b['status'] === 'approved') {
          this.enqueue(`bb:${v.entityId}`, 'execution', () =>
            this.maybeExecute(b['missionId'] as string),
          );
        }
      } else {
        const e = n.event;
        // A recon HQ ordered before planning has finished (or failed): plan now.
        if (e.kind === 'task.status' && e.taskId) {
          const to = (e as RecordEvent<'task.status'>).body.to;
          if (to === 'done' || to === 'failed') {
            const taskId = e.taskId;
            this.background.run('hq:recon', 'hq:recon-done', async () => {
              const [op] = await this.record.listActive('operation', {
                bodyContains: { reconTaskId: taskId },
              });
              if (op && op.body.phase === 'o-group')
                this.enqueue(op.entityId, 'o-group', () => this.oGroup(op.entityId));
            });
          }
        }
        if (!e.operationId) return;
        if (e.kind === 'task.status') {
          const s = (e as RecordEvent<'task.status'>).body;
          if (s.to === 'done' || (s.to === 'stood-down' && s.reason?.startsWith('Sent back:'))) {
            this.enqueue(e.operationId, 'task', () => this.taskChanged(e.taskId!, s.to, s.reason));
          } else if (s.to === 'failed' && e.taskId && e.unitId) {
            // A fully automatic theatre: HQ retries a failed task before anyone asks the Commander (D128).
            const taskId = e.taskId;
            this.background.run(`unit:${e.unitId}`, 'hq:retry', () =>
              this.retryForCommander(taskId),
            );
          }
        } else if (e.kind === 'permission.requested' && e.taskId) {
          // A fully automatic theatre: HQ answers for the Commander (D125).
          const taskId = e.taskId;
          this.enqueue(e.operationId, 'permission', () => this.decideForCommander(taskId));
        } else if (e.kind === 'deployment') {
          this.enqueue(e.operationId, 'deployment', () =>
            this.deployed(e as RecordEvent<'deployment'>),
          );
        }
      }
    });
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
  }

  private enqueue(key: string, label: string, job: () => Promise<unknown>) {
    this.background.run(key.startsWith('bb:') ? key : `op:${key}`, `hq:${label}`, job);
  }

  // ---------- Intent and O Group ----------

  /** The Commander states intent: HQ opens an operation and plans it in the background. */
  async createOperation(
    intent: string,
    name: string | null,
    actor: string,
    budgetUnits: number | null = null,
    reconFirst = false,
    supplyIds: string[] = [],
    opts: {
      theatreId?: string | null;
      holdPolicy?: HoldPolicy | null;
      autonomous?: boolean;
      campaignId?: string | null;
    } = {},
  ): Promise<RecordVersion<OperationBody>> {
    const opName = name ?? intent.split(/\s+/).slice(0, 3).join(' ');
    const resources: RecordVersion<SupplyBody>[] = [];
    for (const id of new Set(supplyIds)) resources.push(await this.assignable(id));
    const op = await this.record.transaction(async (w) => {
      const created = await w.create(
        'operation',
        {
          name: opName,
          intent,
          phase: 'intent',
          theatreId: opts.theatreId ?? null,
          autonomous: opts.autonomous ?? false,
          campaignId: opts.campaignId ?? null,
          holdPolicy: opts.holdPolicy ?? null,
          supplyIds: resources.map((r) => r.entityId),
          budgetUnits,
          reconFirst,
        },
        { actor, reason: 'Commander stated intent' },
      );
      const doc = await w.create(
        'document',
        {
          kind: 'operation-record',
          unitId: null,
          title: `Operation ${opName} — shared record`,
          markdown: `# Operation ${opName}\n\n> ${intent}\n`,
          taskId: null,
          botId: null,
          operationId: created.entityId,
        },
        { actor: HQ_ACTOR, reason: 'Shared record opened' },
      );
      await w.revise(
        'operation',
        created.entityId,
        (o) => ({ ...o, recordDocumentId: doc.entityId }),
        { actor: HQ_ACTOR, reason: 'Shared record opened' },
      );
      await this.hqSitrep(
        w,
        created.entityId,
        `Intent received for Operation ${opName}: “${intent}”. Convening the O Group.` +
          (resources.length ? ` Resources: ${resources.map((r) => r.body.name).join(', ')}.` : ''),
      );
      return created;
    });
    this.enqueue(op.entityId, 'o-group', () => this.oGroup(op.entityId));
    return op;
  }

  // ---------- Resources ----------

  /** A depot item that can be assigned to an operation: connected, and a kind an operation uses. */
  private async assignable(supplyId: string) {
    const s = await this.record.getActive('supply', supplyId);
    if (!s) {
      throw new BadRequestException({
        message: 'That is not in the Supply Depot.',
        action: 'Choose something the Supply Depot lists.',
      });
    }
    if (!s.body.connected || !resourceKindOf(s.body)) {
      throw new BadRequestException({
        message: `${s.body.name} cannot be assigned to an operation${s.body.connected ? '' : ': it is not connected'}.`,
        action: 'Assign a connected repository, server, environment, model or credential.',
      });
    }
    return s;
  }

  /** The depot items assigned to an operation, in the order they were assigned. */
  async resourcesOf(op: RecordVersion<OperationBody>): Promise<RecordVersion<SupplyBody>[]> {
    const out: RecordVersion<SupplyBody>[] = [];
    for (const id of op.body.supplyIds) {
      const s = await this.record.getActive('supply', id);
      if (s) out.push(s);
    }
    return out;
  }

  /**
   * Assign a depot item to an operation. Waiting at the O Group, it may be what it needed: HQ
   * checks again. Once missions are out, the units in the chain get it too (a production
   * environment excepted: deploy rights are given by order, with confirmation; a static site
   * goes to the unit that deploys).
   */
  async assignResource(opId: string, supplyId: string, actor: string, reason?: string) {
    const op = await this.record.requireActive('operation', opId);
    this.assertOpen(op, 'Assign resources to');
    const s = await this.assignable(supplyId);
    if (op.body.supplyIds.includes(supplyId)) return { op, supply: s, added: false };
    const revised = await this.record.revise(
      'operation',
      opId,
      (o) => ({ ...o, supplyIds: [...o.supplyIds, supplyId] }),
      { actor, reason: reason || `${s.body.name} assigned to Operation ${op.body.name}` },
    );
    if (op.body.missionIds.length) {
      await this.equipChain(revised, [s]);
    } else {
      this.enqueue(opId, 'o-group', () => this.oGroup(opId));
    }
    return { op: revised, supply: s, added: true };
  }

  /** Changes to an operation's resources or course stop at its After Action review. */
  private assertOpen(op: RecordVersion<OperationBody>, what: string) {
    if (op.body.phase === 'after-action' || op.body.phase === 'closed') {
      throw new BadRequestException({
        message: `Operation ${op.body.name} is ${op.body.cancelled ? 'cancelled' : op.body.phase === 'closed' ? 'closed' : 'in its After Action review'}.`,
        action: `${what} an operation that is still running.`,
      });
    }
  }

  /**
   * Make a repository the operation's main one: where its work lands, is handed off and deploys
   * from. Before the O Group that is all. Once missions are out, they are withdrawn (their work
   * stands down; what was done stays on its branches) and HQ issues them again on the new
   * repository from the same plan, so each unit briefs back afresh.
   */
  async setMainRepository(opId: string, supplyId: string, actor: string, reason?: string) {
    const op = await this.record.requireActive('operation', opId);
    this.assertOpen(op, 'Change the repository of');
    const s = await this.assignable(supplyId);
    if (s.body.spec.kind !== 'repository') {
      throw new BadRequestException({
        message: `${s.body.name} is not a repository.`,
        action: 'Choose a connected repository from the Supply Depot.',
      });
    }
    const current =
      op.body.repoSupplyId ?? (await this.firstRepository(op.body.supplyIds))?.entityId;
    const was = current ? await this.record.getActive('supply', current) : null;
    if (current === supplyId) return { op, supply: s, was, restarted: false, changed: false };
    let revised = await this.record.revise(
      'operation',
      opId,
      (o) => ({ ...o, supplyIds: [supplyId, ...o.supplyIds.filter((x) => x !== supplyId)] }),
      {
        actor,
        reason: reason || `${s.body.name} is now the main repository of Operation ${op.body.name}`,
      },
    );
    if (!op.body.missionIds.length) {
      this.enqueue(opId, 'o-group', () => this.oGroup(opId));
      return { op: revised, supply: s, was, restarted: false, changed: true };
    }
    const missions = await this.withdrawMissions(
      revised,
      `Main repository changed to ${s.body.name}`,
      actor,
    );
    const plan = planOf(revised, missions);
    revised = await this.record.transaction(async (w) => {
      const o = await w.revise(
        'operation',
        opId,
        (x) => ({
          ...x,
          plan,
          missionIds: [],
          withdrawnMissionIds: [...x.withdrawnMissionIds, ...x.missionIds],
          repoSupplyId: null,
          integrationBranch: null,
          deployment: null,
        }),
        { actor, reason: `Missions withdrawn to issue again on ${s.body.name}` },
      );
      await this.hqSitrep(
        w,
        opId,
        `Operation ${op.body.name} moves from ${was?.body.name ?? 'its repository'} to ${s.body.name}: ${missions.length} mission(s) withdrawn and issued again there. Work already done stays on ${was?.body.name ?? 'the old repository'}'s branches.`,
      );
      return o;
    });
    await this.phase(opId, 'o-group', `Issued again on ${s.body.name}`);
    this.enqueue(opId, 'o-group', () => this.oGroup(opId));
    return { op: revised, supply: s, was, restarted: true, changed: true };
  }

  /** Call an operation off: its work stands down and it closes, without an After Action review. */
  async cancelOperation(opId: string, note: string, actor: string) {
    const op = await this.record.requireActive('operation', opId);
    this.assertOpen(op, 'Cancel');
    const missions = await this.withdrawMissions(op, `Operation ${op.body.name} cancelled`, actor);
    const from = op.body.phase;
    const revised = await this.record.transaction(async (w) => {
      const o = await w.revise(
        'operation',
        opId,
        (x) => ({
          ...x,
          phase: 'closed',
          cancelled: { by: actor, note, at: new Date().toISOString() },
        }),
        { actor, reason: note ? `Cancelled: ${note}` : 'Cancelled' },
      );
      await w.event(
        'operation.phase',
        { from, to: 'closed', reason: note ? `Cancelled: ${note}` : 'Cancelled' },
        { operationId: opId },
        actor,
      );
      await this.hqSitrep(
        w,
        opId,
        `Operation ${op.body.name} cancelled${note ? `: ${note}` : ''}. ${missions.length} mission(s) withdrawn; their work stood down and stays on record.`,
      );
      return o;
    });
    await this.renderRecord(opId);
    return revised;
  }

  /**
   * Withdraw an operation's missions: running work stops with a handover, waiting work stands
   * down, pending backbriefs are rejected. Returns the missions as they were.
   */
  private async withdrawMissions(op: RecordVersion<OperationBody>, note: string, actor: string) {
    const missions = (
      await Promise.all(op.body.missionIds.map((id) => this.record.getActive('mission', id)))
    ).filter((m) => !!m);
    for (const m of missions) await this.withdrawMission(m, op.entityId, note, actor);
    return missions;
  }

  /**
   * Withdraw one mission: running work stops with a handover, waiting work stands down, a
   * pending backbrief is rejected. Returns how many tasks were stood down.
   */
  private async withdrawMission(
    m: RecordVersion<MissionBody>,
    operationId: string | null,
    note: string,
    actor: string,
  ): Promise<number> {
    let stood = 0;
    {
      const tasks = await this.record.listActive('task', {
        bodyContains: { missionId: m.entityId },
      });
      for (const t of tasks) {
        if (this.runner.isRunning(t.entityId)) {
          await this.runner.stop(t.entityId, note);
          stood++;
          continue;
        }
        if (!['queued', 'blocked', 'failed', 'awaiting-approval'].includes(t.body.status)) continue;
        stood++;
        await this.record.transaction(async (w) => {
          await w.revise(
            'task',
            t.entityId,
            (x) => ({ ...x, status: 'stood-down', statusReason: note, statusAction: null }),
            { actor, reason: note },
          );
          await w.event(
            'task.status',
            { from: t.body.status, to: 'stood-down', reason: note },
            {
              unitId: t.body.unitId,
              botId: t.body.botId,
              taskId: t.entityId,
              missionId: m.entityId,
              operationId,
            },
            actor,
          );
          if (t.body.botId) {
            await w.revise(
              'bot',
              t.body.botId,
              (b) => ({
                ...b,
                queue: b.queue.filter((q) => q !== t.entityId),
                ...(b.currentTaskId === t.entityId
                  ? { status: 'idle' as const, currentTaskId: null }
                  : {}),
              }),
              { actor, reason: note },
            );
          }
        });
      }
      await this.record.transaction(async (w) => {
        const [bb] = await w.listActive('backbrief', { bodyContains: { missionId: m.entityId } });
        if (bb?.body.status === 'awaiting-approval') {
          await w.revise(
            'backbrief',
            bb.entityId,
            (b) => ({
              ...b,
              status: 'rejected',
              decision: { outcome: 'rejected', by: actor, note, at: new Date().toISOString() },
            }),
            { actor, reason: note },
          );
        }
        if (m.body.status !== 'withdrawn') {
          await w.revise('mission', m.entityId, (x) => ({ ...x, status: 'withdrawn' }), {
            actor,
            reason: note,
          });
        }
      });
    }
    return stood;
  }

  /**
   * Land a task's branch on its repository's default branch: the Commander's order, never a
   * bot's (a bot commits to its own branch only). Recorded as an integration (D117).
   */
  async landTask(taskId: string, actor: string) {
    const task = await this.record.requireActive('task', taskId);
    const ws = task.body.workspace;
    if (!ws) {
      throw new BadRequestException({
        message: `Task #${task.body.number} has no branch yet.`,
        action: 'Start the task first; there is nothing to land until it has committed work.',
      });
    }
    if (task.body.status === 'working') {
      throw new ConflictException({
        message: `Task #${task.body.number} is still working.`,
        action: 'Wait until it is done (or blocked), then land it.',
      });
    }
    const repo = await this.record.requireActive('supply', ws.repoSupplyId);
    const spec = repo.body.spec;
    if (spec.kind !== 'repository') throw new BadRequestException('Not a repository.');
    let landed: { before: string; commit: string };
    try {
      landed = await this.workspaces.land(repo.body, ws.branch);
    } catch (err) {
      throw new ConflictException({
        message: `Could not land ${ws.branch} on ${spec.defaultBranch}: ${(err as Error).message}`,
        action: `The branches conflict. Order the unit to bring ${spec.defaultBranch} into its work first, or resolve it by hand in the repository.`,
      });
    }
    const mission = task.body.missionId
      ? await this.record.getActive('mission', task.body.missionId)
      : null;
    const refs = {
      operationId: mission?.body.operationId ?? null,
      unitId: task.body.unitId,
      taskId,
      missionId: task.body.missionId,
    };
    const unchanged = landed.before === landed.commit;
    await this.record.transaction(async (w) => {
      await w.event(
        'integration',
        { branch: spec.defaultBranch, commit: landed.commit, from: ws.branch },
        refs,
        actor,
      );
      await w.event(
        'sitrep',
        {
          level: 'unit',
          text: unchanged
            ? `${spec.defaultBranch} already had everything on ${ws.branch} (task #${task.body.number}); nothing to land.`
            : `Task #${task.body.number} landed on ${spec.defaultBranch}: ${repo.body.name} is at ${landed.commit.slice(0, 10)}.`,
          status: null,
        },
        refs,
        actor,
      );
    });
    return {
      taskId,
      number: task.body.number,
      repository: repo.body.name,
      branch: spec.defaultBranch,
      from: ws.branch,
      commit: landed.commit,
      unchanged,
    };
  }

  // ---------- Abort a mission, start it over, start an operation over (D113) ----------

  /**
   * Abort one mission: its work stands down (running work with a handover), its pending
   * backbrief is rejected, and it is withdrawn. In an operation the chain is broken until the
   * mission is started over or the operation cancelled, and HQ says so.
   */
  async abortMission(missionId: string, note: string, actor: string) {
    const mission = await this.record.requireActive('mission', missionId);
    if (mission.body.status === 'withdrawn') {
      throw new ConflictException({
        message: `The mission “${mission.body.goal}” is already withdrawn.`,
        action: 'A withdrawn mission can be started over.',
      });
    }
    const op = mission.body.operationId
      ? await this.record.requireActive('operation', mission.body.operationId)
      : null;
    if (op) this.assertOpen(op, 'Abort a mission of');
    const unit = await this.record.requireActive('unit', mission.body.unitId);
    const why = `Mission aborted${note ? `: ${note}` : ''}`;
    const stood = await this.withdrawMission(mission, op?.entityId ?? null, why, actor);
    const kept = `${stood} task(s) stood down; the work stays on record.`;
    if (op) {
      await this.hqSitrep(
        null,
        op.entityId,
        `Mission aborted: “${mission.body.goal}” (${unit.body.name})${note ? `, ${note}` : ''}. ${kept} Operation ${op.body.name} cannot finish without it: start the mission over, or cancel the operation.`,
      );
      await this.renderRecord(op.entityId);
    } else {
      await this.record.event(
        'sitrep',
        {
          level: 'unit',
          text: `Mission aborted: “${mission.body.goal}”${note ? `, ${note}` : ''}. ${kept}`,
          status: null,
        },
        { unitId: unit.entityId, missionId },
        actor,
      );
    }
    return this.record.requireActive('mission', missionId);
  }

  /**
   * Start a mission over: withdrawn (if it is not already), then issued again to its unit with
   * the same goal and definition of done, in the same place in the operation's chain (the next
   * stage waits on the new mission). The unit briefs back afresh. What was done stays on record.
   */
  async restartMission(missionId: string, note: string, actor: string) {
    const old = await this.record.requireActive('mission', missionId);
    const op = old.body.operationId
      ? await this.record.requireActive('operation', old.body.operationId)
      : null;
    if (op) this.assertOpen(op, 'Start a mission over in');
    const unit = await this.record.requireActive('unit', old.body.unitId);
    const why = `Mission started over${note ? `: ${note}` : ''}`;
    const stood =
      old.body.status === 'withdrawn' || old.body.status === 'done'
        ? 0
        : await this.withdrawMission(old, op?.entityId ?? null, why, actor);
    const fresh = await this.record.transaction(async (w) => {
      const m = await w.create(
        'mission',
        {
          operationId: old.body.operationId,
          unitId: old.body.unitId,
          goal: old.body.goal,
          definitionOfDone: old.body.definitionOfDone,
          status: 'planning',
          stage: old.body.stage,
          dependsOnMissionId: old.body.dependsOnMissionId,
          issue: old.body.issue,
          preApproved: old.body.preApproved,
        },
        { actor, reason: why },
      );
      if (old.body.status === 'done') {
        await w.revise('mission', old.entityId, (x) => ({ ...x, status: 'withdrawn' }), {
          actor,
          reason: why,
        });
      }
      const kept = `${stood} task(s) stood down; the work stays on record.`;
      if (op) {
        await w.revise(
          'operation',
          op.entityId,
          (o) => ({
            ...o,
            missionIds: o.missionIds.includes(old.entityId)
              ? o.missionIds.map((id) => (id === old.entityId ? m.entityId : id))
              : [...o.missionIds, m.entityId],
            withdrawnMissionIds: o.withdrawnMissionIds.includes(old.entityId)
              ? o.withdrawnMissionIds
              : [...o.withdrawnMissionIds, old.entityId],
          }),
          { actor, reason: why },
        );
        // The next stage hands off from the new mission, not the withdrawn one.
        const downstream = (
          await w.listActive('mission', { bodyContains: { dependsOnMissionId: old.entityId } })
        ).filter((d) => d.body.operationId === op.entityId);
        for (const d of downstream) {
          await w.revise('mission', d.entityId, (x) => ({ ...x, dependsOnMissionId: m.entityId }), {
            actor,
            reason: why,
          });
        }
        await this.hqSitrep(
          w,
          op.entityId,
          `Mission started over: “${old.body.goal}” issued again to ${unit.body.name}${note ? ` (${note})` : ''}. ${kept} ${unit.body.name} briefs back afresh.`,
        );
      } else {
        await w.event(
          'sitrep',
          {
            level: 'unit',
            text: `Mission started over: “${old.body.goal}”${note ? ` (${note})` : ''}. ${kept} ${unit.body.name} briefs back afresh.`,
            status: null,
          },
          { unitId: unit.entityId, missionId: m.entityId },
          actor,
        );
      }
      return m;
    });
    if (op) {
      // An operation that had every mission done is back in execution.
      const now = await this.record.requireActive('operation', op.entityId);
      if (now.body.phase === 'sitreps')
        await this.phase(op.entityId, 'execution', `Mission “${old.body.goal}” started over`);
      await this.renderRecord(op.entityId);
    }
    return fresh;
  }

  /**
   * Start an operation over: every mission is withdrawn and HQ issues them again from the same
   * plan, on the same resources, so each unit briefs back afresh. Work already integrated stays
   * on the integration branch (nothing is deleted): the new missions build on it.
   */
  async restartOperation(opId: string, note: string, actor: string) {
    const op = await this.record.requireActive('operation', opId);
    this.assertOpen(op, 'Start over');
    if (!op.body.missionIds.length) {
      // Nothing out yet: plan again (after a repository was put right, say).
      await this.hqSitrep(null, opId, `Operation ${op.body.name}: planning again at the O Group.`);
      await this.phase(opId, 'o-group', 'Planning again');
      this.enqueue(opId, 'o-group', () => this.oGroup(opId));
      return this.record.requireActive('operation', opId);
    }
    const why = `Operation ${op.body.name} started over${note ? `: ${note}` : ''}`;
    const missions = await this.withdrawMissions(op, why, actor);
    const plan = planOf(op, missions);
    await this.record.transaction(async (w) => {
      await w.revise(
        'operation',
        opId,
        (x) => ({
          ...x,
          plan,
          missionIds: [],
          withdrawnMissionIds: [...x.withdrawnMissionIds, ...x.missionIds],
          deployment: null,
        }),
        { actor, reason: why },
      );
      await this.hqSitrep(
        w,
        opId,
        `Operation ${op.body.name} started over${note ? `: ${note}` : ''}. ${missions.length} mission(s) withdrawn and issued again from the same plan; what was done stays on record and on the integration branch.`,
      );
    });
    await this.phase(opId, 'o-group', 'Started over');
    this.enqueue(opId, 'o-group', () => this.oGroup(opId));
    return this.record.requireActive('operation', opId);
  }

  /** Take a depot item off an operation. Units that hold it keep it. */
  async releaseResource(opId: string, supplyId: string, actor: string, reason?: string) {
    const op = await this.record.requireActive('operation', opId);
    const s = await this.record.requireActive('supply', supplyId);
    if (!op.body.supplyIds.includes(supplyId)) return { op, supply: s, removed: false };
    if (op.body.repoSupplyId === supplyId && op.body.missionIds.length) {
      throw new BadRequestException({
        message: `${s.body.name} is where Operation ${op.body.name} hands off and deploys from.`,
        action:
          'Make another repository the main one first (its missions are issued again there), then take this one off.',
      });
    }
    const revised = await this.record.revise(
      'operation',
      opId,
      (o) => ({ ...o, supplyIds: o.supplyIds.filter((x) => x !== supplyId) }),
      { actor, reason: reason || `${s.body.name} taken off Operation ${op.body.name}` },
    );
    return { op: revised, supply: s, removed: true };
  }

  /**
   * Give the units in an operation's chain what it was assigned, and open the integration branch
   * on each new repository. A production environment is not issued: that is deploy rights, given
   * by order with confirmation. A static site is the exception: ORBOT publishes it itself, no
   * server is reached, so the unit that deploys gets it with the mission (D111).
   */
  private async equipChain(op: RecordVersion<OperationBody>, items: RecordVersion<SupplyBody>[]) {
    const missions = await Promise.all(
      op.body.missionIds.map((id) => this.record.requireActive('mission', id)),
    );
    const unitIds = [...new Set(missions.map((m) => m.body.unitId))];
    const deployUnitIds = [
      ...new Set(missions.filter((m) => m.body.stage === 'deploy').map((m) => m.body.unitId)),
    ];
    for (const s of items) {
      if (s.body.spec.kind === 'repository' && op.body.integrationBranch) {
        await this.workspaces.createBranch(s.body, op.body.integrationBranch);
      }
      let receivers = unitIds;
      if (s.body.spec.kind === 'environment' && s.body.spec.details['tier'] === 'production') {
        if (!s.body.spec.site) continue;
        receivers = deployUnitIds;
      }
      for (const unitId of receivers) {
        const u = await this.record.requireActive('unit', unitId);
        if (!u.body.supplyIds.includes(s.entityId)) {
          await this.supply.allotToUnit(s.entityId, unitId, {
            actor: HQ_ACTOR,
            reason: `Issued for Operation ${op.body.name}`,
          });
        }
      }
    }
  }

  /** Still missing something it must have: say what, and wait (each assignment checks again). */
  private async waitingForResources(op: RecordVersion<OperationBody>): Promise<boolean> {
    const assigned = (await this.resourcesOf(op)).map((s) => ({ id: s.entityId, body: s.body }));
    const missing = missingNeeds(op.body.needs, assigned);
    if (!missing.length) return false;
    await this.hqSitrep(
      null,
      op.entityId,
      `Operation ${op.body.name} is waiting for resources: ${describeNeeds(missing)}. Assign them on the operation's page or in chat; HQ carries on as soon as it has them.`,
    );
    return true;
  }

  // ---------- O Group ----------

  /**
   * O Group: plan the missions, check the operation has what it needs, then issue them and open
   * the integration branch. It runs again whenever a resource is assigned while it waits.
   */
  private async oGroup(opId: string): Promise<void> {
    let op = await this.record.requireActive('operation', opId);
    if (op.body.missionIds.length || !['intent', 'o-group'].includes(op.body.phase)) return;
    await this.phase(opId, 'o-group', 'Planning missions');
    const units = (await this.record.listActive('unit')).filter((u) => u.body.overseerBotId);
    // A repository before anything: recon and planning both need somewhere to look.
    if (await this.waitingForResources(op)) return;
    const resources = await this.resourcesOf(op);
    const repos = resources.filter((r) => r.body.spec.kind === 'repository');

    if (!op.body.plan) {
      // Recon first: the report must be in (or the recon over) before HQ plans.
      let recon: { unit: string; title: string; markdown: string }[] = [];
      if (op.body.reconFirst && op.body.reconTaskId) {
        const task = await this.record.requireActive('task', op.body.reconTaskId);
        if (task.body.status !== 'done' && task.body.status !== 'failed') return;
        const report = await this.recon.reportFor(task.entityId);
        const unit = units.find((u) => u.entityId === task.body.unitId);
        if (report) {
          recon = [
            {
              unit: unit?.body.name ?? '',
              title: report.body.title,
              markdown: report.body.markdown,
            },
          ];
        } else {
          await this.hqSitrep(
            null,
            opId,
            `Recon #${task.body.number} ended without a report (${task.body.status}). Planning without it.`,
          );
        }
      }
      let plan: Awaited<ReturnType<typeof this.staff.planOperation>>;
      try {
        plan = await this.planWithStaff(op, units, resources, recon);
      } catch (err) {
        const why = (err as Error).message;
        await this.record.revise('operation', opId, (o) => ({ ...o, planningError: why }), {
          actor: HQ_ACTOR,
          reason: 'O Group could not plan',
        });
        await this.hqSitrep(
          null,
          opId,
          `HQ could not plan Operation ${op.body.name}: ${why} Put it right, then Start over on the operation to plan again.`,
        );
        return;
      }
      if (op.body.planningError) {
        await this.record.revise('operation', opId, (o) => ({ ...o, planningError: null }), {
          actor: HQ_ACTOR,
          reason: 'O Group planned',
        });
      }
      if (op.body.reconFirst && !op.body.reconTaskId && plan.missions.length) {
        // The unit that would build it looks first; HQ plans once its report is in.
        const builder = units.find((u) => u.entityId === plan.missions[0]!.unitId)!;
        try {
          if (repos[0] && !builder.body.supplyIds.includes(repos[0].entityId)) {
            await this.supply.allotToUnit(repos[0].entityId, builder.entityId, {
              actor: HQ_ACTOR,
              reason: `Issued for recon on Operation ${op.body.name}`,
            });
          }
          const task = await this.recon.order(
            {
              unitId: builder.entityId,
              question: `What would it take to: ${op.body.intent.replace(/[.!]+$/, '')}?`,
              repoSupplyId: repos[0]?.entityId ?? null,
            },
            HQ_ACTOR,
            `Recon before the O Group for Operation ${op.body.name}`,
          );
          await this.record.transaction(async (w) => {
            await w.revise('operation', opId, (o) => ({ ...o, reconTaskId: task.entityId }), {
              actor: HQ_ACTOR,
              reason: 'Recon before planning',
            });
            await this.hqSitrep(
              w,
              opId,
              `HQ sent ${builder.body.name} on recon (task #${task.body.number}) before planning Operation ${op.body.name}. The plan follows the report.`,
            );
          });
          return;
        } catch (err) {
          await this.hqSitrep(
            null,
            opId,
            `Could not send ${builder.body.name} on recon (${(err as Error).message}). Planning without it.`,
          );
        }
      }
      if (!plan.missions.length) {
        await this.hqSitrep(
          null,
          opId,
          'No unit can take this on: HQ found no matching units. Operation stays at O Group.',
        );
        return;
      }
      const missions = this.straightPath(op, plan.missions, resources);
      if (missions.length !== plan.missions.length) {
        await this.hqSitrep(
          null,
          opId,
          `Automatic single-file project: ${missions.map((m) => m.stage).join(' → ')} only. HQ lands the work and publishes it when they are done.`,
        );
      }
      op = await this.record.revise(
        'operation',
        opId,
        (o) => ({ ...o, plan: missions, needs: needsFor(o.needs, { ...plan, missions }) }),
        { actor: HQ_ACTOR, reason: 'O Group plan: missions and what they need' },
      );
      if (await this.waitingForResources(op)) return;
    } else if (await this.waitingForResources(op)) {
      return;
    }
    await this.issueMissions(op, units);
  }

  /** HQ's staff plans the operation: a mission per unit from the intent, the units and the resources. */
  private planWithStaff(
    op: RecordVersion<OperationBody>,
    units: RecordVersion<UnitBody>[],
    resources: RecordVersion<SupplyBody>[],
    recon: { unit: string; title: string; markdown: string }[],
  ) {
    return this.staff.planOperation({
      name: op.body.name,
      intent: op.body.intent,
      units: units.map((u) => ({
        id: u.entityId,
        name: u.body.name,
        role: u.body.role,
        standingMission: u.body.standingMission,
      })),
      resources: resources.map((r) => ({
        name: r.body.name,
        kind: resourceKindOf(r.body) ?? r.body.spec.kind,
        project: r.body.spec.kind === 'repository' ? r.body.spec.project : null,
      })),
      recon,
    });
  }

  /** Issue the planned missions, equip the chain, and open the integration branch. */
  private async issueMissions(
    op: RecordVersion<OperationBody>,
    units: RecordVersion<UnitBody>[],
  ): Promise<void> {
    const opId = op.entityId;
    const planned = (op.body.plan ?? []).filter((m) => units.some((u) => u.entityId === m.unitId));
    if (!planned.length) {
      await this.hqSitrep(
        null,
        opId,
        'No unit can take this on: HQ found no matching units. Operation stays at O Group.',
      );
      return;
    }
    // Work lands on one integration branch, opened in every repository the operation has; the
    // first repository is where it is handed off and deployed from.
    const resources = await this.resourcesOf(op);
    const repo = resources.find((r) => r.body.spec.kind === 'repository') ?? null;
    const integrationBranch = repo ? `orbot/op-${opId.slice(0, 8)}` : null;
    // The branch the work lands on is opened first: if the repository cannot take it (no
    // commits, no such default branch), nothing is issued and HQ says what to fix (D120).
    if (repo && integrationBranch) {
      try {
        await this.workspaces.createBranch(repo.body, integrationBranch);
      } catch (err) {
        await this.hqSitrep(
          null,
          opId,
          `Operation ${op.body.name} stays at the O Group: the integration branch cannot be opened in ${repo.body.name}: ${(err as Error).message} Fix the repository (or make another the main one), then Start over.`,
        );
        return;
      }
    }

    await this.record.transaction(async (w) => {
      const ids: string[] = [];
      let upstream: string | null = null;
      for (const m of planned) {
        const mission: RecordVersion<import('@orbot/shared').MissionBody> = await w.create(
          'mission',
          {
            operationId: opId,
            unitId: m.unitId,
            goal: m.goal,
            definitionOfDone: m.definitionOfDone,
            status: 'planning',
            stage: m.stage,
            dependsOnMissionId: upstream,
            // An automatic theatre: the Commander's standing order is the approval.
            preApproved: op.body.autonomous,
          },
          { actor: HQ_ACTOR, reason: `O Group for Operation ${op.body.name}` },
        );
        ids.push(mission.entityId);
        upstream = mission.entityId;
      }
      await w.revise(
        'operation',
        opId,
        (o) => ({
          ...o,
          missionIds: ids,
          repoSupplyId: repo?.entityId ?? null,
          integrationBranch,
        }),
        { actor: HQ_ACTOR, reason: 'Missions issued at the O Group' },
      );
      const chain = planned
        .map((m) => units.find((u) => u.entityId === m.unitId)!.body.name)
        .join(' → ');
      await this.hqSitrep(
        w,
        opId,
        `O Group done: ${planned.length} missions issued (${chain}). Waiting for each unit's backbrief.`,
      );
    });
    // Every unit in the chain gets what the operation was given, and the branch in each repo.
    await this.equipChain(await this.record.requireActive('operation', opId), resources);
    await this.phase(opId, 'backbrief', 'Missions issued; units are briefing back');
    await this.renderRecord(opId);
    // Rehearse the plan on the sand table while it can still be put right.
    await this.sandTables.rehearse(opId, HQ_ACTOR);
  }

  /** Once every mission's backbrief is approved, execution starts. */
  private async maybeExecute(missionId: string): Promise<void> {
    const mission = await this.record.getActive('mission', missionId);
    const opId = mission?.body.operationId;
    if (!opId) return;
    this.enqueue(opId, 'execution', async () => {
      const op = await this.record.requireActive('operation', opId);
      if (op.body.phase !== 'backbrief') return;
      const briefs = await Promise.all(
        op.body.missionIds.map(
          async (id) =>
            (await this.record.listActive('backbrief', { bodyContains: { missionId: id } }))[0],
        ),
      );
      if (briefs.every((b) => b?.body.status === 'approved')) {
        await this.phase(opId, 'execution', 'Every backbrief approved');
        await this.renderRecord(opId);
        // A last rehearsal with the approved plans' tasks.
        await this.sandTables.rehearse(opId, HQ_ACTOR);
      }
    });
  }

  // ---------- Execution, handoffs, send-backs ----------

  private async taskChanged(taskId: string, to: string, reason: string | null): Promise<void> {
    const task = await this.record.requireActive('task', taskId);
    const mission = task.body.missionId
      ? await this.record.getActive('mission', task.body.missionId)
      : null;
    const op = mission?.body.operationId
      ? await this.record.getActive('operation', mission.body.operationId)
      : null;
    if (!mission || !op) return;
    if (to === 'done' && (task.body.kind === 'work' || task.body.kind === 'fix')) {
      await this.integrate(op, task);
    } else if (to === 'stood-down' && reason?.startsWith('Sent back:')) {
      await this.sendBack(op, mission.entityId, task, reason.replace(/^Sent back:\s*/, ''));
    }
  }

  /** Merge a finished task's branch into the operation's integration branch. */
  private async integrate(op: RecordVersion<OperationBody>, task: RecordVersion<TaskBody>) {
    if (!op.body.integrationBranch || !op.body.repoSupplyId || !task.body.workspace) return;
    // Into the integration branch of the repository the task worked in (each of the
    // operation's repositories has one).
    const repoId = op.body.supplyIds.includes(task.body.workspace.repoSupplyId)
      ? task.body.workspace.repoSupplyId
      : op.body.repoSupplyId;
    const repo = await this.record.requireActive('supply', repoId);
    const commit = await this.workspaces.integrate(
      repo.body,
      op.body.integrationBranch,
      task.body.workspace.branch,
    );
    await this.record.event(
      'integration',
      { branch: op.body.integrationBranch, commit, from: task.body.workspace.branch },
      {
        operationId: op.entityId,
        unitId: task.body.unitId,
        taskId: task.entityId,
        missionId: task.body.missionId,
      },
      HQ_ACTOR,
    );
  }

  /** A check failed: the work goes back to the unit that handed it over, with the reason. */
  private async sendBack(
    op: RecordVersion<OperationBody>,
    missionId: string,
    task: RecordVersion<TaskBody>,
    reason: string,
  ) {
    const mission = await this.record.requireActive('mission', missionId);
    if (!mission.body.dependsOnMissionId) return;
    const upstream = await this.record.requireActive('mission', mission.body.dependsOnMissionId);
    const [fromUnit, toUnit] = await Promise.all([
      this.record.requireActive('unit', mission.body.unitId),
      this.record.requireActive('unit', upstream.body.unitId),
    ]);
    // The upstream unit's least busy bot takes the fix.
    const bots = (await this.record.listActive('bot', { unitId: toUnit.entityId })).filter(
      (b) => !b.body.isOverseer && b.body.status !== 'stood-down',
    );
    // Prefer a free bot: one that is blocked or failed elsewhere would never pick the fix up.
    const free = (b: (typeof bots)[number]) =>
      b.body.status === 'idle' || b.body.status === 'working' ? 0 : 1;
    const bot = bots.sort(
      (a, b) =>
        free(a) - free(b) ||
        a.body.queue.length - b.body.queue.length ||
        a.body.callsign.localeCompare(b.body.callsign, undefined, { numeric: true }),
    )[0];
    const number = await this.record.nextTaskNumber();
    await this.record.transaction(async (w) => {
      await w.revise('mission', mission.entityId, (m) => ({ ...m, status: 'waiting' }), {
        actor: HQ_ACTOR,
        reason: `Sent back to ${toUnit.body.name}: ${reason}`,
      });
      await w.revise('mission', upstream.entityId, (m) => ({ ...m, status: 'working' }), {
        actor: HQ_ACTOR,
        reason: `Work sent back by ${fromUnit.body.name}: ${reason}`,
      });
      const fix = await w.create(
        'task',
        {
          number,
          title: `Fix: ${reason.replace(/[.]$/, '')}`,
          description: `Sent back by ${fromUnit.body.name} (task #${task.body.number}): ${reason}`,
          unitId: toUnit.entityId,
          missionId: upstream.entityId,
          botId: bot?.entityId ?? null,
          status: 'queued',
          budget: { limitUnits: null, spentUnits: 0 },
          // The fix lands where the check found the problem.
          repoSupplyId:
            task.body.repoSupplyId && op.body.supplyIds.includes(task.body.repoSupplyId)
              ? task.body.repoSupplyId
              : op.body.repoSupplyId,
          workspace: null,
          credentialNames: [],
          scenario: 'fix',
          statusReason: null,
          autoStart: true,
          kind: 'fix',
          baseRef: op.body.integrationBranch,
        },
        { actor: HQ_ACTOR, reason: `Send-back from ${fromUnit.body.name}` },
      );
      await w.event(
        'task.assigned',
        { taskNumber: number, title: fix.body.title },
        {
          unitId: toUnit.entityId,
          botId: bot?.entityId ?? null,
          taskId: fix.entityId,
          missionId: upstream.entityId,
          operationId: op.entityId,
        },
        HQ_ACTOR,
      );
      if (bot)
        await w.revise('bot', bot.entityId, (b) => ({ ...b, queue: [...b.queue, fix.entityId] }), {
          actor: HQ_ACTOR,
          reason: `Fix #${number} queued`,
        });
      await w.event(
        'sendback',
        {
          fromUnitId: fromUnit.entityId,
          toUnitId: toUnit.entityId,
          reason,
          fixTaskId: fix.entityId,
        },
        { operationId: op.entityId, unitId: toUnit.entityId, taskId: task.entityId },
        HQ_ACTOR,
      );
      await this.hqSitrep(
        w,
        op.entityId,
        `${fromUnit.body.name} sent the work back to ${toUnit.body.name}: “${reason}” Fix issued as task #${number}.`,
      );
    });
    this.overseer.dispatchSoon(toUnit.entityId);
    await this.renderRecord(op.entityId);
  }

  /** A mission is done: hand off to the next unit, or wrap up the operation. */
  private async missionDone(missionId: string): Promise<void> {
    const mission = await this.record.requireActive('mission', missionId);
    const op = await this.record.requireActive('operation', mission.body.operationId!);
    if (!op.body.missionIds.includes(missionId)) return; // not a mission HQ planned
    const next = (
      await this.record.listActive('mission', { bodyContains: { dependsOnMissionId: missionId } })
    ).find((m) => m.body.operationId === op.entityId);
    if (next) {
      if (next.body.status !== 'waiting') return;
      const repo = op.body.repoSupplyId
        ? await this.record.requireActive('supply', op.body.repoSupplyId)
        : null;
      const commit =
        repo && op.body.integrationBranch
          ? await this.workspaces.head(repo.body, op.body.integrationBranch)
          : '';
      const [fromUnit, toUnit] = await Promise.all([
        this.record.requireActive('unit', mission.body.unitId),
        this.record.requireActive('unit', next.body.unitId),
      ]);
      const sentBack = (
        await this.record.listActive('task', { bodyContains: { missionId: next.entityId } })
      ).filter(
        (t) => t.body.status === 'stood-down' && t.body.statusReason?.startsWith('Sent back:'),
      );
      await this.record.transaction(async (w) => {
        await w.revise('mission', next.entityId, (m) => ({ ...m, status: 'working' }), {
          actor: HQ_ACTOR,
          reason: `Handed off by ${fromUnit.body.name}`,
        });
        for (const t of sentBack) {
          await w.revise(
            'task',
            t.entityId,
            (b) => ({
              ...b,
              status: 'queued',
              statusReason: `Re-check after ${fromUnit.body.name}'s fix`,
              statusAction: null,
            }),
            { actor: HQ_ACTOR, reason: 'Re-check after the fix' },
          );
          await w.event(
            'task.status',
            { from: 'stood-down', to: 'queued', reason: 'Re-check after the fix' },
            {
              unitId: t.body.unitId,
              botId: t.body.botId,
              taskId: t.entityId,
              missionId: next.entityId,
              operationId: op.entityId,
            },
            HQ_ACTOR,
          );
          if (t.body.botId)
            await w.revise(
              'bot',
              t.body.botId,
              (b) => (b.queue.includes(t.entityId) ? b : { ...b, queue: [...b.queue, t.entityId] }),
              { actor: HQ_ACTOR, reason: 'Re-check queued' },
            );
        }
        await w.event(
          'handoff',
          {
            fromUnitId: fromUnit.entityId,
            toUnitId: toUnit.entityId,
            fromMissionId: missionId,
            toMissionId: next.entityId,
            ref: op.body.integrationBranch ?? '',
            commit,
          },
          { operationId: op.entityId, unitId: toUnit.entityId, missionId: next.entityId },
          HQ_ACTOR,
        );
        await this.hqSitrep(
          w,
          op.entityId,
          `Handoff: ${fromUnit.body.name} → ${toUnit.body.name}${commit ? ` at ${commit.slice(0, 10)}` : ''}.`,
        );
      });
      if (op.body.phase === 'execution')
        await this.phase(
          op.entityId,
          'handoffs',
          `${fromUnit.body.name} handed off to ${toUnit.body.name}`,
        );
      this.overseer.dispatchSoon(toUnit.entityId);
      await this.renderRecord(op.entityId);
      return;
    }
    // The last mission in the chain is done.
    const all = await Promise.all(
      op.body.missionIds.map((id) => this.record.getActive('mission', id)),
    );
    if (
      all.every((m) => m?.body.status === 'done') &&
      !['sitreps', 'after-action', 'closed'].includes(op.body.phase)
    ) {
      await this.phase(op.entityId, 'sitreps', 'Every mission done');
      if (op.body.autonomous) await this.landAndPublish(op.entityId);
      const done = await this.record.requireActive('operation', op.entityId);
      await this.hqSitrep(
        null,
        op.entityId,
        `All missions complete${done.body.deployment ? `; deployed to ${done.body.deployment.environment} at ${done.body.deployment.commit.slice(0, 10)}` : ''}. Holding the After Action review.`,
      );
      await this.afterAction(op.entityId);
    }
  }

  /**
   * In a fully automatic theatre nothing waits for the Commander: a permission request under a
   * unit's rules of engagement is granted by HQ on the Commander's behalf, with a note, and the
   * task carries on (D125). Pending requests are decided at boot too.
   */
  private async decideForCommander(taskId: string): Promise<void> {
    const task = await this.record.getActive('task', taskId);
    if (
      !task ||
      task.body.status !== 'awaiting-approval' ||
      task.body.permission?.status !== 'pending'
    )
      return;
    const mission = task.body.missionId
      ? await this.record.getActive('mission', task.body.missionId)
      : null;
    const op = mission?.body.operationId
      ? await this.record.getActive('operation', mission.body.operationId)
      : null;
    if (!op?.body.autonomous) return;
    await this.overseer.decidePermission(
      taskId,
      true,
      'Automatic theatre: HQ decides for the Commander. Take the cautious course and record what you did in the handover.',
      HQ_ACTOR,
    );
    await this.hqSitrep(
      null,
      op.entityId,
      `HQ granted task #${task.body.number}'s request for the Commander (automatic theatre): ${task.body.permission.action.slice(0, 160)}`,
    );
  }

  /**
   * In a fully automatic theatre a task that fails once is started again by HQ on the same
   * branch, with a note saying why, before anything reaches the Commander; only a task that
   * has failed as many times as the escalation setting allows goes up the chain (D128).
   */
  private async retryForCommander(taskId: string): Promise<void> {
    const task = await this.record.getActive('task', taskId);
    if (!task || task.body.status !== 'failed') return;
    const mission = task.body.missionId
      ? await this.record.getActive('mission', task.body.missionId)
      : null;
    const op = mission?.body.operationId
      ? await this.record.getActive('operation', mission.body.operationId)
      : null;
    if (!op?.body.autonomous || op.body.phase === 'closed' || mission?.body.status === 'withdrawn')
      return;
    const { escalation } = await this.settings.get();
    const failures = (
      await this.record.listEvents({ taskId, kinds: ['task.status'], limit: 1000 })
    ).filter((e) => (e as RecordEvent<'task.status'>).body.to === 'failed').length;
    if (failures >= escalation.repeatedFailures) return;
    const reason = task.body.statusReason ?? 'no reason recorded';
    const note = `HQ started it again (attempt ${failures + 1}, automatic theatre): the last run stopped: ${reason} The branch holds the work so far: read it (git log, git status), finish what is left, commit, and hand over. Spend turns on the task, not on rebuilding what is there.`;
    await this.record.revise(
      'task',
      taskId,
      (t) => ({
        ...t,
        description: `${t.description}

Frago: ${note}`.trim(),
        statusAction: null,
      }),
      { actor: HQ_ACTOR, reason: `Retry ${failures + 1}: ${reason}` },
    );
    try {
      await this.runner.resume(taskId, HQ_ACTOR);
    } catch (err) {
      await this.hqSitrep(
        null,
        op.entityId,
        `HQ could not start task #${task.body.number} again: ${(err as Error).message}`,
      );
      return;
    }
    await this.hqSitrep(
      null,
      op.entityId,
      `HQ started task #${task.body.number} again for the Commander (automatic theatre, attempt ${failures + 1}): ${reason}`,
    );
  }

  /** Failed tasks of automatic operations left over from before a restart: started again now. */
  private async retryFailedForCommander(): Promise<void> {
    const failed = await this.record.listActive('task', { bodyContains: { status: 'failed' } });
    for (const t of failed) {
      if (t.body.missionId) await this.retryForCommander(t.entityId);
    }
  }

  /** Requests left waiting on an automatic operation (a restart in between): decided now. */
  private async decidePendingForCommander(): Promise<void> {
    const waiting = await this.record.listActive('task', {
      bodyContains: { status: 'awaiting-approval' },
    });
    for (const t of waiting) {
      if (t.body.permission?.status === 'pending') await this.decideForCommander(t.entityId);
    }
  }

  /**
   * An automatic theatre's operation is over: the integrated work lands on the default branch
   * (the code is in the repository), and if the theatre publishes automatically, the default
   * branch goes to the site, so the Commander opens the app from a link (D122).
   */
  private async landAndPublish(opId: string): Promise<void> {
    const op = await this.record.requireActive('operation', opId);
    const refs = { operationId: opId };
    const repo = op.body.repoSupplyId
      ? await this.record.getActive('supply', op.body.repoSupplyId)
      : null;
    if (!repo || repo.body.spec.kind !== 'repository' || !op.body.integrationBranch) return;
    let commit: string;
    try {
      const landed = await this.workspaces.land(repo.body, op.body.integrationBranch);
      commit = landed.commit;
      await this.record.event(
        'integration',
        { branch: repo.body.spec.defaultBranch, commit, from: op.body.integrationBranch },
        refs,
        HQ_ACTOR,
      );
      await this.hqSitrep(
        null,
        opId,
        landed.before === commit
          ? `${repo.body.spec.defaultBranch} already had everything from Operation ${op.body.name}.`
          : `Operation ${op.body.name} landed on ${repo.body.spec.defaultBranch}: ${repo.body.name} is at ${commit.slice(0, 10)}.`,
      );
    } catch (err) {
      await this.hqSitrep(
        null,
        opId,
        `Could not land Operation ${op.body.name} on ${repo.body.spec.defaultBranch}: ${(err as Error).message} The work stays on ${op.body.integrationBranch}; land it by hand from a task's page.`,
      );
      return;
    }
    const theatre = op.body.theatreId
      ? await this.record.getActive('theatre', op.body.theatreId)
      : null;
    if (theatre?.body.publish !== 'auto') return;
    const site = (await this.resourcesOf(op)).find((s) => SitesService.isSite(s));
    if (!site || !SitesService.isSite(site)) return;
    try {
      const r = await this.sites.publishRef(site, repo.body, commit, refs, HQ_ACTOR);
      await this.hqSitrep(null, opId, `Published to ${site.body.name}: ${r.url}`);
    } catch (err) {
      await this.hqSitrep(
        null,
        opId,
        `Could not publish Operation ${op.body.name} to ${site.body.name}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * An automatic single-file project needs no guard or deploy mission: build and inspect, then
   * HQ lands and publishes. Anything else keeps the full chain.
   */
  private straightPath<T extends { stage: string }>(
    op: RecordVersion<OperationBody>,
    missions: T[],
    resources: RecordVersion<SupplyBody>[],
  ): T[] {
    if (!op.body.autonomous) return missions;
    const repo = resources.find((r) => r.body.spec.kind === 'repository');
    const single =
      repo?.body.spec.kind === 'repository' && repo.body.spec.project?.kind === 'single-html';
    if (!single) return missions;
    const kept = missions.filter((m) => m.stage === 'build' || m.stage === 'inspect');
    return kept.length ? kept : missions.slice(0, 1);
  }

  private async deployed(e: RecordEvent<'deployment'>) {
    await this.record.revise(
      'operation',
      e.operationId!,
      (o) => ({
        ...o,
        deployment: {
          environment: e.body.environment,
          ref: e.body.ref,
          commit: e.body.commit,
          taskId: e.taskId ?? null,
          at: e.createdAt,
          url: e.body.url ?? null,
        },
      }),
      { actor: HQ_ACTOR, reason: `Deployed to ${e.body.environment}` },
    );
    await this.hqSitrep(
      null,
      e.operationId!,
      `Deployed to ${e.body.environment} (${e.body.commit.slice(0, 10)})${e.body.url ? `: ${e.body.url}` : ''}.`,
    );
    await this.renderRecord(e.operationId!);
  }

  // ---------- After Action ----------

  private async afterAction(opId: string): Promise<void> {
    await this.phase(opId, 'after-action', 'Reviewing the operation');
    const op = await this.record.requireActive('operation', opId);
    const units = await this.record.listActive('unit');
    const name = (id: string | null) => units.find((u) => u.entityId === id)?.body.name ?? null;
    const events = await this.record.listEvents({ operationId: opId, limit: 1000 });
    const timeline = events.flatMap((e) => {
      const b = e.body as Record<string, unknown>;
      switch (e.kind) {
        case 'handoff':
          return [
            {
              at: e.createdAt,
              unit: name(b['fromUnitId'] as string),
              kind: 'handoff',
              text: `${name(b['fromUnitId'] as string)} → ${name(b['toUnitId'] as string)}`,
            },
          ];
        case 'sendback':
          return [
            {
              at: e.createdAt,
              unit: name(b['toUnitId'] as string),
              kind: 'sendback',
              text: `Sent back by ${name(b['fromUnitId'] as string)}: ${b['reason'] as string}`,
            },
          ];
        case 'deployment':
          return [
            {
              at: e.createdAt,
              unit: name(e.unitId),
              kind: 'deployment',
              text: `Deployed to ${b['environment'] as string}`,
            },
          ];
        case 'task.status':
          return b['to'] === 'blocked'
            ? [
                {
                  at: e.createdAt,
                  unit: name(e.unitId),
                  kind: 'blocked',
                  text: String(b['reason'] ?? ''),
                },
              ]
            : [];
        case 'sitrep':
          return [
            { at: e.createdAt, unit: name(e.unitId), kind: 'sitrep', text: b['text'] as string },
          ];
        default:
          return [];
      }
    });
    const review = await this.staff.afterAction({
      operation: { name: op.body.name, intent: op.body.intent },
      units: units.map((u) => ({ id: u.entityId, name: u.body.name })),
      timeline,
    });
    const md = [
      `# After Action review — Operation ${op.body.name}`,
      '',
      `> ${op.body.intent}`,
      '',
      review.summary,
      '',
      '## What went well',
      ...(review.wentWell.length ? review.wentWell.map((x) => `- ${x}`) : ['- Nothing noted']),
      '',
      '## What to improve',
      ...(review.toImprove.length ? review.toImprove.map((x) => `- ${x}`) : ['- Nothing noted']),
      '',
      '## Lessons',
      ...(review.lessons.length
        ? review.lessons.map((l) => `- ${l.unitId ? name(l.unitId) : 'All units'}: ${l.text}`)
        : ['- None']),
      '',
    ].join('\n');
    await this.record.transaction(async (w) => {
      const doc = await w.create(
        'document',
        {
          kind: 'after-action',
          unitId: null,
          title: `After Action review — Operation ${op.body.name}`,
          markdown: md,
          taskId: null,
          botId: null,
          operationId: opId,
        },
        { actor: HQ_ACTOR, reason: 'After Action review' },
      );
      await w.revise('operation', opId, (o) => ({ ...o, afterActionDocumentId: doc.entityId }), {
        actor: HQ_ACTOR,
        reason: 'After Action review written',
      });
      await w.event(
        'after-action',
        { documentId: doc.entityId, lessons: review.lessons },
        { operationId: opId },
        HQ_ACTOR,
      );
      await this.hqSitrep(
        w,
        opId,
        `After Action review written; ${review.lessons.length} lesson(s) recorded. A lesson becomes an order only when you give it: on the unit's Rules tab, or in chat.`,
      );
    });
    await this.phase(opId, 'closed', 'After Action review complete');
    await this.renderRecord(opId);
  }

  // ---------- Helpers ----------

  private async phase(opId: string, to: OperationPhase, reason: string): Promise<void> {
    const op = await this.record.requireActive('operation', opId);
    const from = op.body.phase;
    if (from === to || !canTransition(from, to)) return;
    await this.record.transaction(async (w) => {
      await w.revise('operation', opId, (o) => ({ ...o, phase: to }), { actor: HQ_ACTOR, reason });
      await w.event('operation.phase', { from, to, reason }, { operationId: opId }, HQ_ACTOR);
    });
  }

  private hqSitrep(w: RecordWriter | null, opId: string, text: string) {
    const write = (x: RecordWriter) =>
      x.event('sitrep', { level: 'hq', text, status: null }, { operationId: opId }, HQ_ACTOR);
    return w ? write(w) : this.record.transaction(write);
  }

  private async firstRepository(ids: string[]) {
    for (const id of ids) {
      const s = await this.record.getActive('supply', id);
      if (s?.body.connected && s.body.spec.kind === 'repository') return s;
    }
    return null;
  }

  /** The shared cross-unit record: what every unit needs to know about the operation. */
  async renderRecord(opId: string): Promise<void> {
    const op = await this.record.requireActive('operation', opId);
    if (!op.body.recordDocumentId) return;
    const units = await this.record.listActive('unit');
    const name = (id: string | null) => units.find((u) => u.entityId === id)?.body.name ?? 'HQ';
    const missions = (
      await Promise.all(op.body.missionIds.map((id) => this.record.getActive('mission', id)))
    ).filter((m) => !!m);
    const events = await this.record.listEvents({
      operationId: opId,
      kinds: ['operation.phase', 'handoff', 'sendback', 'deployment', 'sitrep', 'integration'],
      limit: 1000,
    });
    const lines = events.map((e) => {
      const b = e.body as Record<string, string>;
      const when = e.createdAt.slice(0, 19).replace('T', ' ');
      switch (e.kind) {
        case 'operation.phase':
          return `- ${when} — Phase: ${b['from']} → ${b['to']} (${b['reason']})`;
        case 'handoff':
          return `- ${when} — Handoff ${name(b['fromUnitId']!)} → ${name(b['toUnitId']!)} at \`${(b['commit'] ?? '').slice(0, 10)}\``;
        case 'sendback':
          return `- ${when} — Sent back by ${name(b['fromUnitId']!)} to ${name(b['toUnitId']!)}: ${b['reason']}`;
        case 'integration':
          return `- ${when} — Integrated \`${b['from']}\` into \`${b['branch']}\``;
        case 'deployment':
          return `- ${when} — Deployed to ${b['environment']} (\`${(b['commit'] ?? '').slice(0, 10)}\`)`;
        default:
          return `- ${when} — ${name(e.unitId)}: ${b['text']}`;
      }
    });
    const markdown = [
      `# Operation ${op.body.name} — shared record`,
      '',
      `> ${op.body.intent}`,
      '',
      `**Phase:** ${op.body.phase}${op.body.integrationBranch ? ` · **Branch:** \`${op.body.integrationBranch}\`` : ''}`,
      '',
      '## Missions (handoff order)',
      ...missions.map(
        (m, i) =>
          `${i + 1}. ${name(m.body.unitId)} (${m.body.stage ?? 'mission'}): ${m.body.goal} — **${m.body.status}**`,
      ),
      '',
      '## Log',
      ...(lines.length ? lines : ['- Nothing yet']),
      '',
    ].join('\n');
    await this.record.revise('document', op.body.recordDocumentId, (d) => ({ ...d, markdown }), {
      actor: HQ_ACTOR,
      reason: 'Shared record updated',
    });
  }
}

/** The plan to issue an operation's missions again from: its own, or (planned before plans were kept) its missions. */
function planOf(
  op: RecordVersion<OperationBody>,
  missions: RecordVersion<MissionBody>[],
): OperationBody['plan'] {
  return (
    op.body.plan ??
    (missions.every((m) => m.body.stage)
      ? missions.map((m) => ({
          unitId: m.body.unitId,
          stage: m.body.stage!,
          goal: m.body.goal,
          definitionOfDone: m.body.definitionOfDone,
        }))
      : null)
  );
}
