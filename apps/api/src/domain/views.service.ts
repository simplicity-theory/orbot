import { Inject, Injectable } from '@nestjs/common';
import {
  budgetView,
  describeNeeds,
  missingNeeds,
  needStatus,
  SETTINGS_ID,
  STAGE_ORDER,
  type BudgetView,
  type TheatreSummary,
  type TheatreDetailView,
  type TheatreBody,
  type SupplyBody,
} from '@orbot/shared';
import type {
  ApprovalsView,
  AttentionItem,
  BackbriefBody,
  BackbriefView,
  BotBody,
  BotDetailView,
  BotStatus,
  BotView,
  MissionBody,
  MissionProgress,
  MissionView,
  OperationBody,
  OperationDetailView,
  OperationResourcesView,
  OperationSummary,
  OrbatUnit,
  OrbatView,
  PaletteItem,
  RecordEvent,
  DisputeBody,
  RecordVersion,
  Status,
  TaskDetailView,
  TaskView,
  UnitBody,
  UnitDetailView,
} from '@orbot/shared';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { mainEffortFirst, mainEffortMissionIds } from '../overseer/main-effort.js';
import { FieldManualService } from '../documents/field-manual.service.js';
import { UnitDocsService } from '../documents/unit-docs.service.js';
import { SandTableService } from '../overseer/sand-table.service.js';
import { DeconflictionService } from '../overseer/deconfliction.service.js';
import { EscalationService } from '../overseer/escalation.service.js';
import { RecordService } from '../record/record.service.js';
import { toView, toViews } from './view.js';

const unitLink = (unitId: string) => `/units/${unitId}`;
const botLink = (unitId: string, botId: string) => `/units/${unitId}/bots/${botId}`;
const taskLink = (unitId: string, botId: string | null, taskId: string) =>
  botId ? `${botLink(unitId, botId)}/tasks/${taskId}` : `${unitLink(unitId)}/tasks/${taskId}`;

