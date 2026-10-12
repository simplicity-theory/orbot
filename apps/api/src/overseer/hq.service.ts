import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';
import {
  canTransition,
  type BotRuntime,
  type OperationBody,
  type OperationPhase,
  type RecordEvent,
  type RecordVersion,
  type TaskBody,
} from '@orbot/shared';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { Background } from '../common/background.js';
import { RecordBus } from '../record/record-bus.js';
import { RecordService, type RecordWriter } from '../record/record.service.js';
import { RuntimeRegistry } from '../runtime/runtime.registry.js';
import { WorkspaceManager } from '../runtime/workspace-manager.js';
import { SupplyService } from '../supply/supply.service.js';
import { OverseerService } from './overseer.service.js';

export const HQ_ACTOR = 'system:hq';

/**
 * HQ, the planning layer. Turns the Commander's intent into an operation, splits it into
 * one mission per unit in handoff order (Engineers → Inspection → Guard → Logistics),
 * passes work down the chain, sends failed checks back up it, and closes the operation
 * with an After Action review whose lessons become standing orders.
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
    private readonly supply: SupplyService,
    private readonly overseer: OverseerService,
  ) {}

  /** HQ's staff thinks through the default runtime (HQ has no unit of its own). */
  private get staff(): BotRuntime {
    return this.runtimes.get(this.config.defaultRuntime);
  }

  onApplicationBootstrap(): void {
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
        if (!e.operationId) return;
        if (e.kind === 'task.status') {
          const s = (e as RecordEvent<'task.status'>).body;
          if (s.to === 'done' || (s.to === 'stood-down' && s.reason?.startsWith('Sent back:'))) {
            this.enqueue(e.operationId, 'task', () => this.taskChanged(e.taskId!, s.to, s.reason));
          }
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
  ): Promise<RecordVersion<OperationBody>> {
    const opName = name ?? intent.split(/\s+/).slice(0, 3).join(' ');
    const op = await this.record.transaction(async (w) => {
      const created = await w.create(
        'operation',
        { name: opName, intent, phase: 'intent', supplyIds: [], budgetUnits },
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
        `Intent received for Operation ${opName}: “${intent}”. Convening the O Group.`,
      );
      return created;
    });
    this.enqueue(op.entityId, 'o-group', () => this.oGroup(op.entityId));
    return op;
  }

  /** O Group: plan the missions, issue them to the units, open the integration branch. */
  private async oGroup(opId: string): Promise<void> {
    const op = await this.record.requireActive('operation', opId);
    await this.phase(opId, 'o-group', 'Planning missions');
    const units = (await this.record.listActive('unit')).filter((u) => u.body.overseerBotId);
    const plan = await this.staff.planOperation({
      name: op.body.name,
      intent: op.body.intent,
      units: units.map((u) => ({
        id: u.entityId,
        name: u.body.name,
        role: u.body.role,
        standingMission: u.body.standingMission,
      })),
    });
    if (!plan.missions.length) {
      await this.hqSitrep(
        null,
        opId,
        'No unit can take this on: HQ found no matching units. Operation stays at O Group.',
      );
      return;
    }

    // Work lands in the building unit's repository, on one integration branch for the operation.
    const builder = units.find((u) => u.entityId === plan.missions[0]!.unitId)!;
    const repo = await this.firstRepository(builder.body.supplyIds);
    let integrationBranch: string | null = null;
    if (repo) {
      integrationBranch = `orbot/op-${opId.slice(0, 8)}`;
      await this.workspaces.createBranch(repo.body, integrationBranch);
      // Every unit in the chain needs the repository to work on the branch.
      for (const m of plan.missions) {
        const u = units.find((x) => x.entityId === m.unitId)!;
        if (!u.body.supplyIds.includes(repo.entityId)) {
          await this.supply.allotToUnit(repo.entityId, u.entityId, {
            actor: HQ_ACTOR,
            reason: `Issued for Operation ${op.body.name}`,
          });
        }
      }
    }

    await this.record.transaction(async (w) => {
      const ids: string[] = [];
      let upstream: string | null = null;
      for (const m of plan.missions) {
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
          supplyIds: repo ? [repo.entityId] : [],
        }),
        { actor: HQ_ACTOR, reason: 'Missions issued at the O Group' },
      );
      const chain = plan.missions
        .map((m) => units.find((u) => u.entityId === m.unitId)!.body.name)
        .join(' → ');
      await this.hqSitrep(
        w,
        opId,
        `O Group done: ${plan.missions.length} missions issued (${chain}). Waiting for each unit's backbrief.`,
      );
    });
    await this.phase(opId, 'backbrief', 'Missions issued; units are briefing back');
    await this.renderRecord(opId);
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
    const repo = await this.record.requireActive('supply', op.body.repoSupplyId);
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
          repoSupplyId: op.body.repoSupplyId,
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
      await this.hqSitrep(
        null,
        op.entityId,
        `All missions complete${op.body.deployment ? `; deployed to ${op.body.deployment.environment} at ${op.body.deployment.commit.slice(0, 10)}` : ''}. Holding the After Action review.`,
      );
      await this.afterAction(op.entityId);
    }
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
          taskId: e.taskId!,
          at: e.createdAt,
        },
      }),
      { actor: HQ_ACTOR, reason: `Deployed to ${e.body.environment}` },
    );
    await this.hqSitrep(
      null,
      e.operationId!,
      `Deployed to ${e.body.environment} (${e.body.commit.slice(0, 10)}).`,
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
      '## Lessons kept as standing orders',
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
      const reason = `After Action review — Operation ${op.body.name}`;
      for (const lesson of review.lessons) {
        const targets = lesson.unitId ? units.filter((u) => u.entityId === lesson.unitId) : units;
        for (const u of targets) {
          const current = await w.getActive('unit', u.entityId);
          if (!current || current.body.standingOrders.some((o) => o.text === lesson.text)) continue;
          await w.revise(
            'unit',
            u.entityId,
            (b) => ({
              ...b,
              standingOrders: [
                ...b.standingOrders,
                {
                  id: `aar-${doc.entityId.slice(0, 8)}-${b.standingOrders.length}`,
                  text: lesson.text,
                },
              ],
            }),
            { actor: HQ_ACTOR, reason },
          );
        }
      }
      await w.event(
        'after-action',
        { documentId: doc.entityId, lessons: review.lessons },
        { operationId: opId },
        HQ_ACTOR,
      );
      await this.hqSitrep(
        w,
        opId,
        `After Action review written; ${review.lessons.length} lesson(s) kept as standing orders.`,
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