/** Read models for the screens. Built from the active tier of the record. */
@Injectable()
export class ViewsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly record: RecordService,
    private readonly fieldManual: FieldManualService,
    private readonly docs: UnitDocsService,
    private readonly escalations: EscalationService,
    private readonly deconfliction: DeconflictionService,
    private readonly sandTables: SandTableService,
  ) {}

  async orbat(): Promise<OrbatView> {
    const [units, bots, tasks, missions, backbriefs, operations] = await Promise.all([
      this.record.listActive('unit'),
      this.record.listActive('bot'),
      this.record.listActive('task'),
      this.record.listActive('mission'),
      this.record.listActive('backbrief', { bodyContains: { status: 'awaiting-approval' } }),
      this.record.listActive('operation'),
    ]);
    const opNames = new Map(operations.map((o) => [o.entityId, o.body.name]));
    const bbViews = backbriefViews(backbriefs, missions, units, bots);
    const settings = (await this.record.getActive('settings', SETTINGS_ID))?.body;
    const allHalted = !!settings?.halt;
    const warnAt = settings?.budgetWarnAt ?? 0.8;
    const enforced = settings?.computeLimits === 'on';
    const spentBy = await this.record.costBy('unit');
    const open = await this.escalations.openChains();
    const referred = await this.record.listActive('dispute', {
      bodyContains: { status: 'referred' },
    });
    const out: OrbatUnit[] = units
      .sort((a, b) => a.body.order - b.body.order)
      .map((u) => {
        const budget = unitBudget(
          u.body.computeBudget,
          spentBy.get(u.entityId) ?? 0,
          warnAt,
          enforced,
        );
        const ub = bots.filter((b) => b.body.unitId === u.entityId).map(toView);
        const ut = tasks.filter((t) => t.body.unitId === u.entityId).map(toView);
        const um = missions.filter((m) => m.body.unitId === u.entityId).map(toView);
        const ubb = bbViews.filter((b) => b.unitId === u.entityId);
        const botsByStatus: Partial<Record<BotStatus, number>> = {};
        for (const b of ub.filter((b) => !b.isOverseer && b.status !== 'stood-down')) {
          botsByStatus[b.status] = (botsByStatus[b.status] ?? 0) + 1;
        }
        return {
          unit: toView(u),
          overseer: ub.find((b) => b.id === u.body.overseerBotId) ?? null,
          budget,
          botCount: ub.filter((b) => !b.isOverseer && b.status !== 'stood-down').length,
          botsByStatus,
          currentMission: um.find((m) => m.status !== 'done') ?? null,
          status: unitStatus(ub, ut, ubb, allHalted || !!u.body.halt),
          attention: unitAttention(
            u,
            attentionFor(u.entityId, ub, ut, ubb, {
              unitName: u.body.name,
              missions: um.map((m) => ({ id: m.id, operationId: m.operationId })),
              operations: opNames,
            }),
            open.filter((e) => e.unitId === u.entityId),
            budget,
            referred.filter((d) => d.body.unitId === u.entityId),
            units,
          ),
          backbriefs: ubb,
          bots: ub
            .filter((b) => !b.isOverseer)
            .sort(byCallsign)
            .map((b) => ({ ...b, currentTask: ut.find((t) => t.id === b.currentTaskId) ?? null })),
        };
      });
    return {
      productName: this.config.productName,
      units: out,
      needsYou: out.reduce((n, u) => n + u.attention.length, 0),
    };
  }

  /** The single inbox: backbriefs to decide, plus everything else waiting on the Commander. */
  async approvals(): Promise<ApprovalsView> {
    const orbat = await this.orbat();
    // HQ's own: operations held at the O Group for want of resources.
    const waiting: ApprovalsView['attention'] = [];
    for (const op of await this.record.listActive('operation')) {
      if (op.body.missionIds.length || !['intent', 'o-group'].includes(op.body.phase)) continue;
      const r = await this.operationResources(op);
      if (!r.blocked) continue;
      waiting.push({
        kind: 'resources',
        label: `Operation ${op.body.name} is waiting for resources: ${describeNeeds(r.missing)}`,
        title: `Resources · Operation ${op.body.name}`,
        detail: `Assign what it waits for: ${brief(describeNeeds(r.missing))}`,
        link: `/operations/${op.entityId}#resources`,
        entityId: op.entityId,
        unitName: 'HQ',
        unitId: null,
      });
    }
    return {
      backbriefs: orbat.units.flatMap((u) => u.backbriefs),
      attention: [
        ...waiting,
        ...orbat.units.flatMap((u) =>
          u.attention.map((a) => ({ ...a, unitName: u.unit.name, unitId: u.unit.id })),
        ),
      ],
    };
  }

  async unit(id: string): Promise<UnitDetailView> {
    const u = await this.record.requireActive('unit', id);
    const [
      bots,
      tasks,
      missions,
      documents,
      supply,
      backbriefs,
      entries,
      retired,
      warDiary,
      coldStart,
      docsMirror,
    ] = await Promise.all([
      this.record.listActive('bot', { unitId: id }),
      this.record.listActive('task', { unitId: id }),
      this.record.listActive('mission', { unitId: id }),
      this.record.listActive('document', { unitId: id }),
      this.record.listActive('supply'),
      this.record.listActive('backbrief', { unitId: id }),
      this.fieldManual.entries(id),
      this.fieldManual.entries(id, { retired: true }),
      this.record.listEvents({ unitId: id, kinds: ['diary.entry'], limit: 500 }, { latest: true }),
      this.record.listEvents(
        { unitId: id, kinds: ['coldstart.check'], limit: 1 },
        { latest: true },
      ),
      this.docs.describe(id),
    ]);
    const bv = toViews(bots).sort(byCallsign);
    const tv = toViews(tasks).sort((a, b) => b.number - a.number);
    const bbViews = backbriefViews(backbriefs, missions, [u], bots);
    const awaiting = bbViews.filter((b) => b.status === 'awaiting-approval');
    const progress: MissionProgress[] = toViews(missions)
      .map((m) => {
        const mt = tv.filter((t) => t.missionId === m.id);
        return {
          mission: m,
          done: mt.filter((t) => t.status === 'done').length,
          total: mt.length,
          backbrief: bbViews.find((b) => b.missionId === m.id) ?? null,
        };
      })
      .sort((a, b) => Number(a.mission.status === 'done') - Number(b.mission.status === 'done'));
    // In dispatch order: each bot's queue, the main effort's tasks first.
    const mainEffort = await mainEffortMissionIds(this.record);
    const queue = bv
      .filter((b) => !b.isOverseer)
      .flatMap((b) =>
        mainEffortFirst(
          b.queue.map((q) => tv.find((t) => t.id === q)).filter((t): t is TaskView => !!t),
          mainEffort,
        ),
      );
    const settings = (await this.record.getActive('settings', SETTINGS_ID))?.body;
    return {
      unit: toView(u),
      budget: unitBudget(
        u.body.computeBudget,
        await this.record.costOf({ unitId: id }),
        settings?.budgetWarnAt ?? 0.8,
        settings?.computeLimits === 'on',
      ),
      status: unitStatus(bv, tv, awaiting, !!u.body.halt || !!settings?.halt),
      overseer: bv.find((b) => b.id === u.body.overseerBotId) ?? null,
      bots: bv.map((b) => ({
        ...b,
        currentTask: tv.find((t) => t.id === b.currentTaskId) ?? null,
      })),
      missions: progress,
      tasks: tv,
      queue,
      documents: toViews(documents.filter((d) => d.body.kind !== 'handover')),
      handovers: toViews(documents.filter((d) => d.body.kind === 'handover')).sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      ),
      fieldManual: toViews(entries),
      retiredEntries: toViews(retired),
      warDiary: [...warDiary].reverse(),
      supply: toViews(supply.filter((s) => u.body.supplyIds.includes(s.entityId))),
      attention: unitAttention(
        u,
        attentionFor(id, bv, tv, awaiting, {
          unitName: u.body.name,
          missions: missions.map((m) => ({ id: m.entityId, operationId: m.body.operationId })),
          operations: new Map(
            (await this.record.listActive('operation')).map((o) => [o.entityId, o.body.name]),
          ),
        }),
        await this.escalations.openChains({ unitId: id }),
        unitBudget(
          u.body.computeBudget,
          await this.record.costOf({ unitId: id }),
          settings?.budgetWarnAt ?? 0.8,
          settings?.computeLimits === 'on',
        ),
        await this.record.listActive('dispute', {
          bodyContains: { status: 'referred', unitId: id },
        }),
        await this.record.listActive('unit'),
      ),
      backbriefs: awaiting,
      coldStart: (coldStart[0] as RecordEvent<'coldstart.check'> | undefined) ?? null,
      docsMirror,
    };
  }

  async bot(id: string): Promise<BotDetailView> {
    const b = await this.record.requireActive('bot', id);
    const [unit, tasks, recent, briefs, peers] = await Promise.all([
      this.record.requireActive('unit', b.body.unitId),
      this.record.listActive('task', { bodyContains: { botId: id } }),
      this.record.listEvents({ botId: id, limit: 50 }, { latest: true }),
      this.record.listEvents({ botId: id, kinds: ['task.briefed'], limit: 1 }, { latest: true }),
      this.record.listActive('bot', { unitId: b.body.unitId }),
    ]);
    const tv = toViews(tasks);
    return {
      bot: toView(b),
      unit: toView(unit),
      currentTask: tv.find((t) => t.id === b.body.currentTaskId) ?? null,
      queue: mainEffortFirst(
        b.body.queue.map((q) => tv.find((t) => t.id === q)).filter((t): t is TaskView => !!t),
        await mainEffortMissionIds(this.record),
      ),
      history: tv
        .filter((t) => t.id !== b.body.currentTaskId && !b.body.queue.includes(t.id))
        .sort((x, y) => y.number - x.number),
      recent: [...recent].reverse(),
      lastBrief: (briefs[0] as RecordEvent<'task.briefed'> | undefined) ?? null,
      peers: toViews(peers)
        .filter((p) => p.id !== id && !p.isOverseer && p.status !== 'stood-down')
        .sort(byCallsign),
    };
  }

  async task(id: string): Promise<TaskDetailView> {
    const t = await this.record.requireActive('task', id);
    const [unit, bot, mission, events, versions, handovers, reports] = await Promise.all([
      this.record.requireActive('unit', t.body.unitId),
      t.body.botId ? this.record.getActive('bot', t.body.botId) : null,
      t.body.missionId ? this.record.getActive('mission', t.body.missionId) : null,
      this.record.listEvents({ taskId: id, limit: 1000 }),
      this.record.history(id),
      this.record.listActive('document', { bodyContains: { kind: 'handover', taskId: id } }),
      this.record.listActive('document', { bodyContains: { kind: 'recon', taskId: id } }),
    ]);
    const operation = mission?.body.operationId
      ? await this.record.getActive('operation', mission.body.operationId)
      : null;
    const missionTasks = mission
      ? toViews(
          await this.record.listActive('task', { bodyContains: { missionId: mission.entityId } }),
        ).sort((a, b) => a.number - b.number)
      : [];
    return {
      task: toView(t),
      unit: toView(unit),
      bot: bot ? toView(bot) : null,
      mission: mission ? toView(mission) : null,
      operation: operation ? toView(operation) : null,
      theatre: await (async () => {
        const th = operation?.body.theatreId
          ? await this.record.getActive('theatre', operation.body.theatreId)
          : null;
        return th ? { id: th.entityId, name: th.body.name } : null;
      })(),
      missionTasks,
      events,
      versions,
      handover: handovers[0] ? toView(handovers[0]) : null,
      report: reports[0] ? toView(reports[0]) : null,
      overlaps: await this.deconfliction.overlapsFor(id),
    };
  }

  async backbrief(id: string): Promise<BackbriefView> {
    const bb = await this.record.requireActive('backbrief', id);
    const [missions, units, bots] = await Promise.all([
      this.record.listActive('mission', { unitId: bb.body.unitId }),
      this.record.listActive('unit'),
      this.record.listActive('bot', { unitId: bb.body.unitId }),
    ]);
    return backbriefViews([bb], missions, units, bots)[0]!;
  }

  async theatres(): Promise<TheatreSummary[]> {
    const [theatres, ops] = await Promise.all([
      this.record.listActive('theatre'),
      this.operations(),
    ]);
    return Promise.all(
      theatres
        .sort((a, b) => Number(a.body.status === 'closed') - Number(b.body.status === 'closed'))
        .map(async (t) => {
          const mine = ops.filter((o) => o.operation.theatreId === t.entityId);
          return {
            ...(await this.theatreBase(t)),
            operations: mine.map((o) => ({
              id: o.operation.id,
              name: o.operation.name,
              phase: o.operation.phase,
              needsYou: o.needsYou.length,
            })),
            needsYou: mine.reduce((n, o) => n + o.needsYou.length, 0),
          };
        }),
    );
  }

  async theatre(id: string): Promise<TheatreDetailView> {
    const t = await this.record.requireActive('theatre', id);
    const ops = (await this.operations()).filter((o) => o.operation.theatreId === id);
    return {
      ...(await this.theatreBase(t)),
      operations: ops,
      needsYou: ops.reduce((n, o) => n + o.needsYou.length, 0),
    };
  }

  private async theatreBase(t: RecordVersion<TheatreBody>) {
    const resources: RecordVersion<SupplyBody>[] = [];
    for (const sid of t.body.supplyIds) {
      const s = await this.record.getActive('supply', sid);
      if (s) resources.push(s);
    }
    const repo = resources.find((s) => s.entityId === t.body.repoSupplyId) ?? null;
    const site =
      resources.find((s) => s.body.spec.kind === 'environment' && s.body.spec.site) ?? null;
    return {
      theatre: toView(t),
      repository: repo ? toView(repo) : null,
      site: site
        ? { id: site.entityId, name: site.body.name, url: `/api/sites/${site.entityId}/` }
        : null,
      resources: toViews(resources),
    };
  }

  async operations(): Promise<OperationSummary[]> {
    const ops = await this.record.listActive('operation');
    return Promise.all(
      ops
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((o) => this.operationSummary(o.entityId)),
    );
  }

  async operationSummary(id: string): Promise<OperationSummary> {
    const op = await this.record.requireActive('operation', id);
    const [units, bots, missions, tasks, backbriefs] = await Promise.all([
      this.record.listActive('unit'),
      this.record.listActive('bot'),
      this.record.listActive('mission', { bodyContains: { operationId: id } }),
      this.record.listActive('task'),
      this.record.listActive('backbrief'),
    ]);
    const stageRank = (m: (typeof missions)[number]) =>
      m.body.stage ? STAGE_ORDER.indexOf(m.body.stage) : 99;
    const order = op.body.missionIds.length
      ? op.body.missionIds
      : [...missions].sort((a, b) => stageRank(a) - stageRank(b)).map((m) => m.entityId);
    const bbViews = backbriefViews(
      backbriefs.filter((b) => order.includes(b.body.missionId)),
      missions,
      units,
      bots,
    );
    const rows = order.flatMap((mid) => {
      const m = missions.find((x) => x.entityId === mid);
      const u = m && units.find((x) => x.entityId === m.body.unitId);
      if (!m || !u) return [];
      const mt = toViews(tasks.filter((t) => t.body.missionId === mid));
      return [
        {
          mission: toView(m),
          unit: toView(u),
          done: mt.filter((t) => t.status === 'done').length,
          total: mt.length,
          tasks: mt,
          backbrief: bbViews.find((b) => b.missionId === mid) ?? null,
        },
      ];
    });
    const needsYou = rows.flatMap((r) => [
      ...(r.backbrief?.status === 'awaiting-approval'
        ? [
            {
              kind: 'awaiting-approval' as const,
              label: `${r.unit.name} backbrief awaiting approval`,
              title: `Backbrief · Operation ${op.body.name}`,
              detail: `Approve the plan: ${brief(r.mission.goal)}`,
              link: `/operations/${id}`,
              entityId: r.backbrief.id,
            },
          ]
        : []),
      ...attentionFor(
        r.unit.id,
        toViews(bots.filter((b) => b.body.unitId === r.unit.id)),
        r.tasks,
        [],
        {
          unitName: r.unit.name,
          missions: [{ id: r.mission.id, operationId: op.entityId }],
          operations: new Map([[op.entityId, op.body.name]]),
        },
      ),
    ]);
    const st = (await this.record.getActive('settings', SETTINGS_ID))?.body;
    const budget = budgetView(
      op.body.budgetUnits,
      await this.record.costOf({ operationId: id }),
      st?.budgetWarnAt ?? 0.8,
      st?.computeLimits === 'on',
    );
    needsYou.push(...budgetAttention(`Operation ${op.body.name}`, `/operations/${id}`, id, budget));
    // A rehearsal that found blockers, while the plan can still be put right.
    const sand = await this.sandTables.latest(id);
    if (sand?.body.verdict === 'no-go' && !['after-action', 'closed'].includes(op.body.phase)) {
      const n = sand.body.findings.filter((f) => f.severity === 'blocker').length;
      needsYou.push({
        kind: 'sand-table',
        label: `Sand table: no-go for Operation ${op.body.name} (${n} blocker${n === 1 ? '' : 's'})`,
        title: `Sand table · Operation ${op.body.name}`,
        detail: `No-go: ${n} blocker${n === 1 ? '' : 's'} to clear before the work starts`,
        link: `/operations/${id}#sand-table`,
        entityId: id,
      });
    }
    const resources = await this.operationResources(op);
    if (resources.blocked) {
      needsYou.unshift({
        kind: 'resources',
        label: `Operation ${op.body.name} is waiting for resources: ${describeNeeds(resources.missing)}`,
        title: `Resources · Operation ${op.body.name}`,
        detail: `Assign what it waits for: ${brief(describeNeeds(resources.missing))}`,
        link: `/operations/${id}#resources`,
        entityId: id,
      });
    }
    const theatre = op.body.theatreId
      ? await this.record.getActive('theatre', op.body.theatreId)
      : null;
    return {
      operation: toView(op),
      theatre: theatre ? { id: theatre.entityId, name: theatre.body.name } : null,
      budget,
      missions: rows,
      needsYou,
      resources,
    };
  }

  /** What an operation needs, what is assigned, what is missing, and whether it is held up. */
  private async operationResources(
    op: RecordVersion<OperationBody>,
  ): Promise<OperationResourcesView> {
    const assigned = [];
    for (const sid of op.body.supplyIds) {
      const s = await this.record.getActive('supply', sid);
      if (s) assigned.push(s);
    }
    const pairs = assigned.map((s) => ({ id: s.entityId, body: s.body }));
    const missing = missingNeeds(op.body.needs, pairs);
    return {
      needs: needStatus(op.body.needs, pairs),
      assigned: toViews(assigned),
      mainRepositoryId:
        op.body.repoSupplyId ??
        assigned.find((s) => s.body.spec.kind === 'repository' && s.body.connected)?.entityId ??
        null,
      missing,
      blocked:
        missing.length > 0 &&
        !op.body.missionIds.length &&
        (op.body.phase === 'intent' || op.body.phase === 'o-group'),
    };
  }

  async operation(id: string): Promise<OperationDetailView> {
    const summary = await this.operationSummary(id);
    const op = summary.operation;
    const [timeline, record, aar] = await Promise.all([
      this.record.listEvents({
        operationId: id,
        kinds: [
          'operation.phase',
          'handoff',
          'sendback',
          'integration',
          'deployment',
          'sitrep',
          'deploy.approval',
          'after-action',
        ],
        limit: 1000,
      }),
      op.recordDocumentId ? this.record.getActive('document', op.recordDocumentId) : null,
      op.afterActionDocumentId ? this.record.getActive('document', op.afterActionDocumentId) : null,
    ]);
    return {
      ...summary,
      timeline,
      record: record ? toView(record) : null,
      afterAction: aar ? toView(aar) : null,
      sandTable: await this.sandTables.latest(id),
    };
  }

  /** Everything the command palette can jump to. */
  async palette(): Promise<PaletteItem[]> {
    const [units, bots, tasks, ops, docs, missions] = await Promise.all([
      this.record.listActive('unit'),
      this.record.listActive('bot'),
      this.record.listActive('task'),
      this.record.listActive('operation'),
      this.record.listActive('document'),
      this.record.listActive('mission'),
    ]);
    const unitName = new Map(units.map((u) => [u.entityId, u.body.name]));
    const items: PaletteItem[] = [
      ...units.map((u) => ({
        kind: 'unit' as const,
        id: u.entityId,
        label: u.body.name,
        sublabel: `Unit · ${u.body.role}`,
        link: unitLink(u.entityId),
      })),
      ...bots.map((b) => ({
        kind: 'bot' as const,
        id: b.entityId,
        label: `Bot ${b.body.callsign}`,
        sublabel: `${unitName.get(b.body.unitId) ?? ''} · ${b.body.role}`,
        link: botLink(b.body.unitId, b.entityId),
      })),
      ...tasks
        .sort((a, b) => b.body.number - a.body.number)
        .map((t) => ({
          kind: 'task' as const,
          id: t.entityId,
          label: `Task #${t.body.number}: ${t.body.title}`,
          sublabel: `${unitName.get(t.body.unitId) ?? ''} · ${t.body.status}`,
          link: taskLink(t.body.unitId, t.body.botId, t.entityId),
        })),
      ...missions.map((m) => ({
        kind: 'mission' as const,
        id: m.entityId,
        label: m.body.goal,
        sublabel: `Mission · ${unitName.get(m.body.unitId) ?? ''}`,
        link: unitLink(m.body.unitId),
      })),
      ...ops.map((o) => ({
        kind: 'operation' as const,
        id: o.entityId,
        label: `Operation ${o.body.name}`,
        sublabel: `Operation · ${o.body.phase}`,
        link: `/operations/${o.entityId}`,
      })),
      ...docs.map((d) => ({
        kind: 'document' as const,
        id: d.entityId,
        label: d.body.title,
        sublabel: `Document · ${d.body.unitId ? (unitName.get(d.body.unitId) ?? '') : 'HQ'}`,
        link: d.body.unitId
          ? `/units/${d.body.unitId}/documents/${d.entityId}`
          : `/archive/${d.entityId}`,
      })),
    ];
    return items;
  }
}

function backbriefViews(
  backbriefs: RecordVersion<BackbriefBody>[],
  missions: RecordVersion<MissionBody>[],
  units: RecordVersion<UnitBody>[],
  bots: RecordVersion<BotBody>[],
): BackbriefView[] {
  const callsigns = Object.fromEntries(bots.map((b) => [b.entityId, b.body.callsign]));
  return backbriefs.flatMap((bb) => {
    const m = missions.find((x) => x.entityId === bb.body.missionId);
    if (!m) return [];
    return [
      {
        ...toView(bb),
        mission: toView(m) as MissionView,
        unitName: units.find((u) => u.entityId === bb.body.unitId)?.body.name ?? '',
        callsigns,
      },
    ];
  });
}

function byCallsign(a: BotView, b: BotView) {
  if (a.isOverseer !== b.isOverseer) return a.isOverseer ? -1 : 1;
  return a.callsign.localeCompare(b.callsign, undefined, { numeric: true });
}

/** A unit's budget: `computeBudget` 0 means no cap has been set. */
function unitBudget(
  computeBudget: number,
  spent: number,
  warnAt: number,
  enforced: boolean,
): BudgetView {
  return budgetView(computeBudget > 0 ? computeBudget : null, spent, warnAt, enforced);
}

/** A reason cut to its first sentence (or `max` characters): the decision in one line. */
export function brief(text: string | null | undefined, max = 160): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = /^(.{12,}?[.!?])(?:\s|$)/.exec(t);
  const first = m ? m[1]! : t;
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

const KIND_WORD: Record<string, string> = {
  work: 'Task',
  fix: 'Fix',
  check: 'Check',
  deploy: 'Deploy',
  recon: 'Recon',
};

/** Where an attention item points: mission goal and operation name, from what the caller has. */
export interface AttentionContext {
  unitName: string;
  missions: { id: string; operationId: string | null }[];
  /** Operation id → name. */
  operations: Map<string, string>;
}

/** "Deploy #111 · Operation Main List" (the unit is shown beside the item, never in it). */
function taskHeading(t: TaskView, ctx: AttentionContext): string {
  const m = t.missionId ? ctx.missions.find((x) => x.id === t.missionId) : null;
  const op = m?.operationId ? ctx.operations.get(m.operationId) : null;
  return `${KIND_WORD[t.kind] ?? 'Task'} #${t.number}${op ? ` · Operation ${op}` : ''}`;
}

function budgetAttention(
  label: string,
  link: string,
  entityId: string,
  b: BudgetView,
): AttentionItem[] {
  if (b.state !== 'warning' && b.state !== 'capped') return [];
  const detail =
    b.state === 'capped'
      ? `${label} is at its compute budget cap (${b.spent} of ${b.cap} units): work is held`
      : `${label} has used ${b.spent} of ${b.cap} compute units`;
  return [
    {
      kind: 'budget',
      label: detail,
      title: 'Compute budget',
      detail,
      link,
      entityId,
    },
  ];
}

function unitStatus(
  bots: BotView[],
  tasks: TaskView[],
  awaiting: BackbriefView[],
  halted: boolean,
): Status {
  const active = bots.filter((b) => b.status !== 'stood-down');
  if (tasks.some((t) => t.status === 'failed') || active.some((b) => b.status === 'failed'))
    return 'failed';
  if (active.some((b) => b.status === 'blocked') || tasks.some((t) => t.status === 'blocked'))
    return 'blocked';
  if (awaiting.length || tasks.some((t) => t.status === 'awaiting-approval'))
    return 'awaiting-approval';
  // Under a stand-down order (the unit's own, or everything).
  if (halted) return 'stood-down';
  if (active.some((b) => b.status === 'working')) return 'working';
  if (bots.length && !active.length) return 'stood-down';
  return 'idle';
}

/**
 * Everything in a unit that needs the Commander: the plain items (backbriefs, blocks,
 * failures, deploys) plus escalations, budget warnings and disputes to rule on. An
 * escalation or a dispute replaces the plain item for the same task: it says more.
 */
function unitAttention(
  u: RecordVersion<UnitBody>,
  items: AttentionItem[],
  open: RecordEvent<'escalation'>[],
  budget: BudgetView,
  referred: RecordVersion<DisputeBody>[],
  units: RecordVersion<UnitBody>[],
): AttentionItem[] {
  const disputed = new Set(referred.map((d) => d.body.taskId));
  return [
    ...withEscalations(
      items.filter(
        (i) =>
          !(i.kind === 'blocked-bot' && [...disputed].some((t) => i.link.endsWith(`/tasks/${t}`))),
      ),
      open,
    ),
    ...budgetAttention(u.body.name, `/units/${u.entityId}`, u.entityId, budget),
    ...referred.map((d): AttentionItem => {
      const against = units.find((x) => x.entityId === d.body.againstUnitId)?.body.name ?? '?';
      return {
        kind: 'dispute',
        label: `Dispute to rule on: ${u.body.name} v ${against} — ${d.body.claim}`,
        title: `Dispute with ${against}`,
        detail: `Rule on it: ${brief(d.body.claim)}`,
        link: `/disputes#dispute-${d.entityId}`,
        entityId: d.entityId,
      };
    }),
  ];
}

/**
 * Escalations that reached the Commander, in place of the plain failure item for the same
 * task (the escalation says more: what the Overseer and HQ already did).
 */
function withEscalations(
  items: AttentionItem[],
  open: RecordEvent<'escalation'>[],
): AttentionItem[] {
  const escalated = new Set(open.map((e) => e.taskId).filter(Boolean));
  return [
    ...open.map((e): AttentionItem => ({
      kind: 'escalation',
      label: `Escalated to you: ${e.body.text}`,
      title: `Escalation · ${e.body.cause.replace(/-/g, ' ')}`,
      detail: brief(e.body.text),
      link: e.taskId
        ? taskLink(e.unitId!, e.botId, e.taskId)
        : e.botId
          ? botLink(e.unitId!, e.botId)
          : `/units/${e.unitId}`,
      entityId: e.taskId ?? e.botId ?? e.body.chainId,
      action: 'acknowledge',
      chainId: e.body.chainId,
    })),
    ...items.filter((i) => !(i.kind === 'failed-task' && escalated.has(i.entityId))),
  ];
}

function attentionFor(
  unitId: string,
  bots: BotView[],
  tasks: TaskView[],
  backbriefs: BackbriefView[],
  ctx: AttentionContext,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const opOf = (missionId: string | null) => {
    const m = missionId ? ctx.missions.find((x) => x.id === missionId) : null;
    return m?.operationId ? ctx.operations.get(m.operationId) : null;
  };
  for (const bb of backbriefs) {
    const op = opOf(bb.missionId);
    items.push({
      kind: 'awaiting-approval',
      label: `Backbrief awaiting approval: ${bb.mission.goal}`,
      title: `Backbrief${op ? ` · Operation ${op}` : ''}`,
      detail: `Approve the plan: ${brief(bb.mission.goal)}`,
      link: `/approvals#backbrief-${bb.id}`,
      entityId: bb.id,
    });
  }
  // A blocked task no longer holds its bot (the bot moves on), so the item is the task's.
  for (const t of tasks.filter((t) => t.status === 'blocked')) {
    const b = bots.find((x) => x.id === t.botId);
    items.push({
      kind: 'blocked-bot',
      label: `${b?.callsign ?? 'Unassigned'} blocked on #${t.number}: ${t.statusReason ?? 'no reason given'}`,
      title: taskHeading(t, ctx),
      detail: `Blocked: ${brief(t.statusReason) || 'no reason given'}`,
      ...(t.statusAction ? { next: t.statusAction } : {}),
      link: taskLink(unitId, t.botId, t.id),
      entityId: t.id,
    });
  }
  for (const b of bots.filter((b) => b.status === 'blocked' && !b.currentTaskId)) {
    items.push({
      kind: 'blocked-bot',
      label: `${b.callsign} is blocked`,
      title: `Bot ${b.callsign}`,
      detail: 'Blocked with no task in hand',
      link: botLink(unitId, b.id),
      entityId: b.id,
    });
  }
  for (const t of tasks.filter((t) => t.status === 'failed')) {
    items.push({
      kind: 'failed-task',
      label: `Task #${t.number} failed: ${t.statusReason ?? t.title}`,
      title: taskHeading(t, ctx),
      detail: `Failed: ${brief(t.statusReason) || brief(t.title)}`,
      ...(t.statusAction ? { next: t.statusAction } : {}),
      link: taskLink(unitId, t.botId, t.id),
      entityId: t.id,
    });
  }
  for (const t of tasks.filter((t) => t.status === 'awaiting-approval')) {
    const permission = t.permission?.status === 'pending' ? t.permission : null;
    const deploy = !permission && t.kind === 'deploy';
    const bot = bots.find((b) => b.id === t.botId)?.callsign ?? 'A bot';
    items.push({
      kind: 'awaiting-approval',
      label: permission
        ? `${bot} asks permission on #${t.number}: ${permission.action}`
        : deploy
          ? `Production deploy awaiting approval: #${t.number} ${t.title}`
          : `Task #${t.number} awaiting approval`,
      title: taskHeading(t, ctx),
      detail: permission
        ? `${bot} asks permission: ${brief(permission.action)}`
        : deploy
          ? `Approve the production deploy: ${brief(t.title)}`
          : 'Awaiting your approval',
      link: taskLink(unitId, t.botId, t.id),
      entityId: t.id,
      ...(permission ? { action: 'decide-permission' as const, permission } : {}),
      ...(deploy ? { action: 'approve-deploy' as const } : {}),
    });
  }
  return items;
}
